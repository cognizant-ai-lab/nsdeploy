import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentResponse, normalizePresentation, agentPresentationContext } from "../nsdeploy/runtime/cruse.js";
import { Engine } from "../nsdeploy/runtime/engine.js";

const fence = (value) => "```cruse-ui\n" + JSON.stringify(value) + "\n```";
const form = (id, properties) => ({ id, kind: "form", title: "Borrowing details", schema: { type: "object", properties, required: Object.keys(properties) } });
const date = { type: "string", format: "date", title: "Start date" };
const dates = form("dates", { start_date: date });
const logistics = form("logistics", { pickup_date: { ...date, title: "Pickup date" }, seats: { type: "integer", title: "Seats" } });
const consolidated = form("details", { start_date: date, seats: { type: "integer", title: "Seats" } });

test("legacy widgets, exact duplicate proposals and component IDs", () => {
  const raw = "Two options.\n" + fence({ ...dates, kind: undefined }) + "\n" + fence(dates);
  const result = parseAgentResponse(raw, { invocation: "leaf-1" });
  assert.equal(result.text, "Two options.");
  assert.equal(result.presentation.components.length, 1);
  assert.equal(result.presentation.components[0].id, "dates");
  assert.equal(result.cruse, 1);
  const separate = normalizePresentation({ version: 1, components: [dates, { ...logistics, id: "dates" }] }).presentation.components;
  assert.notEqual(separate[0].id, separate[1].id);
  assert.equal(normalizePresentation({ components: [dates, { ...dates, id: "another-person" }] }).presentation.components.length, 2);
  const idField = form("identity", { id: { type: "string" } });
  assert.equal(normalizePresentation({ components: [idField, { ...idField, schema: { properties: { name: { type: "string" } } } }] }).presentation.components.length, 2);
});

test("AAOSA envelopes retain internal requirements and parse embedded or adjacent UI", () => {
  const envelope = { Name: "child", Inquiry: "minivan", Mode: "Fulfill", Response: "Need dates.\n" + fence(dates) };
  for (const raw of [JSON.stringify(envelope), "```json\n" + JSON.stringify(envelope) + "\n```", JSON.stringify({ ...envelope, Response: "Need dates." }) + "\n" + fence(dates)]) {
    const result = parseAgentResponse(raw);
    assert.equal(result.text, "Need dates.");
    assert.equal(result.presentation.components[0].kind, "form");
    assert.equal(result.protocol.Name, "child");
  }
  const determine = parseAgentResponse(JSON.stringify({ Name: "child", Mode: "Determine", Requirements: [{ title: "Exact dates" }] }));
  assert.equal(determine.text, "Exact dates");
  assert.deepEqual(determine.protocol.Requirements, [{ title: "Exact dates" }]);
});

test("invalid components never turn into empty forms, while useful text survives", () => {
  const result = parseAgentResponse("Dates are still needed.\n" + fence({ version: 1, components: [{ kind: "unknown" }, { kind: "chart", labels: ["A"], series: [] }, { kind: "form", schema: {} }] }));
  assert.equal(result.text, "Dates are still needed.");
  assert.equal(result.presentation, null);
  assert.equal(result.presentationIssues.length, 3);
  assert.equal(result.unrenderedProposals[0].components.length, 3);
  assert.equal(parseAgentResponse("Hello\n```cruse-ui\n{broken}").text, "Hello");
  assert.equal(parseAgentResponse(fence({ version: 999, components: [dates] })).presentation, null);
  const documentation = "```json\n{\"schema\": \"documentation\"}\n```";
  assert.equal(parseAgentResponse(documentation).presentation, null);
  assert.equal(parseAgentResponse(documentation).text, documentation);
  assert.equal(parseAgentResponse(fence({ ...dates, display: false })).presentation, null);
});

test("chart values and table shapes are validated; report-only responses need no form", () => {
  const chart = { kind: "chart", chartType: "line", summary: "Known values", labels: ["Mon", "Tue"], series: [{ name: "Available", values: [0, 2] }] };
  assert.equal(normalizePresentation(chart).presentation.components[0].kind, "chart");
  assert.equal(normalizePresentation({ ...chart, series: [{ name: "bad", values: [1] }] }).presentation, null);
  assert.equal(normalizePresentation({ ...chart, series: [{ name: "bad", values: [1, NaN] }] }).presentation, null);
  assert.equal(normalizePresentation({ kind: "table", columns: ["A"], rows: [[1, 2]] }).presentation, null);
  assert.equal(normalizePresentation({ kind: "report", markdown: "## Answer\nUseful prose" }).presentation.components[0].kind, "report");
});

const spec = (name, tools = []) => ({ name, instructions: `AGENT=${name}\nGENERATIVE UI (CRUSE)`, function: { description: name }, tools });
const config = { cruse: { version: 1 }, tools: [spec("root", ["manager", "https://peer.test/peer"]), spec("manager", ["dates_agent", "logistics_agent"]), spec("dates_agent"), spec("logistics_agent")] };
const peerConfig = { cruse: { version: 1 }, tools: [spec("peer_root", ["peer_leaf"]), spec("peer_leaf")] };
const manifest = (name) => ({ networks: [{ name, hocon: "/network.json" }], allowed_peers: ["https://peer.test"], llm_router: { base_url: "https://model.test/v1", byok_router: "https://model.test/v1", mock: false } });
const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } });

