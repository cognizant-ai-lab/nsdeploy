// Open cruse-browser.html through any local static server. Exercises the real UI
// without a provider key or network requests; leaves a rich example for visual QA.
import { mountApp, renderPresentation } from "../nsdeploy/runtime/ui.js";
import { renderMarkdown, renderSafeHtml } from "../nsdeploy/runtime/cruse-render.js";
import { Engine } from "../nsdeploy/runtime/engine.js";
import { AgentNetwork, initNetwork, loadNeuroSan } from "../nsdeploy/runtime/agent-network.js";

const status = document.querySelector("#status");
const passed = [];
const check = (condition, label) => { if (!condition) throw new Error(label); passed.push(label); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const form = { id: "borrow-dates", kind: "form", title: "One follow-up", schema: { type: "object", properties: { start_date: { type: "string", format: "date", title: "Start date" }, seats: { type: "integer", minimum: 1, title: "Seats" } }, required: ["start_date"] } };
const presentation = { version: 1, components: [
  { id: "report", kind: "report", title: "Minivan search — fixture data", markdown: "## Availability\n\nTwo **illustrative** options to compare. These are test data.\n\n- Dates still need confirmation.\n- Add details in chat or use the form below." },
  { id: "options", kind: "table", title: "Compare options", columns: ["Option", "Seats", "Next step"], rows: [["Minivan A", 7, "Confirm dates"], ["Minivan B", 8, "Check pickup"]] },
  { id: "chart", kind: "chart", title: "Illustrative weekly availability", chartType: "bar", unit: "Vehicles", labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], series: [{ name: "Minivans", values: [1, 2, 2, 1, 3] }, { name: "Other vehicles", values: [3, 2, 1, 2, 2] }], summary: "Test data: Friday has the most minivans. Real availability must be checked." },
  { id: "html", kind: "html", title: "Handoff notes", html: "<article><p>Choose an option before arranging a handoff.</p><details><summary>What happens next?</summary><ul><li>Confirm dates</li><li>Agree pickup details</li></ul></details></article>" },
  form,
] };

