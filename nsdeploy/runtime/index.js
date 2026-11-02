// index.js — public entry point for the neuro-san-web runtime.
//
// A business's index.html imports `boot` and points it at its origin. boot loads
// the origin's published network, compiles it, mounts the themeable UI, and is
// ready to run — entirely in the browser, with no agent server.

export { Engine } from "./engine.js";
export { TraceBus } from "./trace.js";
export { mountApp } from "./ui.js";
export { AgentNetwork, validateNetwork, ChatMessageType } from "./kernel.js";
export { parseHocon } from "./hocon.js";
export { ActionRegistry } from "./actions.js";

import { Engine } from "./engine.js";
import { TraceBus } from "./trace.js";
import { mountApp } from "./ui.js";
import { getSelectedByokProfile, resolveByokRouter } from "./byok.js";

export async function boot(rootSelector = "#app", opts = {}) {
  const root = typeof rootSelector === "string" ? document.querySelector(rootSelector) : rootSelector;
  if (!root) throw new Error("Agent widget mount not found.");
  root.setAttribute("data-nsdeploy-ui", "");
  const trace = new TraceBus();
  const params = new URLSearchParams(location.search);
  // BYOK key handling: a real API key must NEVER live in the URL/query string -
  // that leaks it to the static origin (initial GET), browser history, server
  // logs, and shared links. If a key ever arrives via the URL (legacy/shared
  // link), migrate it into sessionStorage and strip it from the address bar
  // immediately. Saved BYOK profiles, when present, provide cross-network
  // defaults without putting the key in the URL.
  if (params.has("key")) {
    const urlKey = params.get("key");
    if (urlKey && urlKey !== "demo") {
      try { sessionStorage.setItem("nsweb-byok-key", urlKey); } catch {}
    }
    params.delete("key");
    const qs = params.toString();
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch {}
  }
  let storedKey = "";
  try { storedKey = sessionStorage.getItem("nsweb-byok-key") || ""; } catch {}
  const savedProfile = getSelectedByokProfile();
  const savedRouter = resolveByokRouter(savedProfile?.router || "");
  const siteBase = (opts.originUrl || location.origin).replace(/\/$/, "");
  const engine = new Engine({
    originUrl: siteBase,
    trace,
    sandboxWorkerUrl: opts.sandboxWorkerUrl || "/runtime/sandbox-worker.js",
    byokKey: opts.byokKey || storedKey || savedProfile?.key || "",
    routerOverride: opts.router || params.get("router") || savedRouter || "",
    modelOverride: opts.model || params.get("model") || savedProfile?.model || "",
  });
  // Select the agent loop: ?runner=langchain drives the LLM via LangChain.js
  // (neuro-san-web owns the loop). 'langgraph' kept as an alias for older links.
  const runnerChoice = opts.runner || params.get("runner") || (savedProfile?.runner ? "langchain" : "");
  const { manifest } = await engine.loadTop();
  if (manifest?.deployment?.mode !== "static"
      && (runnerChoice === "langchain" || runnerChoice === "langgraph")) {
    await engine.enableLangChain();
  }
  mountApp(root, { engine, trace, manifest });
  {
    const status = document.createElement("details");
    status.className = "ns-action-status";
    status.style.cssText = "flex:none;padding:8px 12px;font-size:12px;max-height:140px;overflow:auto";
    const summary = document.createElement("summary");
    const detail = document.createElement("p");
    const update = () => {
      const count = engine.actions.catalog({ base: engine.top.base, network: engine.top.network.name }).length;
      summary.textContent = count ? `${count} website actions connected` : "No website actions connected";
      detail.textContent = engine.actions.discoveryIssues.map(i => `${i.page}: ${i.reason}`).join(" ") || (count
        ? "Actions run after you review and confirm them. Server responses appear as receipts."
        : "This agent can collect information, but no website operations are connected.");
    };
    engine.actions.onChange = update;
    update();
    status.append(summary, detail); (root.querySelector(".ns-chat") || root).prepend(status);
  }
  // expose for debugging / e2e tests
  if (typeof window !== "undefined") window.__nsweb = { engine, trace };
  return { engine, trace, actions: {
    register: definition => {
      const ref = engine.actions.register({ base: engine.top.base, network: engine.top.network.name }, definition);
      engine.actions.onChange?.();
      return ref;
    },
    refreshHostForms: () => engine.actions.hostForms?.refresh(),
  } };
}
