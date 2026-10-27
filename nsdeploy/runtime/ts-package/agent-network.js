// agent-network.js: the browser-side view of a neuro-san agent network.
//
// Logic that exists in neuro-san itself is not written here. It comes from
// @cognizant-ai-lab/neuro-san-ts-package, the real neuro-san sources transpiled to
// TypeScript, through ./generated-bridge.js: the config filter chain (commondefs,
// defaults, name correction), AgentNetwork's front man and agent specs, the network
// validators, and external agent / MCP reference parsing. What stays here is
// nsdeploy's own: link slots (a reference the developer links to another site at
// run time), the trace's display redaction, and adapting neuro-san's parsed
// references to browser origins.

import { neuroSanNetwork } from "./generated-bridge.js";

export { loadNeuroSan } from "./generated-bridge.js";

// --- ChatMessage envelope (mirrors neuro_san/api/grpc/chat.proto) ------------

// Filled from neuro-san's own ChatMessageType when the package loads, so the values
// are not restated here. Modules import this object up front and read it at run
// time, which is always after boot() has loaded the package.
export const ChatMessageType = {};

export function initNetwork() {
  Object.assign(ChatMessageType, neuroSanNetwork().ChatMessageType);
}

export function chatMessage(type, text, origin = [], extra = {}) {
  return { type, text, origin, ...extra };
}

// --- sly_data (display only) ---------------------------------------------------

// Keep keys, drop values, when sly_data is shown across a boundary in the trace. This
// is presentation, not policy: what crosses a boundary is decided by neuro-san's own
// SlyDataRedactor inside the agent loop.
export function redactSlyData(slyData) {
  if (!slyData) return slyData;
  const out = {};
  for (const k of Object.keys(slyData)) out[k] = "<redacted>";
  return out;
}

// --- external / MCP references (neuro-san's ExternalAgentParsing) ----------------

export function isExternalAgent(ref) {
  return typeof ref === "string" && neuroSanNetwork().isExternalAgent(ref);
}

export function isMcpTool(ref) {
  return neuroSanNetwork().isMcpTool(ref);
}

// Adapts neuro-san's {host, port, agent_name, scheme} to the {origin, agentName, url}
// this runtime passes around, resolving a same-server reference ("/name") against the
// serving origin.
export function parseExternalAgent(ref, baseOrigin) {
  const parsed = neuroSanNetwork().parseExternalAgent(ref);
  if (!parsed) return null;
  if (!parsed.scheme) {
    const origin = baseOrigin || (typeof location !== "undefined" ? location.origin : "");
    return { origin, agentName: parsed.agent_name, url: origin + ref };
  }
  const authority = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  return { origin: `${parsed.scheme}://${authority}`, agentName: parsed.agent_name, url: ref };
}

// --- AgentNetwork ------------------------------------------------------------------

export class AgentNetwork {
  constructor(config, name) {
    this.config = neuroSanNetwork().filterNetworkConfig(config);
    this.name = name;
    this.linkSlots = new Set(Object.keys(this.config.link_slots || {}));
    this.links = { ...(this.config.links || {}) };
    this.linkLabels = { ...(this.config.link_labels || {}) };
  }

  getAgentSpec(name) {
    return neuroSanNetwork().getAgentToolSpec(this.config, name) || null;
  }

  // neuro-san's own AgentNetwork.find_front_man; null when there is none.
  findFrontMan() {
    return neuroSanNetwork().findFrontMan(this.config);
  }

  // How this runtime activates a tool reference, composed from neuro-san's own
  // predicates, plus nsdeploy's link slots. A link slot this network also defines,
  // like a demo-mode agent, runs that local agent until it is linked at deploy time.
  classifyTool(ref) {
    let kind;
    if (isMcpTool(ref)) kind = "mcp";
    else if (typeof ref !== "string") kind = "missing";
    else if (isExternalAgent(ref)) kind = "remote";
    else {
      const spec = this.getAgentSpec(ref);
      if (!spec) kind = this.linkSlots.has(ref) ? "link" : "missing";
      else if (spec.class != null) kind = "coded";
      else if (spec.toolbox != null) kind = "toolbox";
      else kind = "agent";
    }
    const spec = typeof ref === "string" ? this.getAgentSpec(ref) || undefined : undefined;
    return { kind, ref, spec };
  }

  getLink(ref) {
    return this.links[ref] || null;
  }

  setLink(ref, target) {
    if (this.linkSlots.has(ref)) this.links[ref] = target;
  }

  metadata() {
    return this.config.metadata || {};
  }
}

// --- validation ------------------------------------------------------------------------

export function validateNetwork(network) {
  // neuro-san's network validators. A link slot is a reference nsdeploy resolves at run
  // time, so it is not reported as a missing agent.
  const errors = neuroSanNetwork().validateNetwork(network.config, network.name).filter((message) =>
    ![...network.linkSlots].some((ref) => message.includes("non-existent agent") && message.includes(`'${ref}'`))
  );
  const warnings = [];

  // The externals/mcps list (for the trace's cross-origin permission view) is a
  // browser-side concern, scanned here.
  const externals = [];
  const mcps = [];
  for (const agent of network.config.tools || []) {
    for (const ref of agent.tools || []) {
      const c = network.classifyTool(ref);
      if (c.kind === "remote") externals.push(ref);
      else if (c.kind === "mcp") mcps.push(typeof ref === "string" ? ref : ref.url);
    }
  }
  return { errors, warnings, externals, mcps };
}