try {
  const sink = document.createElement("div");
  renderMarkdown(sink, "## Findings\n\n**Readable** text and [unsafe](javascript:alert(1))\n<script>bad()</script>");
  check(!!sink.querySelector("h3") && !!sink.querySelector("strong") && !sink.querySelector("script,a"), "Markdown is formatted and raw HTML/unsafe links cannot execute");
  renderMarkdown(sink, "| Vehicle | Seats |\n| --- | ---: |\n| **Minivan** | 7 |\n\n---");
  check(sink.querySelectorAll("tbody tr").length === 1 && !!sink.querySelector("td strong") && !!sink.querySelector("hr"), "Chat Markdown tables and section separators are rendered contextually");
  sink.replaceChildren();
  renderSafeHtml(sink, '<article onclick="bad()"><h2>Report</h2><img src="https://invalid.test/x"><script>bad()</script><svg onload="bad()"></svg><a href="javascript:bad()">Unsafe</a><a href="https://example.com">Source</a><style>body{display:none}</style><iframe srcdoc="bad"></iframe></article>');
  check(!sink.querySelector("script,img,svg,style,iframe,[onclick]") && sink.querySelector("a").getAttribute("href") === null && sink.querySelectorAll('a[href="https://example.com/"]').length === 1, "HTML sanitizer preserves content and safe links, removes active content");
  sink.replaceChildren();
  renderPresentation(sink, { version: 1, components: [{ ...presentation.components[2], chartType: "line", series: [{ name: "Changes", values: [0, -2, 1, 3, -1] }] }] }, () => {});
  check(!!sink.querySelector("svg[role=img] polyline") && sink.querySelectorAll("tbody tr").length === 5 && !/NaN|Infinity/.test(sink.innerHTML), "Line chart handles zero/negative values and includes accessible data");
  sink.replaceChildren();
  renderPresentation(sink, { kind: "chart", chartType: "bar", labels: ["Low", "High"], series: [{ name: "Extreme values", values: [-Number.MAX_VALUE, Number.MAX_VALUE] }], summary: "Finite extreme values" }, () => {});
  check(!/NaN|Infinity/.test(sink.innerHTML), "Chart coordinates remain finite for extreme numeric ranges");
  sink.replaceChildren();
  let chosen;
  renderPresentation(sink, { kind: "choice", id: "vehicle", options: [{ title: "Friendly label", value: "vehicle-123" }] }, (text, interaction) => { chosen = interaction; return true; }, "choice-turn");
  sink.querySelector("button").click();
  await tick();
  check(chosen.value === "vehicle-123" && chosen.componentId === "vehicle" && chosen.turnId === "choice-turn", "Choices retain stable values and originating IDs");

  // AgentNetwork is neuro-san's, from the runtime's bundle (runtime-build/).
  await loadNeuroSan();
  initNetwork();
  const engine = new Engine({ originUrl: location.origin });
  const network = new AgentNetwork({ tools: [{ name: "root", instructions: "Fixture" }] }, "fixture");
  engine.top = { network, base: location.origin };
  engine.mockLLM = true;
  const turns = [];
  engine.runTurn = async (text, options) => {
    turns.push({ text, options });
    // The old implementation rendered these events as extra widgets.
    engine.trace.note("widget", { widget: form });
    engine.trace.note("presentation_proposal", { agent: "child", presentation: { version: 1, components: [form] } });
    return { text: "**Availability** is provisional. You can add details in chat.", presentation: turns.length === 1 ? presentation : null, turnId: `turn-${turns.length}` };
  };
  const manifest = { brand: "Neighbor Exchange · Test", llm_router: { base_url: location.origin + "/v1", mock: true }, welcome: { message: "Use the form or type your request below.", widget: { ...form, title: "Start a neighbor exchange" } } };
  mountApp(document.querySelector("#app"), { engine, trace: engine.trace, manifest });
  const app = document.querySelector("#app");
  app.querySelector("#ns-input").value = "Are there any minivans available for me to borrow next week?";
  app.querySelector("#ns-send").click();
  await tick();
  check(app.querySelectorAll(".ns-presentation").length === 1 && app.querySelectorAll(".ns-presentation form").length === 1, "Only the final composition is rendered; child widgets are not appended");
  check(app.querySelectorAll('[data-welcome="true"] form').length === 1 && !app.querySelector('[data-welcome="true"] input').disabled, "The initial welcome widget remains available when bypassed in chat");
  check(app.querySelectorAll(".ns-presentation svg rect").length === 10, "Grouped bar chart renders every data point");
  const active = app.querySelector(".ns-presentation form");
  check(!active.checkValidity(), "Missing required input is validated before submission");
  active.querySelector("input[type=date]").value = "2026-10-01";
  active.querySelector("input[type=number]").value = "6";
  active.requestSubmit();
  await tick();
  const interaction = turns.at(-1).options.interaction;
  check(interaction.componentId === "borrow-dates" && interaction.turnId === "turn-1" && interaction.values.seats === 6, "Form submission preserves field IDs and numeric types");
  app.querySelector("#ns-input").value = "Make that Friday, with eight seats.";
  app.querySelector("#ns-send").click();
  await tick();
  check(turns.at(-1).text.includes("Friday") && !turns.at(-1).options.interaction, "Users can augment submitted form answers through plain chat");

  let finishRunningTurn;
  engine.runTurn = async (text, options) => {
    turns.push({ text, options });
    const run = engine.trace.start("run", { streamToken: options._streamToken, input: text });
    options._turnControl?.attach(engine.trace, run);
    await new Promise((resolve) => { finishRunningTurn = resolve; });
    options._turnControl?.close();
    engine.trace.end(run);
    return { text: "Updated while running.", presentation: null, turnId: run };
  };
  app.querySelector("#ns-input").value = "Start a longer search";
  app.querySelector("#ns-send").click();
  await tick();
  check(app.querySelector(".ns-inputbar").dataset.turnActive === "true" && app.querySelector("#ns-send").textContent === "Update", "The input stays available as an Update control during a running turn");
  app.querySelector("#ns-input").value = "Only include Friday";
  app.querySelector("#ns-send").click();
  await tick();
  check(app.querySelectorAll('.ns-steering-message[data-input-kind="steering"]').length === 1, "Intermediate user guidance appears as a themeable steering message");
  finishRunningTurn();
  await tick();
  await tick();
  check(app.querySelector(".ns-inputbar").dataset.turnActive === "false" && app.querySelector("#ns-send").textContent === "Send", "The input returns to its normal state after the final answer");
  app.querySelector("#ns-newchat").click();
  check(!app.querySelector(".ns-presentation") && !!app.querySelector('[data-welcome="true"]'), "New chat resets response surfaces and retains the welcome widget");
  // Leave a useful composed sample on screen for desktop/mobile visual review.
  renderPresentation(app.querySelector("#ns-msgs"), presentation, () => false, "preview");
  status.textContent = `PASS — ${passed.length} browser checks\n` + passed.map((s) => "✓ " + s).join("\n");
} catch (error) {
  status.textContent = "FAIL — " + error.stack + "\nCompleted:\n" + passed.join("\n");
  console.error(error);
}
