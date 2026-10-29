import assert from "node:assert/strict";

import { Engine, isPublishedMockRouter, manifestAllowsPeer, selectPeerRouter, selectTopRouter } from "../nsdeploy/runtime/engine.js";
import { AgentNetwork } from "../nsdeploy/runtime/kernel.js";
import { RemoteRegistry } from "../nsdeploy/runtime/remote.js";
import { LlmClient, browserMockCompletion, isMockResponse } from "../nsdeploy/runtime/llm.js";
import { McpClient, parseMaybeSse, readJsonRpcResponse } from "../nsdeploy/runtime/mcp.js";
import { normalizeModelName } from "../nsdeploy/runtime/model.js";
import { createTurnEventStream } from "../nsdeploy/runtime/execution-stream.js";
import { TraceBus } from "../nsdeploy/runtime/trace.js";
import { createTurnStatusController, statusTextForEvent } from "../nsdeploy/runtime/turn-status.js";
import {
  buildToolTable,
  consumeAgentBudget,
  consumeRemoteBudget,
  dispatchToolCall,
  executeToolCalls,
  remoteIsInChain,
  requiresThirdPartyApproval,
} from "../nsdeploy/runtime/runner.js";

const manifest = {
  llm_router: {
    base_url: "http://127.0.0.1:8091/v1",
    byok_router: "http://127.0.0.1:8091/byok/v1",
    mock: true,
  },
};
assert.deepEqual(
  selectTopRouter(manifest, "http://127.0.0.1:8091/v1", "real-key"),
  { baseUrl: "http://127.0.0.1:8091/byok/v1", mock: false, upgradedToByok: true },
);
assert.equal(selectTopRouter(manifest, "", "").mock, true);
assert.deepEqual(
  selectTopRouter(manifest, "http://127.0.0.1:8091/v1", "demo", "gpt-4o"),
  { baseUrl: "http://127.0.0.1:8091/byok/v1", mock: false, upgradedToByok: true },
);
assert.equal(selectTopRouter(manifest, "http://localhost:8091/v1", "", "").mock, true);
assert.equal(isMockResponse(false, "byok", "model.gguf"), false);
assert.equal(isMockResponse(false, "mock", ""), true);
assert.equal(isMockResponse(false, "byok", "neuro-san-mock"), true);
assert.equal(normalizeModelName('\"gpt-5.6\"'), "gpt-5.6");
assert.equal(normalizeModelName("'gpt-4o'"), "gpt-4o");
assert.equal(normalizeModelName('  \"qwen/model:id\"  '), "qwen/model:id");
assert.equal(normalizeModelName("plain-model"), "plain-model");
{
  const tools = [{type: "function", function: {
    name: "lookup", parameters: {type: "object", properties: {request: {type: "string"}}, required: ["request"]},
  }}];
  const first = browserMockCompletion([{role: "user", content: "find it"}], tools);
  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.toolCalls[0].function.name, "lookup");
  assert.deepEqual(JSON.parse(first.toolCalls[0].function.arguments), {request: "find it"});
  const second = browserMockCompletion([
    {role: "user", content: "find it"},
    {role: "tool", name: "lookup", content: "found"},
  ], tools);
  assert.equal(second.finishReason, "stop");
  assert.match(second.content, /found/);

  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("browser mock must not fetch"); };
  try {
    const client = new LlmClient({baseUrl: "browser://mock", apiKey: "demo", mock: true});
    const result = await client.chat({model: "mock-1", messages: [{role: "user", content: "hello"}], tools: []});
    assert.equal(result.model, "neuro-san-mock-browser");
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
{
  const originalFetch = globalThis.fetch;
  const jsonResponse = (body, ok = true) => ({ok, json: async () => body, text: async () => JSON.stringify(body)});
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/agent-manifest.json")) return jsonResponse({
      networks: [{name: "portable", hocon: "./portable.network.json"}],
      llm_router: {base_url: "browser://mock", byok_router: "https://api.example/v1", mock: true},
      peer_policy: {mode: "open"}, deployment: {mode: "static"},
    });
    if (href.endsWith("/portable.network.json") || href.endsWith("/./portable.network.json")) {
      return {ok: true, text: async () => JSON.stringify({tools: [{name: "front", instructions: "Help."}]})};
    }
    if (href.endsWith("/links.json")) return jsonResponse({}, false);
    throw new Error(`unexpected static-bundle fetch: ${href}`);
  };
  try {
    const engine = new Engine({originUrl: "https://static.example", byokKey: "demo"});
    await engine.loadTop();
    const answer = await engine.run("hello");
    assert.match(answer, /mock/);
    assert.equal(engine.top.llm.baseUrl, "browser://mock");
  } finally {
    globalThis.fetch = originalFetch;
  }
}
assert.equal(await isPublishedMockRouter("http://127.0.0.1:8091/v1", async () => ({
  ok: true,
  json: async () => ({llm_router: {
    base_url: "http://localhost:8091/v1", mock: true,
  }}),
})), true);
assert.equal(await isPublishedMockRouter("http://127.0.0.1:8091/byok/v1", async () => ({
  ok: true,
  json: async () => ({llm_router: {
    base_url: "http://127.0.0.1:8091/v1", mock: true,
  }}),
})), false);
assert.equal(selectTopRouter(manifest, "https://api.openai.com/v1", "real-key").mock, false);
assert.deepEqual(
  selectPeerRouter({ baseUrl: "http://127.0.0.1:8095/v1", mock: true }),
  { baseUrl: "http://127.0.0.1:8095/v1", mock: true },
);
assert.throws(() => selectPeerRouter(null), /caller has no active LLM router/i);

