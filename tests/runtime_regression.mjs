import assert from "node:assert/strict";

import { assertRouterKey, isPublishedMockRouter, manifestAllowsPeer, selectPeerRouter, selectTopRouter } from "../nsdeploy/runtime/engine.js";
import { RemoteRegistry } from "../nsdeploy/runtime/remote.js";
import { isMockResponse, normalizeModelName } from "../nsdeploy/runtime/model.js";
import {
  consumeAgentBudget, consumeRemoteBudget, remoteIsInChain, requiresThirdPartyApproval,
} from "../nsdeploy/runtime/composition.js";
import { AgentNetwork, loadNeuroSan, initNetwork } from "../nsdeploy/runtime/agent-network.js";
import { createTurnEventStream } from "../nsdeploy/runtime/execution-stream.js";
import { TraceBus } from "../nsdeploy/runtime/trace.js";
import { createTurnStatusController, statusTextForEvent } from "../nsdeploy/runtime/turn-status.js";

// remoteIsInChain parses references with neuro-san's ExternalAgentParsing, from the
// bundled package.
await loadNeuroSan();
initNetwork();

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

// A demo-mode agent the network defines stays local until it is linked. Only a slot
// with no local agent asks the developer for a link.
const linkSlotNetwork = new AgentNetwork({
  tools: [
    {name: "farm_front", instructions: "Front.", tools: ["crop_planning_specialist", "outside_partner"]},
    {name: "crop_planning_specialist", instructions: "Demo crop planner."},
  ],
  link_slots: {crop_planning_specialist: {callers: ["farm_front"]}, outside_partner: {callers: ["farm_front"]}},
}, "greenbank_farm");
assert.equal(linkSlotNetwork.classifyTool("crop_planning_specialist").kind, "agent");
assert.equal(linkSlotNetwork.classifyTool("outside_partner").kind, "link");

// Consent follows the actual site boundary. A page's own MCP/service network is
// local, while /ext-mcp remains gated because it proxies an external MCP server.
assert.equal(requiresThirdPartyApproval("https://site.example/_mcp/0/mcp", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("/mcp", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("https://site.example/ext-mcp/0/mcp", "https://site.example"), true);
assert.equal(requiresThirdPartyApproval("https://tools.example/mcp", "https://site.example"), true);
assert.equal(requiresThirdPartyApproval("https://site.example/other_network", "https://site.example"), false);
assert.equal(requiresThirdPartyApproval("https://agents.example/other_network", "https://site.example"), true);

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

// BYOK guard: a real (non-mock) router is never contacted without a visitor-entered
// key. The "demo" sentinel and an empty key are both rejected; the mock needs none.
assert.throws(() => assertRouterKey({ baseUrl: "http://router.example/v1", mock: false }, "demo"), /needs your API key/);
assert.throws(() => assertRouterKey({ baseUrl: "http://router.example/v1", mock: false }, ""), /needs your API key/);
assert.doesNotThrow(() => assertRouterKey({ baseUrl: "http://router.example/v1", mock: false }, "sk-real"));
assert.doesNotThrow(() => assertRouterKey({ baseUrl: "http://127.0.0.1:8091/v1", mock: true }, "demo"));

console.log("runtime regression tests passed");
