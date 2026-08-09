import assert from "node:assert/strict";

import { isPublishedMockRouter, manifestAllowsPeer, selectPeerRouter, selectTopRouter } from "../runtime/engine.js";
import { RemoteRegistry } from "../runtime/remote.js";
import { isMockResponse } from "../runtime/llm.js";
import { normalizeModelName } from "../runtime/model.js";
import { consumeAgentBudget, consumeRemoteBudget, remoteIsInChain } from "../runtime/runner.js";

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

console.log("runtime regression tests passed");
