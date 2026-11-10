import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionRegistry, actionBindings, validateData } from "../nsdeploy/runtime/actions.js";
import { Engine } from "../nsdeploy/runtime/engine.js";
import { parseAgentResponse } from "../nsdeploy/runtime/cruse.js";
import { sameOriginAsset } from "../nsdeploy/runtime/action-transport.js";
import { AgentNetwork } from "../nsdeploy/runtime/kernel.js";
import { runAgent } from "../nsdeploy/runtime/runner.js";
import { TraceBus } from "../nsdeploy/runtime/trace.js";
import { randomUuid, sha256Hex } from "../nsdeploy/runtime/web-crypto.js";

const scope = { base: "https://local.test", network: "local" };
const schema = { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 5 } }, required: ["count"] };
const definition = execute => ({ name: "save", description: "Save count", inputSchema: schema, execute });

test("HTTP-compatible UUID and SHA-256 fallbacks match browser primitives", async () => {
  const noCrypto = {};
  const uuid = randomUuid(noCrypto);
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(uuid, randomUuid(noCrypto));
  assert.equal(await sha256Hex("abc", noCrypto), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await sha256Hex("🍕 café", noCrypto), await sha256Hex("🍕 café"));
});
function fixture(execute = async a => a) {
  const registry = new ActionRegistry();
  const ref = registry.register(scope, definition(execute));
  return { registry, ref, form: { id: "combined", kind: "form", schema: { properties: { quantity: { type: "integer" } } }, submit: { actions: [{ action: ref, inputs: { count: "quantity" } }] } } };
}
test("strict schemas reject unknown fields, invalid values and unsupported constraints", () => {
  for (const data of [{ count: 0 }, { count: "2" }, { count: 1, url: "evil" }, {}]) assert.throws(() => validateData(schema, data));
  const { registry } = fixture();
  assert.throws(() => registry.register(scope, { ...definition(async () => ({})), name: "other", inputSchema: { ...schema, anyOf: [] } }));
  assert.throws(() => sameOriginAsset(scope.base, "https://evil.test/module.js"));
});
test("proposals preserve bindings but reject forged references, executable fields and missing mappings", () => {
  const { registry, ref, form } = fixture();
  const parse = c => parseAgentResponse('```cruse-ui\n' + JSON.stringify(c) + '\n```');
  assert.equal(actionBindings(registry.validatePresentation(parse(form), new Set([ref])).presentation.components[0])[0].action, ref);
  for (const action of ["https://other.test/n#save", ref]) {
    const result = registry.validatePresentation(parse({ kind: "action", action, arguments: { count: 1 } }), new Set());
    assert.equal(result.presentation, null);
  }
  const invalid = structuredClone(form); invalid.submit.actions[0].url = "https://evil.test";
  assert.equal(registry.validatePresentation(parse(invalid), new Set([ref])).presentation, null);
  assert.throws(() => registry.prepare(form, { quantity: 0 }));
  assert.deepEqual(registry.prepare(form, { quantity: 2, secret: "not routed" })[0].args, { count: 2 });
});
test("confirmation, duplicate clicks, partial failure and receipts are enforced by the engine", async () => {
  let calls = 0;
  const engine = new Engine({ originUrl: scope.base });
  const ref = engine.actions.register(scope, definition(async a => { calls++; return a; }));
  engine.rememberActionPresentation({ turnId: "turn", presentation: { components: [{ id: "a", kind: "action", action: ref, arguments: { count: 2 } }] } });
  const input = { turnId: "turn", componentId: "a" };
  assert.equal(await engine.submitActions(input), null); assert.equal(calls, 0);
  engine.onActionConfirm = async () => true;
  const [a, b] = await Promise.all([engine.submitActions(input), engine.submitActions(input)]);
  assert.deepEqual(a, b); assert.equal(calls, 1); assert.match(engine.history[0].content, /succeeded/);
  engine.resetHistory(); await assert.rejects(engine.submitActions(input), /expired/);
  const { registry, form } = fixture(async () => { throw new Error("Disconnected after POST"); });
  form.submit.actions.push(form.submit.actions[0]);
  const receipts = await registry.execute(registry.prepare(form, { quantity: 1 }), async () => true, "request");
  assert.deepEqual(receipts.map(r => r.status), ["unknown", "not_started"]);
});

test("a peer cannot propose caller capabilities; a parent can retain a child's validated proposal", async () => {
  const { registry, ref } = fixture();
  const peerScope = { base: "https://peer.test", network: "peer" };
  const peerRef = registry.register(peerScope, definition(async a => a));
  const network = new AgentNetwork({ cruse: { version: 1 }, tools: [{ name: "root", instructions: "Help", tools: ["child"] }, { name: "child", instructions: "Help", tools: [] }] }, "peer");
  const ctx = { network, actions: registry, baseOrigin: peerScope.base, displayOrigin: "peer.test", trace: new TraceBus(), slyData: {}, frontMan: "root", composition: {},
    llm: { chat: async () => ({ content: '```cruse-ui\n' + JSON.stringify({ kind: "action", action: ref, arguments: { count: 1 } }) + '\n```', toolCalls: [] }) } };
  const forged = await runAgent(ctx, "child", "Help", null, []);
  assert.equal(forged.presentation, null);
  assert.match(forged.presentationIssues[0], /not available/);
  const parentScope = new Set();
  ctx.allowedActionRefs = parentScope;
  ctx.llm.chat = async () => ({ content: '```cruse-ui\n' + JSON.stringify({ kind: "action", action: peerRef, arguments: { count: 1 } }) + '\n```', toolCalls: [] });
  const valid = await runAgent(ctx, "child", "Help", null, []);
  assert.equal(valid.presentation.components[0].action, peerRef);
  assert.equal(parentScope.has(peerRef), true);
  assert.equal(parentScope.has(ref), false);
});

test("timeouts are unknown, abort the adapter signal and do not start later operations", async () => {
  const { registry, form, ref } = fixture(async (_, { signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ aborted: true }))));
  registry.entries.get(ref).timeoutMs = 100;
  form.submit.actions.push(form.submit.actions[0]);
  const receipts = await registry.execute(registry.prepare(form, { quantity: 2 }), async () => true, "timeout-test");
  assert.equal(receipts[0].status, "unknown");
  assert.equal(receipts[1].status, "not_started");
});
