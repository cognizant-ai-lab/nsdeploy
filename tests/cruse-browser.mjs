// Open cruse-browser.html through any local static server. Exercises the real UI
// without a provider key or network requests; leaves a rich example for visual QA.
import { API_KEY_PROVIDERS, mountApp, renderPresentation } from "../nsdeploy/runtime/ui.js";
import { renderMarkdown, renderSafeHtml } from "../nsdeploy/runtime/cruse-render.js";
import { Engine } from "../nsdeploy/runtime/engine.js";
import { AgentNetwork } from "../nsdeploy/runtime/kernel.js";

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
  check(!!app.querySelector("#theme-settings.ns-settings #ns-key") && !app.querySelector('[data-ns-slot="chat"] .ns-settings'), "Theme-owned settings slot controls AI model placement");
  check(app.querySelector("#theme-settings summary").textContent.includes("Model settings"), "Theme-owned settings use a clear public label");
  check(app.querySelector("#ns-key").required && !app.querySelector("#ns-lg"), "Only the API key is required in the simple setup flow");
  // The fixture network names no model, so the Model field must not say it is optional.
  const modelInput = app.querySelector("#ns-model");
  check(app.querySelector("#ns-model-label").textContent === "Model *" && modelInput.required && modelInput.placeholder === "Enter a model your provider supports", "The Model field is marked required when the network names no model");
  const advanced = app.querySelector(".ns-settings-advanced");
  const keyInput = app.querySelector("#ns-key");
  const routerInput = app.querySelector("#ns-router");
  const formBefore = { router: routerInput.value, model: modelInput.value };
  const typeKey = (value) => { keyInput.value = value; keyInput.dispatchEvent(new Event("input")); };
  const google = API_KEY_PROVIDERS.find((provider) => provider.keyPrefixes.includes("AIza"));
  const groq = API_KEY_PROVIDERS.find((provider) => provider.keyPrefixes.includes("gsk_"));
  // This page starts without needing a key, so the key help is built but hidden.
  const keyHelp = app.querySelector(".ns-key-help");
  check(!!keyHelp && getComputedStyle(keyHelp).display === "none", "A page that needs no key builds the key help hidden");
  typeKey("AIza-fixture");
  check(modelInput.value === google.model, "A recognized key fills in its provider's model");
  check(!advanced.open, "A recognized key leaves the advanced settings closed");
  modelInput.value = "gemini-fixture-choice";
  typeKey("AIza-fixture-edited");
  check(modelInput.value === "gemini-fixture-choice", "Editing a key from the same provider keeps the chosen model");
  typeKey("gsk_fixture");
  check(modelInput.value === groq.model, "A key from another provider fills in that provider's model");
  // An unrecognized key on a network that names no model opens the advanced settings at once.
  modelInput.value = "";
  typeKey("sk-fixture-unrecognized");
  check(advanced.open, "An unrecognized key opens the advanced settings when the site needs a model");
  const profileHint = app.querySelector("#ns-profile-hint");
  check(/^This site needs a model name/.test(profileHint.textContent) && !/Open/.test(profileHint.textContent), "The hint says to enter a model, without asking the visitor to open anything");
  // Save and start still asks for the model and puts the cursor in its field.
  advanced.open = false;
  routerInput.value = "https://router.example/v1";
  app.querySelector("#ns-apply").click();
  await tick();
  check(advanced.open && document.activeElement === modelInput, "Asking for a model opens the advanced settings and focuses the Model field");
  check(/Enter a model your provider supports in the Model field/.test(profileHint.textContent) && !/Open/.test(profileHint.textContent), "Save and start's model message does not ask the visitor to open anything");
  // A page that needs a key shows provider links. Choosing another provider clears a key
  // recognized as a different provider's, so that key is never sent to it.
  const keyed = document.createElement("div");
  document.body.append(keyed);
  // Keep the link's own handler but stop it opening the provider's site.
  keyed.addEventListener("click", (event) => event.preventDefault(), true);
  const keyedEngine = new Engine({ originUrl: location.origin });
  keyedEngine.top = { network, base: location.origin };
  keyedEngine.mockLLM = false;
  keyedEngine.byokRouter = "https://keyed.example/byok/v1";
  mountApp(keyed, { engine: keyedEngine, trace: keyedEngine.trace, manifest: { brand: "Keyed fixture", llm_router: { base_url: keyedEngine.byokRouter } } });
  const keyedKey = keyed.querySelector("#ns-key");
  const keyedHelp = keyed.querySelector(".ns-key-help");
  const keyedHint = keyed.querySelector("#ns-router-hint");
  const keyLabel = keyedKey.closest("label");
  const keyedProfileHint = keyed.querySelector("#ns-profile-hint");
  check(/^To start, add an AI provider key\. In ⚙ AI model settings, choose a provider/.test(keyedProfileHint.textContent) && !/free provider|sent only to/.test(keyedProfileHint.textContent), "The first-visit message names the panel clearly and does not promise free providers");
  check(keyLabel.children.length === 2 && keyLabel.firstElementChild.textContent === "API key *", "The API key label keeps its asterisk on the label's line");
  check(/This site passes your key on/.test(keyedHint.textContent) && !/CORS/.test(keyedHint.textContent), "The hint says plainly that this site passes the key on");
  check(getComputedStyle(keyedHelp).display !== "none", "The key help shows while there is no key");
  keyedKey.value = "AIza-fixture";
  keyedKey.dispatchEvent(new Event("input"));
  check(getComputedStyle(keyedHelp).display === "none", "The key help hides once a key is entered");
  keyed.querySelector(`[data-ns-provider="${groq.name}"]`).click();
  check(keyedKey.value === "" && keyed.querySelector("#ns-router").value === groq.router, "Choosing another provider clears a key that belongs to a different provider");
  check(getComputedStyle(keyedHelp).display !== "none" && /sends your key directly to the Provider URL/.test(keyedHint.textContent), "The help returns when the key is cleared, and a provider address gets the key straight from the browser");
  keyedKey.value = "sk-fixture-unrecognized";
  keyed.querySelector(`[data-ns-provider="${google.name}"]`).click();
  check(keyedKey.value === "sk-fixture-unrecognized", "Choosing a provider keeps a key it cannot attribute to another provider");
  keyed.remove();
  // On a site whose network names a model, an unrecognized key needs only Save and start.
  const named = document.createElement("div");
  document.body.append(named);
  const namedEngine = new Engine({ originUrl: location.origin });
  namedEngine.top = { network: new AgentNetwork({ llm_config: { model_name: "fixture-model" }, tools: [{ name: "root", instructions: "Fixture" }] }, "named"), base: location.origin };
  namedEngine.mockLLM = false;
  mountApp(named, { engine: namedEngine, trace: namedEngine.trace, manifest: { brand: "Named fixture", llm_router: { base_url: "https://router.example/v1" } } });
  const namedKey = named.querySelector("#ns-key");
  namedKey.value = "sk-fixture-unrecognized";
  namedKey.dispatchEvent(new Event("input"));
  check(named.querySelector("#ns-profile-hint").textContent === "Select Save and start to use this key." && !named.querySelector(".ns-settings-advanced").open, "On a site that names a model, an unrecognized key only needs Save and start");
  namedKey.value = "";
  namedKey.dispatchEvent(new Event("input"));
  check(/^To start, add an AI provider key/.test(named.querySelector("#ns-profile-hint").textContent), "Clearing the key brings back the first-visit message");
  named.remove();
  // Restore the form, so the chat checks below send nothing to a real provider.
  typeKey("");
  check(getComputedStyle(keyHelp).display !== "none", "Clearing the key shows the key help, even on a page that started with no need for one");
  routerInput.value = formBefore.router;
  modelInput.value = formBefore.model;
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
