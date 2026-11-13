import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentResponse, normalizePresentation, agentPresentationContext } from "../nsdeploy/runtime/cruse.js";

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

test("CRUSE remains opt-out and invocation prompts distinguish user from parent", () => {
  const ctx = { isTop: false, frontMan: "root", network: { config: {}, getAgentSpec: () => ({ instructions: "Simple assistant" }) } };
  assert.equal(agentPresentationContext(ctx, "root"), "");
  ctx.network.config.cruse = { version: 1 };
  assert.match(agentPresentationContext(ctx, "root"), /your parent agent/);
  ctx.isTop = true;
  assert.match(agentPresentationContext(ctx, "root"), /Audience: the user/);
});
