// generated-bridge.js: the only path to the neuro-san code bundled from
// @cognizant-ai-lab/neuro-san-ts-package (the real neuro-san sources transpiled to
// TypeScript) by runtime-build/ (vite build), entered at generated/browser/neuro-san.mjs:
//   network  config filter chain, AgentNetwork, validators,
//            external/MCP reference parsing
//   session  the agent loop (DirectAgentSession)
// There is no fallback: a missing bundle is an error, never hand-written behaviour.
let bundle = null;
let loading = null;

export async function loadNeuroSan() {
  if (bundle) return bundle;
  if (!loading) {
    loading = import("./generated/browser/neuro-san.mjs").then((loaded) => {
      bundle = loaded;
      return bundle;
    });
  }
  return loading;
}

export function neuroSanNetwork() {
  if (!bundle) throw new Error("the neuro-san agent network code has not been loaded");
  return bundle.network;
}

export function neuroSanSession() {
  if (!bundle) throw new Error("the neuro-san agent loop has not been loaded");
  return bundle.session;
}
