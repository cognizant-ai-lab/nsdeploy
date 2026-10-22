// The Engine's streamed turns on neuro-san's agent loop: the turn's lifecycle events,
// steering the top front man while it runs, and consent only where a call leaves the
// site. Only HTTP is faked: the site's manifest and networks, the LLM router (OpenAI's
// Responses API, as neuro-san calls it) and the MCP servers.
//
//   npm run build --prefix runtime-build   # build the runtime first
//   node --test tests/engine_stream.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../nsdeploy/runtime/engine.js";

const SITE = "https://site.test";
const PEER = "https://peer.test";
const TOOLS = "https://tools.test";

const agent = (name, tools = [], parameters = undefined) => ({
  name, instructions: `AGENT=${name}`, function: { description: name, ...(parameters ? { parameters } : {}) }, tools,
});
const INQUIRY = { type: "object", properties: { inquiry: { type: "string" } }, required: ["inquiry"] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

// What an agent's model call says, as the Responses API answers it. `reply` gets the
// agent's name and the call's input, and returns { text } or { call: { name, arguments } }.
let answers = 0;
function responsesAnswer(body, item) {
  const n = ++answers;
  const output = [item.call
    ? { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, status: "completed", ...item.call }
    : { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: item.text, annotations: [] }] }];
  return json({ id: `resp_${n}`, object: "response", created_at: 0, status: "completed", model: body.model, output, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
}

const agentOf = (body) => (JSON.stringify((body.input || []).filter((item) => item.role === "system")).match(/AGENT=(\w+)/) || [])[1];
const userTexts = (body) => (body.input || []).filter((item) => item.role === "user").map((item) => String(item.content));
const toolOutputs = (body) => (body.input || []).filter((item) => item.type === "function_call_output");

// A fetch for one site whose networks are in `networks`, plus `routes` for anything else.
function siteFetch({ networks, manifest = {}, reply, routes = {} }) {
  return async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const { origin, pathname } = new URL(url);
    if (routes[origin]) {
      const answered = await routes[origin](pathname, init);
      if (answered) return answered;
    }
    if (origin !== SITE) return new Response("", { status: 404 });
    if (pathname === "/agent-manifest.json") {
      return json({
        networks: Object.keys(networks).map((name) => ({ name, hocon: `/${name}.hocon` })),
        llm_router: { base_url: `${SITE}/v1`, mock: true },
        ...manifest,
      });
    }
    const network = pathname.match(/^\/(\w+)\.hocon$/)?.[1];
    if (network && networks[network]) return json(networks[network]);
    if (pathname === "/v1/responses") {
      const body = JSON.parse(init.body);
      return responsesAnswer(body, await reply(agentOf(body), body, init));
    }
    return new Response("", { status: 404 });
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("a streamed turn reports each agent and tool call, then the answer", async () => {
  const networks = { main: { tools: [agent("front", ["helper"]), agent("helper", [], INQUIRY)] } };
  const reply = (name, body) => {
    if (name === "helper") return { text: "the helper says 42" };
    if (!toolOutputs(body).length) return { call: { name: "helper", arguments: JSON.stringify({ inquiry: "the answer" }) } };
    return { text: "front heard 42" };
  };
  await withFetch(siteFetch({ networks, reply }), async () => {
    const engine = new Engine({ originUrl: SITE });
    const events = await collect(engine.streamTurn("What is the answer?"));
    const kinds = events.map((event) => [event.type, event.source?.agent ?? event.tool?.name ?? ""]);
    assert.deepEqual(kinds, [
      ["turn.started", ""],
      ["agent.started", "front"],
      ["tool.started", "front"],
      ["agent.started", "helper"],
      ["agent.completed", "helper"],
      ["tool.completed", "front"],
      ["agent.completed", "front"],
      ["turn.completed", ""],
    ]);
    assert.deepEqual(events.find((event) => event.type === "tool.started").tool, { name: "helper", callId: events.find((event) => event.type === "tool.started").tool.callId, kind: "agent" });
    assert.equal(events.at(-1).result.text, "front heard 42");
  });
});

test("steering cancels the front man's running model call and makes it again with the guidance", async () => {
  const networks = { main: { tools: [agent("front")] } };
  const calls = [];
  let started;
  const firstCall = new Promise((resolve) => { started = resolve; });
  const reply = async (_name, body, init) => {
    calls.push(userTexts(body));
    if (!userTexts(body).includes("Make Friday the priority")) {
      started();
      // Holds until the steering cancels it.
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }
    return { text: "Friday is now the priority." };
  };
  await withFetch(siteFetch({ networks, reply }), async () => {
    const engine = new Engine({ originUrl: SITE });
    const stream = engine.streamTurn("Find a day next week");
    const collecting = collect(stream);
    await firstCall;
    assert.equal(stream.steer("Make Friday the priority"), true);
    const events = await collecting;

    assert.equal(events.at(-1).result.text, "Friday is now the priority.");
    assert.ok(events.some((event) => event.type === "turn.steering.received"));
    assert.ok(events.some((event) => event.type === "turn.steering.applied"));
    assert.deepEqual(calls, [["Find a day next week"], ["Find a day next week", "Make Friday the priority"]]);
    assert.equal(stream.steer("Too late"), false);
    // The next turn's history has the guidance right after the question it steered.
    const front = engine.chatContext.chat_histories.find((history) => history.origin.length === 1);
    assert.deepEqual(front.messages.slice(0, 2).map((message) => message.text), ["Find a day next week", "Make Friday the priority"]);
  });
});

test("steering waits for work already handed to another agent instead of running it again", async () => {
  const networks = { main: { tools: [agent("front", ["child"]), agent("child", [], INQUIRY)] } };
  const calls = [];
  let childStarted;
  let releaseChild;
  const started = new Promise((resolve) => { childStarted = resolve; });
  const gate = new Promise((resolve) => { releaseChild = resolve; });
  const reply = async (name, body) => {
    calls.push(name);
    if (name === "child") {
      childStarted();
      await gate;
      return { text: "Monday or Friday." };
    }
    if (!toolOutputs(body).length) return { call: { name: "child", arguments: JSON.stringify({ inquiry: "Find a day" }) } };
    assert.ok(userTexts(body).includes("Prefer Friday"));
    return { text: "Friday is the best match." };
  };
  await withFetch(siteFetch({ networks, reply }), async () => {
    const engine = new Engine({ originUrl: SITE });
    const stream = engine.streamTurn("Find a day next week");
    const collecting = collect(stream);
    await started;
    assert.equal(stream.steer("Prefer Friday"), true);
    releaseChild();
    const events = await collecting;

    assert.equal(events.at(-1).result.text, "Friday is the best match.");
    assert.deepEqual(calls, ["front", "child", "front"]);
    const received = events.findIndex((event) => event.type === "turn.steering.received");
    assert.ok(received < events.findIndex((event) => event.type === "tool.completed"));
  });
});

// An MCP server with one tool, answering MCP's streamable HTTP transport in plain JSON.
function mcpServer(tool, calls) {
  return async (pathname, init) => {
    if (!pathname.endsWith("/mcp")) return null;
    if (init.method !== "POST") return new Response("", { status: 405 });
    const message = JSON.parse(init.body);
    const answer = (result) => json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      return answer({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } });
    }
    if (message.method === "tools/list") return answer({ tools: [{ name: tool, description: tool, inputSchema: INQUIRY }] });
    if (message.method === "tools/call") {
      calls.push(message.params.name);
      return answer({ content: [{ type: "text", text: `${tool} result` }] });
    }
    return new Response(null, { status: 202 });
  };
}