// The consumer projection is one replaceable status line, not a growing event
// list. It hides on turn completion or as soon as a final answer is shown.
{
  const shown = [];
  let hidden = 0;
  const status = createTurnStatusController({
    show: (text, event) => shown.push([text, event.type]),
    hide: () => { hidden += 1; },
  });
  status.handle({ type: "turn.started" });
  status.handle({ type: "turn.steering.received" });
  assert.deepEqual(shown.at(-1), ["Update received; adjusting the plan…", "turn.steering.received"]);
  status.handle({ type: "tool.started", tool: { name: "inventory_search", kind: "MCP" } });
  status.handle({ type: "tool.progress", tool: { name: "inventory_search" }, message: "Halfway through the inventory check" });
  assert.equal(status.visible, true);
  assert.deepEqual(shown.at(-1), ["Halfway through the inventory check", "tool.progress"]);
  assert.equal(statusTextForEvent({ type: "tool.completed", tool: { name: "inventory_search" } }), "Inventory Search finished; reviewing the result…");
  status.handle({ type: "turn.completed" });
  assert.equal(status.visible, false);
  assert.equal(hidden, 1);
  status.handle({ type: "turn.started" });
  status.finalAnswerStarted();
  assert.equal(hidden, 2);
}

// Concurrent stream consumers only receive the trace subtree for their own turn.
{
  const trace = new TraceBus();
  const fakeTurn = (token, input, delay) => createTurnEventStream(trace, async () => {
    const span = trace.start("run", { streamToken: token, input });
    await new Promise((resolve) => setTimeout(resolve, delay));
    trace.end(span);
    return { turnId: span, text: input };
  }, token);
  const collect = async (stream) => {
    const events = [];
    for await (const event of stream) events.push(event);
    return events;
  };
  const [first, second] = await Promise.all([
    collect(fakeTurn("stream-a", "alpha", 15)),
    collect(fakeTurn("stream-b", "beta", 2)),
  ]);
  assert.deepEqual(first.filter((event) => event.type === "turn.started").map((event) => event.input), ["alpha"]);
  assert.deepEqual(second.filter((event) => event.type === "turn.started").map((event) => event.input), ["beta"]);
  assert.equal(first.at(-1).result.text, "alpha");
  assert.equal(second.at(-1).result.text, "beta");
}

const topManifest = { allowed_peers: ["http://127.0.0.1:8092"] };
const peerManifest = { allowed_peers: ["http://127.0.0.1:8097"] };
assert.equal(manifestAllowsPeer("http://127.0.0.1:8092/network", topManifest), true);
assert.equal(manifestAllowsPeer("http://127.0.0.1:8097/network", topManifest), false);
assert.equal(manifestAllowsPeer("http://127.0.0.1:8097/network", peerManifest), true);
assert.equal(manifestAllowsPeer("https://public.example/agent", {peer_policy: {mode: "open"}}), true);
assert.equal(manifestAllowsPeer("https://blocked.example/agent", {
  peer_policy: {mode: "open", deny_origins: ["https://blocked.example"]},
}), false);

