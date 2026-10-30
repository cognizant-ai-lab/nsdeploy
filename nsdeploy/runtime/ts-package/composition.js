// composition.js: nsdeploy's own policy around the neuro-san agent loop.
//
// None of this is neuro-san logic. The loop itself is neuro-san's (see engine.js and
// the built generated/browser/neuro-san.mjs); these are the limits nsdeploy puts on composing
// public sites (per-query budgets, cycle checks), the consent card's request text
// and its cost estimate.

import { parseExternalAgent } from "./agent-network.js";

export function argsToText(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (args.request) return String(args.request);
  if (args.input) return String(args.input);
  if (args.input_string) return String(args.input_string);
  return JSON.stringify(args);
}

// The text of a partner network request, readable for the consent card. neuro-san's
// ExternalActivation sends the calling agent's tool arguments as a ```json block;
// a single "inquiry" (or other one-string) argument is shown as plain text, and
// several arguments as "name: value" pairs.
export function peerRequestText(request) {
  const text = String(request?.user_message?.text ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (!fenced) return text;
  let args;
  try {
    args = JSON.parse(fenced[1]);
  } catch {
    return fenced[1];
  }
  if (args == null || typeof args !== "object" || Array.isArray(args)) return argsToText(args);
  const entries = Object.entries(args).filter(([, value]) => value != null && value !== "");
  if (entries.length === 1 && typeof entries[0][1] === "string") return entries[0][1];
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("; ");
}

// Consent protects a site boundary, not every service call. Local MCP hosts are
// deliberately exposed through same-origin /_mcp routes and are part of the page
// the visitor already chose to use. /ext-mcp is the exception: it is a
// same-origin transport proxy whose destination is an external MCP server.
export function requiresThirdPartyApproval(ref, baseOrigin) {
  const raw = typeof ref === "string" ? ref : ref?.url;
  try {
    const base = new URL(baseOrigin);
    const target = new URL(raw, base);
    const externalMcpProxy = /^\/ext-mcp(?:\/|$)/i.test(target.pathname);
    return externalMcpProxy || target.origin !== base.origin;
  } catch {
    // Invalid or opaque destinations must never bypass the consent boundary.
    return true;
  }
}

export function remoteIsInChain(ref, baseOrigin, chain = []) {
  try {
    const parsed = parseExternalAgent(ref, baseOrigin);
    return chain.includes(`${parsed.origin}::${parsed.agentName}`);
  } catch {
    return false;
  }
}

export function consumeRemoteBudget(composition, targetKey, now = Date.now()) {
  if (!composition) return null;
  if (now >= composition.deadline) return "the composition deadline was reached";
  if (composition.remoteCalls >= composition.maxRemoteCalls) {
    return `the per-query limit of ${composition.maxRemoteCalls} third-party calls was reached`;
  }
  const prior = composition.peerCalls.get(targetKey) || 0;
  if (prior >= composition.maxCallsPerPeer) return "that network was already consulted for this query";
  composition.remoteCalls += 1;
  composition.peerCalls.set(targetKey, prior + 1);
  return null;
}

// Why no more agents may run for this query, as main checks before every agent call,
// or null. The deadline only: the count of agent calls is left to the TS package.
export function agentDeadlineReason(composition, now = Date.now()) {
  return composition && now >= composition.deadline ? "the 90-second query deadline was reached" : null;
}

export function consumeAgentBudget(composition, now = Date.now()) {
  if (!composition) return null;
  const late = agentDeadlineReason(composition, now);
  if (late) return late;
  if (composition.agentCalls >= composition.maxAgentCalls) {
    return `the per-query limit of ${composition.maxAgentCalls} agent invocations was reached`;
  }
  composition.agentCalls += 1;
  return null;
}

// Rough per-1M-token prices [input, output] for cost estimates. Approximate.
const PRICE = {
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8], "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1-nano": [0.1, 0.4],
  "o4-mini": [1.1, 4.4], "gpt-5.2": [1.25, 10],
};

// Estimate the token cost of running a peer network for one request. Heuristic:
// prompt grows with each agent's instructions + tool schemas (re-sent per round),
// and there is roughly one model round-trip per tool plus a final summary.
export function estimateRemoteCost({ network, requestText, model, mock }) {
  let instrChars = 0;
  for (const a of network.config.tools || []) {
    instrChars += (a.instructions || "").length + JSON.stringify(a.function || {}).length;
  }
  const fm = network.getAgentSpec(network.findFrontMan());
  const toolCount = (fm?.tools || []).length;
  const rounds = 1 + toolCount;
  const promptTokens = Math.round(((instrChars + (requestText || "").length) / 4) * (1 + 0.3 * toolCount));
  const completionTokens = rounds * 120;
  const totalTokens = promptTokens + completionTokens;
  let costText = null;
  if (mock) costText = "$0.00 (mock)";
  else {
    const key = (model || "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
    const p = PRICE[model] || PRICE[key];
    if (p) {
      const c = (promptTokens / 1e6) * p[0] + (completionTokens / 1e6) * p[1];
      costText = "$" + c.toFixed(c < 0.01 ? 4 : 3);
    }
  }
  return { totalTokens, promptTokens, completionTokens, costText };
}
