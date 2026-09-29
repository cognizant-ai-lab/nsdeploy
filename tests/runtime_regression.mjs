import assert from "node:assert/strict";

import { assertRouterKey, isPublishedMockRouter, manifestAllowsPeer, selectPeerRouter, selectTopRouter } from "../nsdeploy/runtime/engine.js";
import { RemoteRegistry } from "../nsdeploy/runtime/remote.js";
import { isMockResponse, normalizeModelName } from "../nsdeploy/runtime/model.js";
import { consumeAgentBudget, consumeRemoteBudget, remoteIsInChain } from "../nsdeploy/runtime/composition.js";
import { AgentNetwork, loadNeuroSan, initKernel } from "../nsdeploy/runtime/kernel.js";

// remoteIsInChain parses references with neuro-san's ExternalAgentParsing, from the
// bundled kernel.
await loadNeuroSan();
initKernel();

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