const urlToolNetwork = new AgentNetwork({tools: [{
  name: "commercial_sales_manager",
  instructions: "Coordinate farm sales.",
  tools: ["http://127.0.0.1:8093/seabreeze_inn", "https://tools.example/mcp"],
}]}, "greenbank_farm");
assert.equal(urlToolNetwork.classifyTool("http://127.0.0.1:8093/seabreeze_inn").kind, "remote");
assert.equal(urlToolNetwork.classifyTool("https://tools.example/mcp").kind, "mcp");

// Consent follows the actual site boundary. A page's own MCP/service network is
// local, while /ext-mcp remains gated because it proxies an external MCP server.
assert.equal(requiresThirdPartyApproval("https://site.example/_mcp/0/mcp", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("/mcp", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("https://site.example/ext-mcp/0/mcp", "https://site.example"), true);
assert.equal(requiresThirdPartyApproval("https://tools.example/mcp", "https://site.example"), true);
assert.equal(requiresThirdPartyApproval("https://site.example/other_network", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("https://agents.example/other_network", "https://site.example"), true);

{
  const localMcp = "https://site.example/_mcp/0/mcp";
  const proxyMcp = "https://site.example/ext-mcp/0/mcp";
  const remoteMcp = "https://tools.example/mcp";
  const serviceNetwork = new AgentNetwork({tools: [{
    name: "root", instructions: "Use services.", tools: [localMcp, proxyMcp, remoteMcp],
  }]}, "services");
  const approvals = [];
  const calls = [];
  const clients = new Map([
    [localMcp, {url: localMcp, listTools: async () => [{name: "local_tool"}], callTool: async (name) => { calls.push(name); return "local"; }}],
    [proxyMcp, {url: proxyMcp, listTools: async () => [{name: "proxy_tool"}], callTool: async (name) => { calls.push(name); return "proxy"; }}],
    [remoteMcp, {url: remoteMcp, listTools: async () => [{name: "remote_tool"}], callTool: async (name) => { calls.push(name); return "remote"; }}],
  ]);
  const ctx = {
    network: serviceNetwork,
    baseOrigin: "https://site.example",
    displayOrigin: "site.example",
    mock: true,
    trace: {note() {}},
    requestConsent: async (info) => { approvals.push(info); return "allow"; },
    resolveMcp: async (ref) => clients.get(ref),
  };
  const table = await buildToolTable(ctx, serviceNetwork.getAgentSpec("root"), [], "parent");
  assert.deepEqual(approvals.map(({kind, phase, peerOrigin}) => [kind, phase, peerOrigin]), [
    ["mcp", "discover", "site.example"],
    ["mcp", "discover", "tools.example"],
  ]);
  assert.equal(table.toolByName.get("mcp_local_tool").requiresApproval, false);
  assert.equal(table.toolByName.get("mcp_proxy_tool").requiresApproval, true);

  await dispatchToolCall(ctx, table.toolByName.get("mcp_local_tool"), {request: "local query"}, "parent", []);
  assert.equal(approvals.length, 2);
  await dispatchToolCall(ctx, table.toolByName.get("mcp_proxy_tool"), {request: "proxy query"}, "parent", []);
  await dispatchToolCall(ctx, table.toolByName.get("mcp_remote_tool"), {request: "remote query"}, "parent", []);
  assert.deepEqual(approvals.slice(2).map(({kind, phase}) => [kind, phase]), [["mcp", "call"], ["mcp", "call"]]);
  assert.deepEqual(calls, ["local_tool", "proxy_tool", "remote_tool"]);

  const sameSiteResult = await dispatchToolCall({
    ...ctx,
    composition: null,
    slyData: {},
    frontMan: "root",
    resolveRemote: async () => ({invoke: async () => "same-site network"}),
  }, {kind: "remote", url: "https://site.example/other_network", label: "Other"}, {request: "same site"}, "parent", []);
  assert.equal(sameSiteResult, "same-site network");
  assert.equal(approvals.length, 4);

  const thirdPartyResult = await dispatchToolCall({
    ...ctx,
    composition: null,
    slyData: {},
    frontMan: "root",
    resolveRemote: async () => ({invoke: async () => "third-party network"}),
  }, {kind: "remote", url: "https://agents.example/other_network", label: "Other"}, {request: "third party"}, "parent", []);
  assert.equal(thirdPartyResult, "third-party network");
  assert.equal(approvals.at(-1).kind, "network");
  assert.equal(approvals.length, 5);
}

const chain = [
  "http://127.0.0.1:8095::deneman_place",
  "http://127.0.0.1:8098::neighbor_exchange",
  "http://127.0.0.1:8092::rivera_household",
];
assert.equal(remoteIsInChain("http://127.0.0.1:8092/rivera_household", "http://127.0.0.1:8098", chain), true);
assert.equal(remoteIsInChain("http://127.0.0.1:8095/deneman_place", "http://127.0.0.1:8092", chain), true);
const registry = new RemoteRegistry();
assert.throws(
  () => registry.checkCycle(chain, "http://127.0.0.1:8092", "rivera_household"),
  (error) => error.code === "COMPOSITION_CYCLE",
);

// Sibling calls overlap, complete independently, and still return in the order
// the model requested. A failure is isolated; explicit unsafe calls serialize.
{
  let seq = 0;
  let active = 0;
  let maxActive = 0;
  const completed = [];
  const trace = {
    start: () => `tool-${++seq}`,
    end: (id, fields) => completed.push([id, fields.status || "ok"]),
  };
  const client = {
    url: "https://site.example/mcp",
    callTool: async (name) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, name === "slow" ? 30 : 5));
      active -= 1;
      if (name === "broken") throw new Error("boom");
      return `${name}-result`;
    },
  };
  const ctx = { trace, displayOrigin: "site.example", baseOrigin: "https://site.example", slyData: {} };
  const calls = ["slow", "fast", "broken"].map((name) => ({
    id: `call-${name}`, name, args: {},
    entry: { kind: "mcp", client, mcpName: name, requiresApproval: false },
  }));
  const results = await executeToolCalls(ctx, calls, "agent", []);
  assert.equal(maxActive, 3);
  assert.deepEqual(results.map((result) => result.name), ["slow", "fast", "broken"]);
  assert.deepEqual(results.slice(0, 2).map((result) => result.content), ["slow-result", "fast-result"]);
  assert.match(results[2].content, /boom/);
  assert.ok(completed.some(([, status]) => status === "error"));

  active = 0;
  maxActive = 0;
  await executeToolCalls(ctx, calls.slice(0, 2).map((call, index) => ({
    ...call,
    entry: { ...call.entry, parallelSafe: index !== 0 },
  })), "agent", []);
  assert.equal(maxActive, 1);
}

