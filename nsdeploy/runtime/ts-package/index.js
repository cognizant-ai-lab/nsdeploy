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

const sameRouterUrl = (left, right) => {
  const normalize = (value) => {
    try { return new URL(resolveByokRouter(value), location.origin).href.replace(/\/$/, ""); } catch { return ""; }
  };
  return !!left && normalize(left) === normalize(right);
};

export async function boot(rootSelector = "#app", opts = {}) {
  const root = typeof rootSelector === "string" ? document.querySelector(rootSelector) : rootSelector;
  const trace = new TraceBus();
  const params = new URLSearchParams(location.search);
  // An API key in the URL is refused, not used. Query strings end up in server logs,
  // browser history and shared links, and a crafted link could plant someone else's
  // key. It's taken out of the address bar before the page stops.
  if (params.has("key")) {
    params.delete("key");
    const qs = params.toString();
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch {}
    throw new Error("API keys can't be passed in the URL. Open ⚙ BYOK settings and enter it there.");
  }
  let storedKey = "";
  try { storedKey = sessionStorage.getItem("nsweb-byok-key") || ""; } catch {}
  const savedProfile = getSelectedByokProfile();
  const savedRouter = resolveByokRouter(savedProfile?.router || "");
  // The settings panel puts the router in the URL so links stay shareable, and saves
  // it with the key. A link naming any other router gets no saved key, so a link can't
  // send the visitor's key somewhere new.
  const urlRouter = params.get("router") || "";
  const keyFollows = !urlRouter || sameRouterUrl(urlRouter, savedRouter);
  const siteBase = (opts.originUrl || location.origin).replace(/\/$/, "");
  const engine = new Engine({
    originUrl: siteBase,
    trace,
    byokKey: opts.byokKey || (keyFollows ? storedKey || savedProfile?.key : "") || "demo",
    routerOverride: opts.router || urlRouter || savedRouter || "",
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
