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
  // expose for debugging / e2e tests
  if (typeof window !== "undefined") window.__nsweb = { engine, trace };
  return { engine, trace, actions: { register: definition => engine.actions.register({ base: engine.top.base, network: engine.top.network.name }, definition) } };
}