const budget = {
  remoteCalls: 0, peerCalls: new Map(), maxRemoteCalls: 2,
  maxCallsPerPeer: 1, deadline: 200,
};
assert.equal(consumeRemoteBudget(budget, "peer-a", 100), null);
assert.match(consumeRemoteBudget(budget, "peer-a", 100), /already consulted/);
assert.equal(consumeRemoteBudget(budget, "peer-b", 100), null);
assert.match(consumeRemoteBudget(budget, "peer-c", 100), /per-query limit/);
assert.match(consumeRemoteBudget({...budget, deadline: 50}, "peer-c", 100), /deadline/);
const agentBudget = {agentCalls: 0, maxAgentCalls: 1, deadline: 200};
assert.equal(consumeAgentBudget(agentBudget, 100), null);
assert.match(consumeAgentBudget(agentBudget, 100), /agent invocations/);

// MCP SSE parsing: a server may stream notifications ahead of the JSON-RPC response
// (You.com emits a notifications/message log line before every tools/call result).
// The client must return the response event, not the first event.
const youSse = [
  "event: message",
  'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"Search successful"}}',
  "",
  "event: message",
  'data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hit"}]}}',
  "",
].join("\n");
assert.equal(parseMaybeSse(youSse, 3).result.content[0].text, "hit");
assert.equal(parseMaybeSse(youSse).result.content[0].text, "hit");
assert.equal(parseMaybeSse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 1).result.ok, true);
assert.equal(parseMaybeSse('event: message\ndata: {"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"x"}}', 2).error.code, -1);
assert.throws(
  () => parseMaybeSse('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}', 1),
  /unparseable/,
);
{
  let notify;
  const notificationSeen = new Promise((resolve) => { notify = resolve; });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":0.5,"message":"Halfway"}}\n\n'));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n'));
        controller.close();
      }, 20);
    },
  });
  const response = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  let completedResponse = false;
  const pending = readJsonRpcResponse(response, 7, (notice) => notify(notice)).then((value) => {
    completedResponse = true;
    return value;
  });
  const notice = await notificationSeen;
  assert.equal(notice.params.message, "Halfway");
  assert.equal(completedResponse, false);
  assert.equal((await pending).result.ok, true);
}
{
  const realFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    methods.push(req.method);
    const text = req.method === "tools/call"
      ? youSse.replace('"id":3', `"id":${req.id}`)
      : `event: message\ndata: {"jsonrpc":"2.0","id":${req.id ?? null},"result":{}}\n`;
    return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s1" } });
  };
  try {
    const client = new McpClient({ url: "http://127.0.0.1:8091/ext-mcp/0/mcp" });
    assert.equal(await client.callTool("you-search", { query: "q" }), "hit");
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(client.sessionId, "s1");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// BYOK guard: a real (non-mock) router is never contacted without a visitor-entered
// key. The "demo" sentinel and an empty key are both rejected before any fetch.
{
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error("fetch reached"); };
  try {
    const real = new LlmClient({ baseUrl: "http://router.example/v1", apiKey: "demo", mock: false });
    await assert.rejects(real.chat({ model: "m", messages: [] }), /needs your API key/);
    const empty = new LlmClient({ baseUrl: "http://router.example/v1", apiKey: "", mock: false });
    await assert.rejects(empty.chat({ model: "m", messages: [] }), /needs your API key/);
    assert.equal(fetched, 0);
    const mock = new LlmClient({ baseUrl: "http://127.0.0.1:8091/v1", apiKey: "demo", mock: true });
    await assert.rejects(mock.chat({ model: "m", messages: [] }), /fetch reached/);
    assert.equal(fetched, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Steering aborts an SSE response that has already started, so a provider stream
// cannot linger in the background while the replacement model call begins.
{
  const realFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  try {
    const abort = new AbortController();
    const client = new LlmClient({ baseUrl: "http://router.example/v1", apiKey: "key", mock: false });
    const pending = client.chat({ model: "m", messages: [], signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort(new DOMException("Steered", "AbortError"));
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  // A JavaScript coded tool loads its class from its own `url`, resolved against
  // the declaring HOCON, with spec `args` merged under the LLM's args.
  const invocations = [];
  const approvals = [];
  const ctx = {
    trace: new TraceBus(),
    baseOrigin: "https://site.example",
    displayOrigin: "site.example",
    codedToolBase: "https://site.example/net.network.json",
    codedToolBundleUrl: "https://site.example/bundle.js",
    codedToolIntegrity: "sha384-network",
    slyData: {},
    requestConsent: async (info) => { approvals.push(info); return approvals.length > 1 ? "decline" : "allow"; },
    sandbox: { invoke: async (request) => { invocations.push(request); return { result: { sum: 3 }, slyData: {} }; } },
  };
  const spec = { name: "calculator", class: "calculator.Calculator", url: "./coded_tools/calculator.js",
                 args: { precision: 2, a: 0 } };
  const result = await dispatchToolCall(ctx, { kind: "coded", ref: "calculator", spec }, { a: 1, b: 2 }, "parent", []);
  assert.equal(result, JSON.stringify({ sum: 3 }));
  assert.equal(invocations[0].bundleUrl, "https://site.example/coded_tools/calculator.js");
  assert.equal(invocations[0].integrity, null);
  assert.equal(invocations[0].className, "calculator.Calculator");
  assert.deepEqual(invocations[0].args, { precision: 2, a: 1, b: 2 });
  assert.equal(approvals.length, 0); // same-site code needs no consent

  // Without a `url`, the manifest's network-wide bundle is still used.
  await dispatchToolCall(ctx, { kind: "coded", ref: "legacy", spec: { name: "legacy", class: "Legacy" } }, {}, "parent", []);
  assert.equal(invocations[1].bundleUrl, "https://site.example/bundle.js");
  assert.equal(invocations[1].integrity, "sha384-network");

  // Code from another site asks first; a decline never reaches the sandbox.
  const thirdParty = { ...spec, url: "https://tools.example/calc.js", integrity: "sha384-tool" };
  await dispatchToolCall(ctx, { kind: "coded", ref: "calculator", spec: thirdParty }, {}, "parent", []);
  assert.equal(approvals[0].kind, "coded");
  assert.equal(approvals[0].peerOrigin, "tools.example");
  assert.equal(invocations[2].bundleUrl, "https://tools.example/calc.js");
  assert.equal(invocations[2].integrity, "sha384-tool");
  const declined = await dispatchToolCall(ctx, { kind: "coded", ref: "calculator", spec: thirdParty }, {}, "parent", []);
  assert.match(declined, /declined to load tool code from tools\.example/);
  assert.equal(invocations.length, 3);
}

console.log("runtime regression tests passed");
