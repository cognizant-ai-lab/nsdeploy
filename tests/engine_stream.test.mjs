// The Engine's streamed turns on neuro-san's agent loop: the turn's lifecycle events,
// steering the top front man while it runs, and consent only where a call leaves the
// site. Only HTTP is faked: the site's manifest and networks, the LLM router (OpenAI's
// Responses API, as neuro-san calls it) and the MCP servers.
//
//   npm run build --prefix runtime-build   # build the runtime first
//   node --test tests/engine_stream.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../nsdeploy/runtime/ts-package/engine.js";

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
  const calls = item.calls || (item.call ? [item.call] : []);
  const outputs = calls.length
    ? calls.map((call, i) => ({ type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, status: "completed", ...call }))
    : [{ type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: item.text, annotations: [] }] }];
  const result = { id: `resp_${n}`, object: "response", created_at: 0, status: "completed", model: body.model, output: outputs, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  if (!body.stream) return json(result);
  // Streamed, as the response.* events OpenAI sends, with the text in two pieces.
  const events = [];
  const event = (type, fields) => events.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: events.length, ...fields })}\n\n`);
  event("response.created", { response: { ...result, status: "in_progress", output: [] } });
  outputs.forEach((output, index) => {
    if (output.type === "function_call") {
      event("response.output_item.added", { output_index: index, item: { ...output, status: "in_progress", arguments: "" } });
      event("response.function_call_arguments.delta", { item_id: output.id, output_index: index, delta: output.arguments });
      event("response.function_call_arguments.done", { item_id: output.id, output_index: index, arguments: output.arguments });
    } else {
      const part = { type: "output_text", text: "", annotations: [] };
      const half = Math.ceil(item.text.length / 2);
      event("response.output_item.added", { output_index: index, item: { ...output, status: "in_progress", content: [] } });
      event("response.content_part.added", { item_id: output.id, output_index: index, content_index: 0, part });
      for (const delta of [item.text.slice(0, half), item.text.slice(half)]) {
        event("response.output_text.delta", { item_id: output.id, output_index: index, content_index: 0, delta });
      }
      event("response.output_text.done", { item_id: output.id, output_index: index, content_index: 0, text: item.text });
      event("response.content_part.done", { item_id: output.id, output_index: index, content_index: 0, part: { ...part, text: item.text } });
    }
    event("response.output_item.done", { output_index: index, item: output });
  });
  event("response.completed", { response: result });
  return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
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
    // The answer's text arrives as it streams: the front man's for the user, and a
    // downstream agent's for developers only.
    const deltas = events.filter((event) => event.type === "agent.output.delta");
    assert.deepEqual(deltas.map((event) => [event.source?.agent, event.visibility, event.delta]), [
      ["helper", "developer", "the helpe"],
      ["helper", "developer", "r says 42"],
      ["front", "user", "front h"],
      ["front", "user", "eard 42"],
    ]);
    const kinds = events.filter((event) => event.type !== "agent.output.delta")
      .map((event) => [event.type, event.source?.agent ?? event.tool?.name ?? ""]);
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

test("model calls stream when the network's llm_config has fallbacks, as Cailville's do", async () => {
  const llm_config = { model_name: "gpt-5.2", fallbacks: [{ class: "openai", model_name: "gpt-5.2" }, { model_name: "claude-sonnet" }] };
  const networks = { main: { llm_config, tools: [agent("front")] } };
  const streamed = [];
  const reply = (_name, body) => {
    streamed.push(body.stream === true);
    return { text: "hello" };
  };
  await withFetch(siteFetch({ networks, reply }), async () => {
    const events = await collect(new Engine({ originUrl: SITE }).streamTurn("Hi"));
    assert.deepEqual(streamed, [true]);
    assert.deepEqual(events.filter((event) => event.type === "agent.output.delta").map((event) => event.delta), ["hel", "lo"]);
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

test("an MCP server's progress and log notifications show while its tool runs", async () => {
  const calls = [];
  const plain = mcpServer("inventory_search", calls);
  // tools/call answers as an event stream, with two notifications ahead of the result.
  const streaming = async (pathname, init) => {
    const message = init.method === "POST" ? JSON.parse(init.body) : null;
    if (message?.method !== "tools/call") return plain(pathname, init);
    calls.push(message.params.name);
    const events = [
      { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 0.5, message: "Halfway through the inventory" } },
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "Search successful" } },
      { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "3 minivans" }] } },
    ];
    return new Response(events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } });
  };
  const networks = { main: { tools: [agent("front", [`${SITE}/_mcp/0/mcp`])] } };
  const reply = (_name, body) => toolOutputs(body).length
    ? { text: "There are 3 minivans." }
    : { call: { name: "inventory_search", arguments: JSON.stringify({ inquiry: "minivans" }) } };
  // A site lists its own origin in allowed_peers, as nsdeploy publishes it.
  const manifest = { allowed_peers: [SITE] };
  const routes = { [SITE]: (pathname, init) => (pathname.startsWith("/_mcp/") ? streaming(pathname, init) : null) };
  await withFetch(siteFetch({ networks, manifest, reply, routes }), async () => {
    const engine = new Engine({ originUrl: SITE });
    const events = await collect(engine.streamTurn("Any minivans?"));

    assert.deepEqual(calls, ["inventory_search"]);
    assert.equal(events.at(-1).result.text, "There are 3 minivans.");
    const progress = events.filter((event) => event.type === "tool.progress");
    assert.deepEqual(progress.map((event) => [event.tool.name, event.tool.kind, event.message]), [
      ["inventory_search", "MCP", "Halfway through the inventory"],
      ["inventory_search", "MCP", "Search successful"],
    ]);
    // Both come between the tool's start and its end.
    const at = (type) => events.findIndex((event) => event.type === type);
    assert.ok(at("tool.started") < events.indexOf(progress[0]) && events.indexOf(progress[1]) < at("tool.completed"));
  });
});

// Several tool calls in one model response, as `reply` answers: all of `names` at once.
const callAll = (names) => (body) => (toolOutputs(body).length
  ? { text: `got ${toolOutputs(body).map((item) => item.output).join(", ")}` }
  : { calls: names.map((name) => ({ name, arguments: JSON.stringify({ inquiry: name }) })) });

test("sibling tool calls run at most four at a time, and in order when one isn't parallel safe", async () => {
  // Six MCP tools that each take a while, called all at once.
  const tools = ["t1", "t2", "t3", "t4", "t5", "t6"];
  let active = 0;
  let most = 0;
  const started = [];
  const slowMcp = async (pathname, init) => {
    if (!pathname.startsWith("/_mcp/")) return null;
    if (init.method !== "POST") return new Response("", { status: 405 });
    const message = JSON.parse(init.body);
    const answer = (result) => json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") return answer({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } });
    if (message.method === "tools/list") return answer({ tools: tools.map((name) => ({ name, description: name, inputSchema: INQUIRY })) });
    if (message.method !== "tools/call") return new Response(null, { status: 202 });
    started.push(message.params.name);
    active += 1;
    most = Math.max(most, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return answer({ content: [{ type: "text", text: `${message.params.name} done` }] });
  };
  const manifest = { allowed_peers: [SITE] };
  const mcpNetworks = { main: { tools: [agent("front", [`${SITE}/_mcp/0/mcp`])] } };
  const front = callAll(tools);
  await withFetch(siteFetch({ networks: mcpNetworks, manifest, reply: (_name, body) => front(body), routes: { [SITE]: slowMcp } }), async () => {
    const events = await collect(new Engine({ originUrl: SITE }).streamTurn("Run all six"));
    assert.equal(most, 4);
    assert.deepEqual(started.sort(), tools);
    // The model gets the results in the order it asked for them.
    assert.equal(events.at(-1).result.text, `got ${tools.map((name) => `${name} done`).join(", ")}`);
  });

  // An agent that isn't safe to run alongside others: the batch runs one at a time.
  const order = [];
  const networks = {
    main: { tools: [agent("front", ["first", "careful", "last"]), agent("first", [], INQUIRY), { ...agent("careful", [], INQUIRY), parallel_safe: false }, agent("last", [], INQUIRY)] },
  };
  const serial = callAll(["first", "careful", "last"]);
  const reply = async (name, body) => {
    if (name === "front") return serial(body);
    order.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(`end ${name}`);
    return { text: `${name} done` };
  };
  await withFetch(siteFetch({ networks, reply }), async () => {
    await collect(new Engine({ originUrl: SITE }).streamTurn("Run them in order"));
    assert.deepEqual(order, ["start first", "end first", "start careful", "end careful", "start last", "end last"]);
  });
});

test("each tool call shows under the agent that made it, when two agents call tools at once", async () => {
  // A slow MCP tool, so both agents' calls are running at the same time.
  const calls = [];
  const plain = mcpServer("lookup", calls);
  const slow = async (pathname, init) => {
    if (!pathname.startsWith("/_mcp/")) return null;
    if (init.method === "POST" && JSON.parse(init.body).method === "tools/call") await new Promise((resolve) => setTimeout(resolve, 30));
    return plain(pathname, init);
  };
  const mcp = `${SITE}/_mcp/0/mcp`;
  const networks = {
    main: { tools: [agent("front", ["scout", "planner"]), agent("scout", [mcp], INQUIRY), agent("planner", [mcp], INQUIRY)] },
    other_network: { tools: [agent("other_front")] },
  };
  const reply = (name, body) => {
    if (toolOutputs(body).length) return { text: `${name} done` };
    if (name === "front") return callAll(["scout", "planner"])(body);
    if (name === "scout" || name === "planner") return { call: { name: "lookup", arguments: JSON.stringify({ inquiry: name }) } };
    return { text: `${name} answer` };
  };
  const manifest = { allowed_peers: [SITE] };
  await withFetch(siteFetch({ networks, manifest, reply, routes: { [SITE]: slow } }), async () => {
    const events = await collect(new Engine({ originUrl: SITE }).streamTurn("Plan it"));
    assert.deepEqual(calls, ["lookup", "lookup"]);
    const mcpStarts = events.filter((event) => event.type === "tool.started" && event.tool.kind === "MCP");
    assert.deepEqual(mcpStarts.map((event) => event.source?.agent).sort(), ["planner", "scout"]);
  });

  // The same for partner networks: each agent calls its own one, at the same time.
  const peerNetworks = {
    main: { tools: [agent("front", ["scout", "planner"]), agent("scout", [`${SITE}/inn`], INQUIRY), agent("planner", [`${SITE}/farm`], INQUIRY)] },
    inn: { tools: [agent("inn_front")] },
    farm: { tools: [agent("farm_front")] },
  };
  const peerReply = (name, body) => {
    if (toolOutputs(body).length || name.endsWith("_front")) return { text: `${name} done` };
    if (name === "front") return callAll(["scout", "planner"])(body);
    return { call: { name: body.tools[0].name, arguments: JSON.stringify({ inquiry: name }) } };
  };
  await withFetch(siteFetch({ networks: peerNetworks, manifest, reply: peerReply }), async () => {
    const events = await collect(new Engine({ originUrl: SITE }).streamTurn("Plan it"));
    const peerStarts = events.filter((event) => event.type === "tool.started" && event.tool.kind === "remote network");
    assert.deepEqual(peerStarts.map((event) => [event.source?.agent, event.tool.name]).sort(), [["planner", "farm"], ["scout", "inn"]]);
  });
});

test("consent is asked only for calls that leave the site", async () => {
  const mcpCalls = [];
  const siteMcp = mcpServer("local_tool", mcpCalls);
  const proxyMcp = mcpServer("proxy_tool", mcpCalls);
  const networks = {
    main: { tools: [agent("front", [`${SITE}/_mcp/0/mcp`, `${SITE}/ext-mcp/0/mcp`, `${TOOLS}/mcp`, `${SITE}/other_network`, `${PEER}/peer_network`])] },
    other_network: { tools: [agent("other_front")] },
  };
  // The front man calls every tool at once, so their consent questions come together.
  const reply = (name, body) => {
    if (name !== "front") return { text: `${name} answer` };
    if (toolOutputs(body).length) return { text: "front done" };
    return { calls: (body.tools || []).map((tool) => ({ name: tool.name, arguments: JSON.stringify({ inquiry: "q" }) })) };
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
    let open = 0;
    let mostOpen = 0;
    engine.onConsent = async (info) => {
      approvals.push([info.kind, info.phase ?? "", info.peerOrigin]);
      open += 1;
      mostOpen = Math.max(mostOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 10));
      open -= 1;
      return "allow";
    };
    const events = await collect(engine.streamTurn("Use every service"));

    assert.equal(events.at(-1).result.text, "front done");
    // Tools discovered and called at the same time still ask one question at a time.
    assert.equal(mostOpen, 1);
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