// Exercise the real loops, model-client serialization, fetched peer Session, and
// Engine history. Only model responses and HTTP files are deterministic fixtures.
function fixtureFetch(observations) {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith("/agent-manifest.json")) return json(manifest(href.includes("peer.test") ? "peer" : "test"));
    if (href.endsWith("/network.json")) return json(href.includes("peer.test") ? peerConfig : config);
    if (href.endsWith("/links.json")) return json({});
    assert.match(href, /model\.test\/v1\/chat\/completions$/);
    const body = JSON.parse(options.body);
    const agent = body.messages[0].content.match(/AGENT=(\w+)/)[1];
    assert.match(body.messages[0].content, /consolidate them into your own presentation/);
    const childResults = body.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    observations.push({ agent, messages: body.messages, childResults });
    let content = "", calls = [];
    if (agent === "root" && body.messages.filter((m) => m.role === "user").length > 1) {
      assert.ok(body.messages.some((m) => m.role === "assistant" && m.content?.includes('"id":"details"')));
      content = "Updated to Thursday; your other details are retained.";
    } else if (body.tools?.length && !childResults.length) {
      calls = body.tools.map((t, i) => ({ index: i, id: `call_${agent}_${i}`, type: "function", function: { name: t.function.name, arguments: JSON.stringify({ request: "Minivan availability next week" }) } }));
    } else if (agent === "dates_agent") content = "Exact dates needed.\n" + fence(dates);
    else if (agent === "logistics_agent") content = "Pickup date and seats needed.\n" + fence(logistics);
    else if (agent === "manager") {
      assert.equal(childResults.length, 2);
      assert.deepEqual(childResults.map((r) => r.presentation.components[0].id), ["dates", "logistics"]);
      content = "Need one date and seat count.\n" + fence({ version: 1, components: [consolidated] });
    } else if (agent === "peer_leaf") content = "Availability is provisional.\n" + fence({ kind: "info", fields: { Availability: "Provisional" } });
    else if (agent === "peer_root") {
      assert.equal(childResults[0].presentation.components[0].kind, "info");
      content = "One provisional option.\n" + fence({ kind: "table", columns: ["Vehicle", "Availability"], rows: [["Minivan", "Provisional"]] });
    } else if (agent === "root") {
      assert.equal(childResults[0].presentation.components.length, 1);
      assert.equal(childResults[1].source.network, "peer");
      assert.equal(childResults[1].presentation.components[0].kind, "table");
      content = "One option needs confirmation.\n" + fence({ version: 1, components: [childResults[1].presentation.components[0], consolidated] });
    } else throw new Error(`Unexpected agent ${agent}`);
    const chunks = [
      { id: "completion", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: null }] },
      { id: "completion", object: "chat.completion.chunk", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  };
}

for (const runner of ["manual", "langchain"]) test(`${runner}: consolidate at every level and across peer networks, retain follow-up context`, async () => {
  const originalFetch = globalThis.fetch;
  const observations = [];
  globalThis.fetch = fixtureFetch(observations);
  try {
    const engine = new Engine({ originUrl: "https://top.test", byokKey: "fixture-key", modelOverride: "test-model" });
    if (runner === "langchain") await engine.enableLangChain();
    const events = [];
    let result = null;
    for await (const event of engine.streamTurn("Are there any minivans available for me to borrow next week?")) {
      events.push(event);
      if (event.type === "turn.completed") result = event.result;
    }
    assert.ok(result);
    assert.equal(events[0].type, "turn.started");
    assert.equal(events.at(-1).type, "turn.completed");
    assert.ok(events.some((event) => event.type === "agent.completed" && event.source?.agent === "peer_leaf"));
    assert.ok(events.some((event) => event.type === "tool.completed"));
    assert.ok(events.findIndex((event) => event.type === "tool.completed") < events.length - 1);
    assert.equal(result.presentation.components.filter((c) => c.kind === "form").length, 1);
    assert.deepEqual(Object.keys(result.presentation.components[1].schema.properties), ["start_date", "seats"]);
    assert.equal(engine.trace.events.filter((e) => e.kind === "widget").length, 0);
    assert.equal(engine.trace.events.filter((e) => e.kind === "presentation_proposal").length, 6);
    assert.ok(observations.find((o) => o.agent === "peer_root").messages[0].content.includes("your parent agent"));
    const second = await engine.runTurn("Make that Thursday", { interaction: { turnId: result.turnId, componentId: "details", values: { start_date: "2026-10-01", seats: 6 } } });
    assert.equal(second.presentation, null);
    assert.match(engine.history.at(-2).content, /CRUSE interaction:.*"componentId":"details"/);
    assert.match(second.text, /Thursday/);
    assert.equal(typeof await engine.run("Thanks"), "string");
    engine.resetHistory();
    assert.deepEqual(engine.history, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("CRUSE remains opt-out and invocation prompts distinguish user from parent", () => {
  const ctx = { isTop: false, frontMan: "root", network: { config: {}, getAgentSpec: () => ({ instructions: "Simple assistant" }) } };
  assert.equal(agentPresentationContext(ctx, "root"), "");
  ctx.network.config.cruse = { version: 1 };
  assert.match(agentPresentationContext(ctx, "root"), /your parent agent/);
  ctx.isTop = true;
  assert.match(agentPresentationContext(ctx, "root"), /Audience: the user/);
});
