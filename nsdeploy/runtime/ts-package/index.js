// index.js — public entry point for the neuro-san-web runtime.
//
// A business's index.html imports `boot` and points it at its origin. boot loads
// the origin's published network, compiles it, mounts the themeable UI, and is
// ready to run, entirely in the browser, with no agent server. The agents run on
// neuro-san's own loop (see engine.js).
//
// This folder is the runtime on the neuro-san TS package. The launcher serves it in
// place of ../index.js unless nsdeploy runs with --no-ts-package. Files here import
// the parts of the runtime that are the same either way (../ui.js, ../trace.js and
// so on) from the folder above.

export { Engine } from "./engine.js";
export { TraceBus } from "../trace.js";
export { mountApp } from "../ui.js";
export { AgentNetwork, validateNetwork, ChatMessageType } from "./agent-network.js";
export { parseHocon } from "../hocon.js";

import { Engine } from "./engine.js";
import { TraceBus } from "../trace.js";
import { mountApp } from "../ui.js";
import { getSelectedByokProfile, resolveByokRouter } from "../byok.js";

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
    byokKey: opts.byokKey || storedKey || savedProfile?.key || "demo",
    routerOverride: opts.router || params.get("router") || savedRouter || "",
    modelOverride: opts.model || params.get("model") || savedProfile?.model || "",
  });
  const { manifest } = await engine.loadTop();
  mountApp(root, { engine, trace, manifest });
  // The shared UI offers to drive the LLM via LangChain.js, which only the runtime in
  // the folder above can do. Here neuro-san's own loop always drives it.
  root.querySelector("#ns-lg")?.closest("label")?.remove();
  // expose for debugging / e2e tests
  if (typeof window !== "undefined") window.__nsweb = { engine, trace };
  return { engine, trace };
}