test("consent is asked only for calls that leave the site", async () => {
  const mcpCalls = [];
  const siteMcp = mcpServer("local_tool", mcpCalls);
  const proxyMcp = mcpServer("proxy_tool", mcpCalls);
  const networks = {
    main: { tools: [agent("front", [`${SITE}/_mcp/0/mcp`, `${SITE}/ext-mcp/0/mcp`, `${TOOLS}/mcp`, `${SITE}/other_network`, `${PEER}/peer_network`])] },
    other_network: { tools: [agent("other_front")] },
  };
  const reply = (name, body) => {
    if (name !== "front") return { text: `${name} answer` };
    const called = new Set((body.input || []).filter((item) => item.type === "function_call").map((item) => item.name));
    const next = (body.tools || []).find((tool) => !called.has(tool.name));
    if (!next) return { text: "front done" };
    return { call: { name: next.name, arguments: JSON.stringify({ inquiry: "q" }) } };
  };
  const routes = {
    // The site's own MCP host and its proxy to an outside one share the site's origin.
    [SITE]: (pathname, init) => (pathname.startsWith("/_mcp/") ? siteMcp : pathname.startsWith("/ext-mcp/") ? proxyMcp : () => null)(pathname, init),
    [TOOLS]: mcpServer("remote_tool", mcpCalls),
    [PEER]: (pathname) => {
      if (pathname === "/agent-manifest.json") return json({ networks: [{ name: "peer_network", hocon: "/peer_network.hocon" }] });
      if (pathname === "/peer_network.hocon") return json({ tools: [agent("peer_front")] });
      return null;
    },
  };
  const manifest = { allowed_peers: [SITE, TOOLS, PEER] };
  await withFetch(siteFetch({ networks, manifest, reply, routes }), async () => {
    const engine = new Engine({ originUrl: SITE });
    const approvals = [];
    engine.onConsent = async (info) => { approvals.push([info.kind, info.phase ?? "", info.peerOrigin]); return "allow"; };
    const events = await collect(engine.streamTurn("Use every service"));

    assert.equal(events.at(-1).result.text, "front done");
    assert.deepEqual(mcpCalls.sort(), ["local_tool", "proxy_tool", "remote_tool"]);
    assert.deepEqual(approvals.sort(), [
      ["mcp", "call", "site.test"],
      ["mcp", "call", "tools.test"],
      ["mcp", "discover", "site.test"],
      ["mcp", "discover", "tools.test"],
      ["network", "", "peer.test"],
    ]);
    const kinds = events.filter((event) => event.type === "tool.started").map((event) => event.tool.kind).sort();
    assert.deepEqual(kinds, ["MCP", "MCP", "MCP", "remote network", "remote network"]);
  });
});
