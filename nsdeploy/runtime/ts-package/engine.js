// engine.js: load a published network from an origin, compile it, and run it on
// neuro-san's own agent loop.
//
// The loop is neuro-san's DirectAgentSession, from @cognizant-ai-lab/neuro-san-ts-package
// (the real neuro-san sources transpiled to TypeScript), built into generated/
// (entered at generated/browser/neuro-san.mjs). This module owns what is nsdeploy's
// rather than neuro-san's:
// which LLM router a run uses, consent before contacting a partner network or MCP
// server, the per-query composition limits, link slots, and turning the loop's
// streamed messages into the trace the UI draws.
//
// Partner networks are fetched and run locally: neuro-san asks resolvePeer (below)
// for a partner's network the first time it calls it, and runs it here in the
// caller's session, with the caller's router. A partner is never executed remotely
// and never receives the caller's BYOK key.

import { parseHocon } from "../hocon.js";
import {
  AgentNetwork, ChatMessageType, initNetwork, loadNeuroSan, parseExternalAgent, redactSlyData, validateNetwork,
} from "./agent-network.js";
import { neuroSanSession } from "./generated-bridge.js";
import { TraceBus } from "../trace.js";
import { fetchManifest, fetchText, resolveUrl, RemoteRegistry } from "../remote.js";
import {
  argsToText, consumeRemoteBudget, estimateRemoteCost, peerRequestText, remoteIsInChain, requiresThirdPartyApproval,
} from "./composition.js";
import { agentPresentationContext, interactionMessage, parseAgentResponse } from "../cruse.js";
import { BROWSER_MOCK_ROUTER, browserMockResponse, isMockResponse, normalizeModelName } from "./model.js";
import { createTurnEventStream } from "../execution-stream.js";
import { applyPendingSteering, runInterruptibleModelCall, TurnControl } from "../turn-control.js";

function normOrigin(url) {
  try { return new URL(url).origin; } catch { return String(url || ""); }
}

function sameRouter(left, right) {
  try {
    const normalize = (value) => {
      const url = new URL(value);
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
      const host = loopback ? "loopback" : url.hostname.toLowerCase();
      return `${url.protocol}//${host}:${url.port}${url.pathname.replace(/\/$/, "")}${url.search}`;
    };
    return normalize(left) === normalize(right);
  } catch {
    return String(left || "").replace(/\/$/, "") === String(right || "").replace(/\/$/, "");
  }
}

export async function isPublishedMockRouter(router, fetchImpl = fetch) {
  try {
    const url = new URL(router);
    const response = await fetchImpl(`${url.origin}/agent-manifest.json`, { cache: "no-store" });
    if (!response.ok) return false;
    const manifest = await response.json();
    const declared = manifest?.llm_router || {};
    return declared.mock === true && sameRouter(router, declared.base_url);
  } catch {
    return false;
  }
}

export function selectTopRouter(manifest, routerOverride, byokKey, modelOverride = "") {
  const declared = manifest?.llm_router || {};
  const hasRealKey = !!(byokKey && byokKey !== "demo");
  const hasExplicitModel = !!String(modelOverride || "").trim();
  let requested = String(routerOverride || "").replace(/\/$/, "");
  const requestedMock = requested && declared.mock === true && sameRouter(requested, declared.base_url);

  if ((hasRealKey || hasExplicitModel) && (!requested || requestedMock)) {
    if (!declared.byok_router) {
      throw new Error("A real API key is configured, but this site publishes no BYOK router.");
    }
    requested = declared.byok_router;
    return { baseUrl: requested, mock: false, upgradedToByok: true };
  }
  if (requested) {
    return { baseUrl: requested, mock: declared.mock === true && sameRouter(requested, declared.base_url), upgradedToByok: false };
  }
  return { baseUrl: declared.base_url || "", mock: declared.mock === true, upgradedToByok: false };
}

export function manifestAllowsPeer(target, manifest, runtimeAllowedPeers = new Set()) {
  const targetOrigin = normOrigin(target);
  const policy = manifest?.peer_policy || manifest?.web_policy;
  if (policy?.mode === "open") {
    let parsed;
    try { parsed = new URL(target); } catch { return false; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const denied = (policy.deny_origins || policy.denied_origins || []).map(normOrigin);
    if (denied.includes(targetOrigin)) return false;
    return true;
  }
  const declared = (manifest?.allowed_peers || []).map(normOrigin);
  return declared.includes(targetOrigin) || runtimeAllowedPeers.has(targetOrigin);
}

export function selectPeerRouter(callerRouter) {
  if (!callerRouter?.baseUrl) {
    throw new Error("The caller has no active LLM router to use for this peer network.");
  }
  return { baseUrl: callerRouter.baseUrl, mock: callerRouter.mock === true };
}

// A real LLM router needs a key the visitor entered (BYOK). "demo" is only the
// mock's placeholder, so stop with a clear message instead of sending it to a
// real provider, which would answer with a confusing 401. This happens when a
// shared or reloaded URL keeps a real router but this browser has no saved key.
export function assertRouterKey(llm, apiKey) {
  if (!llm?.mock && (!apiKey || apiKey === "demo")) {
    throw new Error(`The selected LLM router (${hostOf(llm?.baseUrl) || "a real provider"}) needs your API key. Open ⚙ BYOK settings and enter it, or switch the router back to the mock to run without a key.`);
  }
}

export class Engine {
  constructor({ originUrl, trace, byokKey, routerOverride } = {}) {
    this.originUrl = (originUrl || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
    this.trace = trace || new TraceBus();
    this.byokKey = byokKey || "";
    this.routerOverride = routerOverride || "";
    this.modelOverride = normalizeModelName(arguments[0] && arguments[0].modelOverride);
    this.registry = new RemoteRegistry({ trace: this.trace }); // compiled partner networks, for the UI
    this.top = null; // {network, base, manifest, llm}
    this.chatContext = null; // neuro-san's chat_context from the last turn, sent with the next
    this.consent = new Map(); // peerOrigin -> "always" (remembered approvals)
    this.consentTail = Promise.resolve(); // serialize modal decisions for parallel tools
    this.onConsent = null; // UI hook: async (info) => "allow"|"always"|"decline"
    this.onLinkRequired = null; // UI hook: async ({reference,...}) => peer URL|null
    this.runtimeAllowedPeers = new Set(); // user-entered, validated link origins
    this.refOwners = new Map(); // tool reference URL -> the network (and site) that declares it
    this.composition = null; // this query's composition budget
    this.runSpan = null;
    this.streamSequence = 0;
    this.turnControl = null; // the running streamed turn's steering channel
    this.steeringAt = []; // this turn's steering, and where in the front man's messages it went in
    this.agentPrompts = new Map(); // an agent's instructions as sent -> who it is, to tell model calls apart
    this.agentSpans = new Map(); // origin path -> this run's open agent span
    this.toolSpans = new Map(); // origin path, MCP call or partner URL -> this run's open tool span
    this.toolCaller = null; // the agent span whose model call last asked for tools
    this.networksByName = new Map(); // network name -> AgentNetwork, for a tool's spec
    this.toolBatches = new Map(); // "network::agent" -> the tool calls of its last model response
    this.peerCallers = new Map(); // partner URL -> the agent spans that called it, in call order
    this.mcpCalls = new Map(); // MCP call id -> { url, tool, response }, while the call runs
  }

  // Start a new chat.
  resetHistory() {
    this.chatContext = null;
  }

  // Ask the user to approve contacting another hosted network. Remembers
  // "always" per origin; defaults to allow when no UI hook is attached (headless).
  async requestConsent(info) {
    const decide = async () => {
      if (this.consent.get(info.peerOrigin) === "always") return "allow";
      if (typeof this.onConsent !== "function") return "allow";
      const decision = await this.onConsent(info);
      if (decision === "always") { this.consent.set(info.peerOrigin, "always"); return "allow"; }
      return decision || "allow";
    };
    const pending = this.consentTail.then(decide, decide);
    this.consentTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  // Compile the origin's own published front network.
  async loadTop() {
    await loadNeuroSan();
    initNetwork();
    this._installLoopHooks();
    this._observeModelCalls();
    const span = this.trace.start("compile", { origin: hostOf(this.originUrl), what: "top network" });
    try {
      const { manifest, base } = await fetchManifest(this.originUrl);
      const entry = manifest.networks[0];
      // Set manifest early so partner/MCP policy checks have it.
      this.top = { manifest, base };
      const hasConfiguredModel = !!String(this.modelOverride || "").trim();
      const hasRealKey = !!(this.byokKey && this.byokKey !== "demo");
      if ((hasConfiguredModel || hasRealKey) && this.routerOverride
          && !sameRouter(this.routerOverride, manifest.llm_router?.base_url)
          && await isPublishedMockRouter(this.routerOverride)) {
        const oldRouter = this.routerOverride;
        this.routerOverride = manifest.llm_router?.byok_router || "";
        this.trace.note("router_correction", {
          origin: hostOf(base), from: oldRouter, to: this.routerOverride,
          reason: "saved router is another nsDeploy site's published mock endpoint",
        });
      }
      const { network, llm, validation: v } = await this._compile(base, manifest, entry, { isTop: true });
      this.top = { network, base, manifest, llm };
      this.mockLLM = llm.mock; // true when using the deterministic mock router
      this.byokRouter = manifest.llm_router?.byok_router || ""; // real-LLM proxy for BYOK keys
      this.trace.end(span, {
        network: network.name,
        frontMan: network.findFrontMan(),
        errors: v.errors,
        warnings: v.warnings,
        peers: v.externals || [],
      });
      return { network, manifest, validation: v };
    } catch (err) {
      this.trace.fail(span, err);
      throw err;
    }
  }

  async _compile(base, manifest, entry, { isTop = false } = {}) {
    const hoconUrl = resolveUrl(base, entry.hocon);
    const text = await fetchText(hoconUrl);
    const config = parseHocon(text);
    const publishedLinks = await this._loadPublishedLinks(base, entry.name || entry.hocon);
    config.links = { ...(config.links || {}), ...publishedLinks };
    const network = new AgentNetwork(config, entry.name || entry.hocon);
    // Validation gate: a network with structural errors must never run. This applies
    // to the top network AND to every fetched-and-run partner network.
    const validation = validateNetwork(network);
    if (validation.errors && validation.errors.length) {
      throw new Error(`Network '${network.name}' (${hostOf(base)}) failed validation: ${validation.errors.join("; ")}`);
    }
    // Every reference is policed by the manifest of the site that declares it.
    for (const ref of [...validation.externals, ...validation.mcps, ...Object.values(network.links)]) {
      this.refOwners.set(ref, { network, base, manifest });
    }
    // LLM routing boundary. The top site chooses the active router. Partner manifests
    // contribute network definitions only and can never redirect execution or keys.
    let routerBase;
    let mock;
    if (isTop) {
      const selected = selectTopRouter(manifest, this.routerOverride, this.byokKey, this.modelOverride);
      routerBase = selected.baseUrl;
      mock = selected.mock;
      this.routerOverride = selected.upgradedToByok ? routerBase : this.routerOverride;
      this.userRouter = { baseUrl: routerBase, mock };
    } else {
      // A partner contributes its network definition, not its execution environment.
      // It always runs in this browser with the top caller's active router, even for
      // keyless/mock sessions. Never send execution or a BYOK key to the partner.
      const selected = selectPeerRouter(this.userRouter);
      routerBase = selected.baseUrl;
      mock = selected.mock;
    }
    return { network, llm: { baseUrl: routerBase, mock }, hoconUrl, validation };
  }

  _assertAllowedPeer(target, sourceManifest) {
    const manifest = sourceManifest || this.top?.manifest;
    if (!manifestAllowsPeer(target, manifest, this.runtimeAllowedPeers)) {
      const source = manifest?.networks?.[0]?.name || "calling network";
      throw new Error(`Policy: ${hostOf(target)} is not in ${source}'s allowed_peers; refusing to contact it.`);
    }
  }

  async _loadPublishedLinks(base, networkName) {
    try {
      const resp = await fetch(resolveUrl(base, "/links.json"), { cache: "no-store" });
      if (!resp.ok) return {};
      const doc = await resp.json();
      return doc?.networks?.[networkName] || {};
    } catch {
      return {};
    }
  }

  _linkKey(base, networkName, reference) {
    return `nsdeploy-link-v1::${base}::${networkName}::${reference}`;
  }

  _storedLink(base, networkName, reference) {
    try { return localStorage.getItem(this._linkKey(base, networkName, reference)) || ""; }
    catch { return ""; }
  }

  async _persistLink(base, networkName, reference, target) {
    try { localStorage.setItem(this._linkKey(base, networkName, reference), target); } catch {}
    if (this.top?.manifest?.deployment?.mode === "static") return;
    try {
      await fetch(resolveUrl(base, "/_nsdeploy/links"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ network: networkName, reference, target }),
      });
    } catch {
      // Static hosts have no mutable endpoint; browser-local persistence remains.
    }
  }

  async _normalizeLinkTarget(reference, rawTarget) {
    let parsed;
    try { parsed = new URL(String(rawTarget || "").trim()); }
    catch { throw new Error("Enter a complete http:// or https:// nsDeploy site URL."); }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Linked network URLs must use http or https.");
    }
    const origin = parsed.origin;
    const requested = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const { manifest } = await fetchManifest(origin);
    const networks = manifest.networks || [];
    const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    let entry = requested ? networks.find((item) => item.name === requested) : null;
    if (!entry) entry = networks.find((item) => norm(item.name) === norm(reference));
    if (!entry) {
      const matchedExport = (manifest.linking?.exports || []).find((item) =>
        (item.aliases || []).some((alias) => norm(alias) === norm(reference))
      );
      if (matchedExport) entry = networks.find((item) => item.name === matchedExport.network);
    }
    if (!entry && networks.length === 1) entry = networks[0];
    if (!entry) {
      const choices = networks.map((item) => item.name).join(", ") || "none";
      throw new Error(`No unique network matching '${reference}' at ${origin}. Published networks: ${choices}.`);
    }
    return `${origin}/${entry.name}`;
  }

  async resolveLink(reference, network, base, parentSpan) {
    let target = network.getLink(reference) || this._storedLink(base, network.name, reference);
    let needsValidation = false;
    if (!target) {
      if (typeof this.onLinkRequired !== "function") {
        throw new Error(`Agent-network link '${reference}' is unresolved. Supply a peer nsDeploy URL.`);
      }
      target = await this.onLinkRequired({
        reference,
        sourceNetwork: network.name,
        sourceOrigin: base,
        parentSpan,
      });
      if (!target) return null;
      needsValidation = true;
    }
    let normalized = target;
    if (needsValidation) {
      // Entering a URL is the developer's explicit request to contact that site
      // for validation. Persisted links wait for the normal call-consent gate.
      normalized = await this._normalizeLinkTarget(reference, target);
    } else {
      let parsed;
      try { parsed = new URL(String(target)); } catch {}
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
        throw new Error(`Stored link '${reference}' is not a valid http(s) URL.`);
      }
    }
    this.runtimeAllowedPeers.add(new URL(normalized).origin);
    network.setLink(reference, normalized);
    await this._persistLink(base, network.name, reference, normalized);
    this.trace.note("link", {
      origin: hostOf(base), network: network.name, reference, target: normalized,
    });
    return normalized;
  }

  // The config neuro-san's loop runs for a network: every agent uses the active
  // router's model (neuro-san reads the key and router from OPENAI_API_KEY and
  // OPENAI_BASE_URL), and link slots with no local agent become partner URLs. A slot
  // not linked yet becomes LINK_SLOT_PREFIX + its name, which resolvePeer turns into a
  // request for the developer to link it.
  _runnableConfig(network) {
    this.networksByName.set(network.name, network);
    const config = structuredClone(network.config);
    const override = this.modelOverride ? { model_name: this.modelOverride } : {};
    // Every model call goes to the one router the user configured. When they chose a
    // model, that model is the whole llm_config: the fallbacks it lists (often other
    // providers) would otherwise be what neuro-san calls, and with one router and one
    // model there is nothing left to fall back to.
    // Streaming, so the trace and the turn's event stream get each answer's text as
    // it arrives, as main's own loop does. neuro-san builds the model from a fallback
    // when there are fallbacks, so each one streams too.
    const llmConfig = (agentConfig) => {
      const out = { ...(agentConfig || {}), class: "openai", streaming: true, ...override };
      if (this.modelOverride) delete out.fallbacks;
      if (Array.isArray(out.fallbacks)) out.fallbacks = out.fallbacks.map((fallback) => ({ ...fallback, streaming: true }));
      return out;
    };
    config.llm_config = llmConfig(config.llm_config);
    // CRUSE's presentation context for each agent (see cruse.js): whether its
    // presentation reaches the user or is a proposal for the agent that called it.
    const presentationContext = { network, isTop: network === this.top?.network, frontMan: network.findFrontMan() };
    for (const agent of config.tools || []) {
      if (agent.llm_config || !agent.class) agent.llm_config = llmConfig(agent.llm_config);
      const context = agent.name ? agentPresentationContext(presentationContext, agent.name) : "";
      if (context && typeof agent.instructions === "string") agent.instructions = `${agent.instructions}\n\n${context}`;
      if (agent.name && typeof agent.instructions === "string" && agent.instructions) {
        this.agentPrompts.set(agent.instructions, {
          network: network.name, agent: agent.name, origin: hostOf(this._baseOf(network)),
          isTopFrontMan: presentationContext.isTop && agent.name === presentationContext.frontMan,
        });
      }
      if (!Array.isArray(agent.tools)) continue;
      agent.tools = agent.tools.map((ref) => {
        if (network.classifyTool(ref).kind !== "link") return ref;
        const target = network.getLink(ref) || this._storedLink(this._baseOf(network), network.name, ref);
        const url = target || LINK_SLOT_PREFIX + encodeURIComponent(ref);
        this.refOwners.set(url, { network, base: this._baseOf(network), manifest: this._manifestOf(network), linkSlot: ref });
        return url;
      });
    }
    return config;
  }

  _baseOf(network) {
    if (network === this.top?.network) return this.top.base;
    for (const owner of this.refOwners.values()) if (owner.network === network) return owner.base;
    return this.top?.base;
  }

  _manifestOf(network) {
    if (network === this.top?.network) return this.top.manifest;
    for (const owner of this.refOwners.values()) if (owner.network === network) return owner.manifest;
    return this.top?.manifest;
  }

  // The hooks neuro-san's loop calls at the points where nsdeploy decides something:
  // before contacting an MCP server or calling one of its tools, and before running
  // a partner network.
  _installLoopHooks() {
    if (this._hooksInstalled) return;
    this._hooksInstalled = true;
    const session = neuroSanSession();
    const mcpSpans = new Map();
    const peerSpans = new Map();
    const peerAnswers = new Map(); // partner URL -> its answer's text, for its tool span
    session.setHooks({
      mcpConsent: async ({ url }) => {
        const owner = this.refOwners.get(url);
        try {
          this._assertAllowedPeer(url, owner?.manifest);
        } catch (err) {
          this.trace.note("consent", { parent: this.runSpan, origin: hostOf(owner?.base || this.top.base), peerOrigin: hostOf(url), phase: "discover", decision: "blocked", reason: err.message });
          return false;
        }
        // Discovering a third-party server's tools (initialize, tools/list) IS contact
        // with it, so it waits for consent; declining means the agent runs without these
        // tools. The site's own services are within the page's trust boundary.
        if (!requiresThirdPartyApproval(url, owner?.base || this.top.base)) return true;
        const decision = await this.requestConsent({
          kind: "mcp", phase: "discover", peerLabel: "Destination service", peerOrigin: hostOf(url),
          requestText: "(discover available tools)",
          est: { totalTokens: 0, costText: this.mockLLM ? "$0.00 (mock)" : "metadata only" },
        });
        if (decision === "decline") {
          this.trace.note("consent", { parent: this.runSpan, origin: hostOf(owner?.base || this.top.base), peerOrigin: hostOf(url), phase: "discover", decision: "declined" });
          return false;
        }
        return true;
      },
      mcpCall: async ({ url, tool, args, caller, callId }) => {
        // Discovery consent never silently authorizes execution: a third-party call is
        // confirmed with the real payload, unless the origin is "always" allowed.
        // Same-site calls skip both prompts, as they don't cross the site's boundary.
        const owner = this.refOwners.get(url);
        if (requiresThirdPartyApproval(url, owner?.base || this.top.base)) {
          const requestText = argsToText(args);
          const decision = await this.requestConsent({
            kind: "mcp", phase: "call", peerLabel: "Destination service", peerOrigin: hostOf(url),
            requestText,
            est: { totalTokens: Math.round((requestText.length + 80) / 4), costText: this.mockLLM ? "$0.00 (mock)" : null },
          });
          if (decision === "decline") {
            this.trace.note("consent", { parent: this.runSpan, origin: hostOf(this.top.base), peerOrigin: hostOf(url), phase: "call", decision: "declined" });
            return `The user declined to send this request to ${hostOf(url)}. Continue without it.`;
          }
        }
        mcpSpans.set(callId, this.trace.start("mcp_call", {
          parent: this.runSpan, origin: hostOf(this.top.base), peerOrigin: hostOf(url), url, tool, requestPayload: args,
        }));
        this.mcpCalls.set(callId, { url, tool, response: false });
        this._startTool(`mcp::${callId}`, { tool, toolKind: "MCP", args, parent: caller ? this._callerSpan(caller) : null });
        return null;
      },
      mcpResult: ({ result, error, callId }) => {
        const span = mcpSpans.get(callId);
        mcpSpans.delete(callId);
        this.mcpCalls.delete(callId);
        this._endTool(`mcp::${callId}`, error ? { error } : { result });
        if (!span) return;
        if (error) this.trace.fail(span, error);
        else this.trace.end(span, { responsePreview: String(result ?? "").slice(0, 300) });
      },
      resolvePeer: async (url, { chain, request }) => {
        const owner = this.refOwners.get(url);
        const label = owner?.linkSlot || owner?.network.linkLabels?.[url] || parseExternalAgent(url, owner?.base)?.agentName || url;
        this._startTool(`peer::${url}`, {
          tool: label, toolKind: owner?.linkSlot ? "linked network" : "remote network", parent: this.peerCallers.get(url)?.shift(),
        });
        try {
          const resolved = await this._resolvePeer(url, chain, request, peerSpans);
          // An answer instead of a run (declined, skipped) is the call's whole result.
          if (resolved.answer != null) this._endTool(`peer::${url}`, { result: resolved.answer });
          return resolved;
        } catch (error) {
          this._endTool(`peer::${url}`, { error });
          throw error;
        }
      },
      peerDone: ({ url, error }) => {
        this._endTool(`peer::${url}`, error ? { error } : { result: peerAnswers.get(url) });
        peerAnswers.delete(url);
        const span = peerSpans.get(url);
        peerSpans.delete(url);
        if (!span) return;
        if (error) this.trace.fail(span, error);
        else this.trace.end(span, { type: ChatMessageType.AGENT });
      },
      // A partner's own agents show under its call, each by the path from the partner's URL.
      peerMessage: ({ url, message }) => this._traceMessage(
        { ...message, origin: [{ tool: url }, ...(Array.isArray(message.origin) ? message.origin : [])] },
        peerSpans.get(url),
      ),
      // A partner's answer goes back to the agent that called it as CRUSE's
      // {cruse, text, presentation} (see cruse.js), so its presentation is a proposal
      // the caller consolidates, never shown to the user directly. The trace has it
      // already, as the partner's front man's proposal.
      peerAnswer: ({ url, text }) => {
        const owner = this.refOwners.get(url);
        const agentName = parseExternalAgent(url, owner?.base)?.agentName;
        const source = { origin: hostOf(url), network: agentName, agent: agentName, invocation: `peer-${agentName}` };
        const result = parseAgentResponse(text, source);
        peerAnswers.set(url, result.text);
        return JSON.stringify(result);
      },
      toolCall: ({ caller, tool, ref, run }) => this._scheduleTool(caller, tool, run, ref),
      peerFunction: (url) => {
        const owner = this.refOwners.get(url);
        const label = owner?.network.linkLabels?.[url] || owner?.linkSlot || parseExternalAgent(url, owner?.base)?.agentName || url;
        return owner?.linkSlot && url.startsWith(LINK_SLOT_PREFIX)
          ? { description: `Hand off to the linked agent network "${owner.linkSlot}". If it is not linked yet, ask the developer for its nsDeploy site URL.` }
          : { description: `Hand off to the ${label} network. Provide a natural-language request.` };
      },
    });
  }

  // Called by neuro-san the first time an agent calls a partner network. Applies
  // nsdeploy's policy, then fetches and compiles the partner's published network.
  // Returning { answer } does not run the partner; that text is its answer.
  async _resolvePeer(url, chain, request, peerSpans) {
    let owner = this.refOwners.get(url);
    let target = url;
    if (url.startsWith(LINK_SLOT_PREFIX)) {
      const reference = decodeURIComponent(url.slice(LINK_SLOT_PREFIX.length));
      target = await this.resolveLink(reference, owner.network, owner.base, this.runSpan);
      if (!target) return { answer: `The user did not link '${reference}'. Continue without it.` };
      this.refOwners.set(target, owner);
    }
    const label = owner?.network.linkLabels?.[target] || hostOf(target);
    const base = owner?.base || this.top.base;
    const parsed = parseExternalAgent(target, base);
    const chainKeys = chain.map((ref) => {
      const p = parseExternalAgent(ref, base);
      return p ? `${p.origin}::${p.agentName}` : ref;
    });
    if (remoteIsInChain(target, base, [`${this.top.base}::${this.top.network.name}`, ...chainKeys])) {
      this.trace.note("composition_skip", { parent: this.runSpan, origin: hostOf(base), target, reason: "already visited in this request" });
      return { answer: `Skipped ${label}: that network is already in this request's call chain. Continue with available results and do not retry it.` };
    }
    // Consent precedes any contact with a third-party partner, so the estimate is
    // coarse: the partner has not been fetched yet. A network published by this same
    // site stays local.
    const requestText = peerRequestText(request) || "(the request your agent is sending)";
    if (requiresThirdPartyApproval(target, base)) {
      const decision = await this.requestConsent({
        kind: "network", peerLabel: label, peerOrigin: hostOf(target), requestText,
        est: { totalTokens: Math.round((requestText.length + 300) / 4) * 2, costText: this.mockLLM ? "$0.00 (mock)" : null },
      });
      if (decision === "decline") {
        this.trace.note("consent", { parent: this.runSpan, origin: hostOf(base), peerOrigin: hostOf(target), decision: "declined" });
        return { answer: `The user declined to contact ${hostOf(target)}. Proceed without it and note that to the user.` };
      }
    }
    const budgetReason = consumeRemoteBudget(this.composition, `${parsed.origin}::${parsed.agentName}`);
    if (budgetReason) {
      this.trace.note("composition_limit", { parent: this.runSpan, origin: hostOf(base), target, reason: budgetReason, remoteCalls: this.composition?.remoteCalls });
      return { answer: `Skipped ${label}: ${budgetReason}. Continue with available results and do not retry it.` };
    }
    this._assertAllowedPeer(parsed.origin, owner?.manifest);

    const lastSeg = target.split("/").filter(Boolean).pop();
    const fetchSpan = this.trace.start("remote_fetch", {
      parent: this.runSpan, origin: hostOf(this.top.base), peerOrigin: hostOf(parsed.origin), url: target,
    });
    let compiled;
    try {
      const { manifest, base: peerBase } = await fetchManifest(parsed.origin);
      // Fail closed: only run the exact published network that was requested, never a
      // different (e.g. networks[0]) one.
      const entry = manifest.networks.find((n) => n.name === lastSeg);
      if (!entry) {
        throw new Error(`No published network named '${lastSeg}' at ${hostOf(parsed.origin)}; refusing to run a different network.`);
      }
      const fetchedUrls = { manifest: `${peerBase}/agent-manifest.json`, hocon: resolveUrl(peerBase, entry.hocon) };
      compiled = await this._compile(peerBase, manifest, entry);
      compiled.base = peerBase;
      this.registry.set(parsed.origin, lastSeg, { base: peerBase, network: compiled.network, brand: manifest.brand });
      this.trace.end(fetchSpan, { network: compiled.network.name, fetchedUrls, peerOrigin: hostOf(parsed.origin), brand: manifest.brand });
      peerSpans.set(url, this.trace.start("remote_call", {
        parent: this.runSpan, origin: hostOf(this.top.base), peerOrigin: hostOf(peerBase),
        method: "fetch-and-run-locally", fetchedUrls, network: compiled.network.name, brand: manifest.brand,
        est: estimateRemoteCost({ network: compiled.network, requestText, model: this.modelOverride, mock: this.mockLLM }),
      }));
    } catch (err) {
      this.trace.fail(fetchSpan, err);
      throw err;
    }
    return { config: this._runnableConfig(compiled.network), name: compiled.network.name };
  }

  // Report each call to the active LLM router as a model_call span, labelled from
  // what the endpoint actually returned, so the header badge can never show a real
  // model for the mock. The calls themselves are neuro-san's; this observes them, and
  // enforces the BYOK guarantee (assertRouterKey) before each one goes out. Each
  // span hangs under the agent whose call it is, with the answer's text as it streams.
  _observeModelCalls() {
    if (this._observingModelCalls || typeof globalThis.fetch !== "function") return;
    this._observingModelCalls = true;
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url ?? input);
      const router = this.top?.llm?.baseUrl;
      const mcpCall = mcpToolCall(url, init);
      if (mcpCall) {
        const response = await originalFetch(input, init);
        this._watchMcpProgress(url, mcpCall, response);
        return response;
      }
      // Chat completions, or the Responses API that neuro-san uses for OpenAI models.
      const base = router ? router.replace(/\/$/, "") : "";
      if (!router || !(url.startsWith(base + "/chat/completions") || url.startsWith(base + "/responses"))) {
        return originalFetch(input, init);
      }
      assertRouterKey(this.top.llm, this.byokKey);
      let body = null;
      try { body = JSON.parse(init?.body || "{}"); } catch {}
      const caller = body ? this._modelCaller(body) : null;
      const agentSpan = caller ? this._openAgentSpan(caller) : null;
      if (agentSpan) this.toolCaller = agentSpan;
      const batch = caller ? this._newToolBatch(caller) : null;
      // An unreadable response asks for no tools, so nothing waits on it.
      const settle = (read) => batch?.resolve(read ? functionCallNames(read.text) : []);
      // A static bundle's mock answers here, with no server to send the call to.
      const send = router === BROWSER_MOCK_ROUTER ? async () => browserMockResponse(url, body || {}) : originalFetch;
      // Only the top front man is steered. Work already handed to tools and other
      // agents finishes as it is, so nothing runs twice.
      if (caller?.isTopFrontMan && this.turnControl && body) {
        return this._steerableModelCall(send, input, init, body, agentSpan, settle);
      }
      const span = this._startModelCall(body, agentSpan);
      let response;
      try {
        response = await send(input, init);
      } catch (err) {
        settle(null);
        this.trace.fail(span, err);
        throw err;
      }
      // neuro-san reads the response as it streams; a copy of it fills in the span.
      this._readModelResponse(response.clone(), span, init?.signal).then(
        (read) => { settle(read); this._endModelCall(span, response, body, read.model); },
        (err) => { settle(null); this.trace.fail(span, err); },
      );
      return response;
    };
  }

  // A new batch for the caller's next model response: the tool calls it asks for,
  // once it is read.
  _newToolBatch(caller) {
    let resolve;
    const batch = { names: null, ready: new Promise((done) => { resolve = done; }), active: 0, waiting: [], taken: [] };
    batch.resolve = (names) => { batch.names = batch.names || names; resolve(batch.names); };
    this.toolBatches.set(`${caller.network}::${caller.agent}`, batch);
    return batch;
  }

  // Runs one of an agent's tool calls, as main's executeToolCalls does: sibling calls
  // from one model response run at the same time, up to MAX_PARALLEL_TOOLS, and in
  // the model's order when one of them isn't safe to run alongside the others
  // (parallel_safe = false, or a REST tool that changes something). neuro-san's own
  // loop starts all of them at once, so this holds back the ones over the limit.
  async _scheduleTool(caller, tool, run, ref = "") {
    // resolvePeer only gets the partner's URL, so it finds the agent that called it here.
    if (/^https?:\/\//.test(ref) && !/\/mcp$/.test(new URL(ref).pathname)) {
      if (!this.peerCallers.has(ref)) this.peerCallers.set(ref, []);
      this.peerCallers.get(ref).push(this._callerSpan(caller));
    }
    const batch = this.toolBatches.get(`${caller.network}::${caller.agent}`);
    if (!batch) return run();
    const names = await batch.ready;
    if (batch.limit == null) {
      const network = this.networksByName.get(caller.network);
      const safe = names.every((name) => toolAllowsParallel(network?.getAgentSpec(name)));
      batch.limit = safe ? Math.max(1, Math.min(MAX_PARALLEL_TOOLS, names.length)) : 1;
    }
    // Its place in the model's list, so the ones held back go in that order.
    let index = names.findIndex((name, i) => name === tool && !batch.taken[i]);
    if (index < 0) index = names.length + batch.taken.length;
    batch.taken[index] = true;
    if (batch.active >= batch.limit) {
      await new Promise((start) => {
        batch.waiting.push({ index, start });
        batch.waiting.sort((a, b) => a.index - b.index);
      });
    } else {
      batch.active += 1;
    }
    try {
      return await run();
    } finally {
      const next = batch.waiting.shift();
      if (next) next.start();
      else batch.active -= 1;
    }
  }

  // An MCP server can send notifications (progress, log messages) in a tool call's
  // response stream before its result. Each one goes on the trace as tool_progress,
  // under that call's tool span, while the MCP client reads the result as usual.
  _watchMcpProgress(url, { tool }, response) {
    if (!/text\/event-stream/i.test(response.headers.get("content-type") || "") || !response.body) return;
    // The MCP client sends its requests in the order the calls start, so this response
    // is for the first running call to this server and tool that has none yet.
    const target = new URL(url);
    let key = null;
    for (const [callId, call] of this.mcpCalls) {
      if (call.response || call.tool !== tool) continue;
      try {
        const known = new URL(call.url);
        if (known.origin !== target.origin || known.pathname !== target.pathname) continue;
      } catch {
        continue;
      }
      call.response = true;
      key = `mcp::${callId}`;
      break;
    }
    const parent = (key && this.toolSpans.get(key)) || this.runSpan;
    readSseEvents(response.clone(), (message) => {
      if (!message || "result" in message || "error" in message || !message.method) return;
      const params = message.params || {};
      this.trace.note("tool_progress", {
        parent, peerOrigin: hostOf(url), tool, toolKind: "MCP", method: message.method,
        progress: params.progress ?? params.data ?? params,
        message: params.message || params.data?.message || (typeof params.data === "string" ? params.data : ""),
      });
    }).catch(() => {});
  }

  _startModelCall(body, agentSpan) {
    return this.trace.start("model_call", {
      parent: agentSpan || this.runSpan, origin: hostOf(this.top.base), via: hostOf(this.top.llm.baseUrl), model: body?.model || "",
    });
  }

  // Reads a model call's response to its end, adding each piece of streamed text to
  // the span. Returns the whole text, and the model the endpoint says answered.
  async _readModelResponse(response, span, signal) {
    let text = "";
    if (!response.body) return { text, model: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const cancel = () => reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        text += chunk;
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          const delta = streamedText(line);
          if (delta && !signal?.aborted) this.trace.update(span, { streamChunk: delta });
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    return { text, model: (text.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || "" };
  }

  _endModelCall(span, response, body, model = "") {
    const route = response.headers.get("X-Nsdeploy-LLM-Route") || "";
    const answered = model || body?.model || "";
    if (response.ok) {
      this.trace.end(span, { model: answered, mock: isMockResponse(this.top?.llm?.mock, route, answered), status: "ok" });
    } else {
      this.trace.fail(span, new Error(`LLM router returned ${response.status}`));
    }
  }

  // The top front man's model call while the user can still steer the turn. Steering
  // that is waiting goes in as user messages, and steering that arrives during the
  // call cancels it and makes it again with the new messages. Each message stays at
  // the place it went in, in every later call of this turn, so neuro-san's own
  // history and the user's guidance stay in order. neuro-san gets the response once
  // the call is settled, so it never sees a cancelled one.
  async _steerableModelCall(originalFetch, input, init, body, agentSpan, settle) {
    try {
      const { response, read } = await this._steeredModelCall(originalFetch, input, init, body, agentSpan);
      settle(read);
      return response;
    } catch (err) {
      settle(null);
      throw err;
    }
  }

  async _steeredModelCall(originalFetch, input, init, body, agentSpan) {
    const control = this.turnControl;
    const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : null;
    if (!items) {
      const span = this._startModelCall(body, agentSpan);
      const response = await originalFetch(input, init);
      const read = await this._readModelResponse(response.clone(), span);
      this._endModelCall(span, response, body, read.model);
      return { response, read };
    }
    const responses = Array.isArray(body.input);
    for (;;) {
      const sent = steeredItems(items, this.steeringAt, responses);
      applyPendingSteering(control, (text) => {
        this.steeringAt.push({ at: items.length, text });
        sent.push(steeringItem(text, responses));
      });
      const request = { ...body, [responses ? "input" : "messages"]: sent };
      const span = this._startModelCall(request, agentSpan);
      let response = null;
      let read = null;
      try {
        const attempt = await runInterruptibleModelCall(control, async (signal) => {
          // neuro-san's own signal still cancels the call too.
          const both = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
          response = await originalFetch(input, { ...init, body: JSON.stringify(request), signal: both });
          read = await this._readModelResponse(response.clone(), span, both);
          return response;
        });
        if (attempt.interrupted) {
          this.trace.end(span, { status: "steered", interrupted: true });
          continue;
        }
      } catch (err) {
        this.trace.fail(span, err);
        throw err;
      }
      this._endModelCall(span, response, request, read?.model);
      // Guidance that arrived as the answer finished goes in before it's used.
      if (control.pending.length) continue;
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return { response: new Response(read?.text ?? "", { status: response.status, statusText: response.statusText, headers }), read };
    }
  }

  // Who a model call is for, from the instructions it sends.
  _modelCaller(body) {
    const system = [];
    if (typeof body.instructions === "string") system.push(body.instructions);
    for (const item of Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : []) {
      if (item?.role === "system" || item?.role === "developer") system.push(contentText(item.content));
    }
    const prompt = system.join("\n");
    let best = null;
    for (const [instructions, caller] of this.agentPrompts) {
      if (prompt.includes(instructions) && (!best || instructions.length > best.instructions.length)) best = { instructions, caller };
    }
    return best?.caller || null;
  }

  // The span of the agent making a tool call: the one its origin path names, which is
  // how the streamed messages name it too.
  _callerSpan(caller) {
    const path = (caller.origin || []).map((o) => `${o.tool}#${o.instantiation_index ?? ""}`).join("/");
    return this.agentSpans.get(path)?.span || this._openAgentSpan(caller) || this.toolCaller || this.runSpan;
  }

  // The newest open agent span of this run for the caller.
  _openAgentSpan(caller) {
    let found = null;
    for (const entry of this.agentSpans.values()) {
      if (!entry.ended && entry.agent === caller.agent && entry.network === caller.network) found = entry.span;
    }
    return found;
  }

  // A tool call's span, under the agent that asked for it, for the turn's event
  // stream. `key` is how the end finds it.
  _startTool(key, { tool, toolKind, args, parent }) {
    if (!this.runSpan || this.toolSpans.has(key)) return;
    this.toolSpans.set(key, this.trace.start("tool", {
      parent: parent || this.toolCaller || this.runSpan, origin: hostOf(this.top.base),
      tool, callId: key, toolKind, args,
    }));
  }

  _endTool(key, { result, error } = {}) {
    const span = this.toolSpans.get(key);
    if (!span) return;
    this.toolSpans.delete(key);
    if (error) {
      const message = String(error?.message || error);
      this.trace.end(span, { status: "error", error: message, resultPreview: message.slice(0, 240) });
    } else {
      this.trace.end(span, { resultPreview: String(result ?? "").slice(0, 240) });
    }
  }

  async run(userText, { slyData } = {}) {
    return (await this.runTurn(userText, { slyData })).text;
  }

  // Public incremental API. Consumers receive typed lifecycle events while the
  // existing runTurn() API remains a single final-result Promise.
  streamTurn(userText, options = {}) {
    const streamToken = `turn-stream-${++this.streamSequence}`;
    const turnControl = new TurnControl();
    const stream = createTurnEventStream(
      this.trace,
      () => this.runTurn(userText, { ...options, _streamToken: streamToken, _turnControl: turnControl }),
      streamToken,
    );
    // AsyncIterable with an intentionally small imperative side-channel. Input
    // is accepted only until this turn closes; callers can use the boolean to
    // fall back to starting a normal follow-up turn after a completion race.
    stream.steer = (text) => turnControl.steer(text);
    return stream;
  }

  async runTurn(userText, { slyData, interaction, _streamToken, _turnControl } = {}) {
    if (!this.top) await this.loadTop();
    const runSpan = this.trace.start("run", { origin: hostOf(this.top.base), input: userText, streamToken: _streamToken });
    this.runSpan = runSpan;
    _turnControl?.attach(this.trace, runSpan);
    this.turnControl = _turnControl || null;
    this.steeringAt = [];
    this.agentSpans = new Map();
    this.toolSpans = new Map();
    this.toolCaller = null;
    this.peerCallers = new Map();
    this.composition = {
      remoteCalls: 0,
      peerCalls: new Map(),
      maxRemoteCalls: 4,
      maxCallsPerPeer: 1,
      agentCalls: 0,
      maxAgentCalls: 24,
      deadline: Date.now() + 90_000,
    };
    try {
      assertRouterKey(this.top.llm, this.byokKey);
      const session = neuroSanSession();
      session.setEnv({
        OPENAI_API_KEY: this.byokKey || "demo",
        OPENAI_BASE_URL: this.top.llm.baseUrl,
      });
      const network = this.top.network;
      const loop = session.createSession(this._runnableConfig(network), network.name);
      const request = {
        user_message: { type: ChatMessageType.HUMAN, text: interactionMessage(userText, interaction) },
        sly_data: withLlmKey(slyData, this.byokKey),
        // MAXIMAL so the trace can show every agent's messages; the answer is the final
        // AGENT_FRAMEWORK message either way.
        chat_filter: { chat_filter_type: "MAXIMAL" },
      };
      if (this.chatContext) request.chat_context = this.chatContext;
      let answer = "";
      for await (const chatResponse of loop.streaming_chat(request)) {
        const message = chatResponse?.response;
        if (!message) continue;
        this._traceMessage(message);
        if (message.type === ChatMessageType.AGENT_FRAMEWORK && message.chat_context) {
          answer = String(message.text ?? "");
          this.chatContext = message.chat_context;
        }
      }
      // Steering is accepted until here, so later turns see all of it.
      _turnControl?.close();
      this.chatContext = withSteering(this.chatContext, network.findFrontMan(), _turnControl?.accepted || []);
      for (const entry of this.agentSpans.values()) if (!entry.ended) this.trace.end(entry.span, {});
      for (const key of [...this.toolSpans.keys()]) this._endTool(key);
      // The answer's text for the chat, and the presentation the UI renders, if the
      // front man proposed one (see cruse.js).
      const result = parseAgentResponse(answer, {
        origin: hostOf(this.top.base), network: network.name, agent: network.findFrontMan(), invocation: runSpan,
      });
      result.turnId = runSpan;
      this.trace.end(runSpan, { answerPreview: result.text.slice(0, 300) });
      return result;
    } catch (err) {
      this.trace.fail(runSpan, err);
      throw err;
    } finally {
      _turnControl?.close();
      this.turnControl = null;
      this.runSpan = null;
    }
  }

  // One streamed neuro-san message, as trace events. An agent (by its origin path)
  // starts the first time it speaks, as a "tool" call of the agent above it, and
  // finishes with its AI message, its answer. Each tool result is noted too. An agent
  // with no caller in this run (a partner's front man) hangs under `parent`.
  _traceMessage(message, parent = this.runSpan) {
    const origin = Array.isArray(message.origin) ? message.origin : [];
    const tools = origin.map((o) => o.tool);
    const path = origin.map((o) => `${o.tool}#${o.instantiation_index ?? ""}`).join("/");
    const agent = tools.length ? tools[tools.length - 1] : null;
    const peerRef = tools.find((tool) => typeof tool === "string" && /^https?:\/\//.test(tool));
    const where = peerRef ? hostOf(peerRef) : hostOf(this.top.base);
    const network = peerRef ? parseExternalAgent(peerRef)?.agentName : this.top.network.name;
    // A partner network's URL in the path is its call, which resolvePeer traces.
    const isPeerCall = typeof agent === "string" && /^https?:\/\//.test(agent);
    if (agent && !isPeerCall && !this.agentSpans.has(path)) {
      const parentPath = path.split("/").slice(0, -1).join("/");
      const caller = this.agentSpans.get(parentPath);
      const isTopFrontMan = tools.length === 1 && agent === this.top.network.findFrontMan();
      if (caller) this._startTool(`agent::${path}`, { tool: agent, toolKind: "agent", parent: caller.span });
      this.agentSpans.set(path, {
        agent, network, ended: false,
        span: this.trace.start("agent", {
          parent: this.toolSpans.get(`agent::${path}`) || parent || this.runSpan, origin: where, agent, network,
          invocation: path, isTopFrontMan,
        }),
      });
    }
    const entry = this.agentSpans.get(path);
    if (message.type === ChatMessageType.AGENT_TOOL_RESULT) {
      this.trace.note("tool_result", {
        parent: entry?.span || this.runSpan, origin: where, tool: agent,
        preview: String(message.text ?? "").slice(0, 200), type: ChatMessageType.AGENT_TOOL_RESULT,
      });
    }
    if (message.type === ChatMessageType.AI && entry && !entry.ended) {
      const text = String(message.text ?? "");
      entry.ended = true;
      // Each agent's presentation, as main's runAgent records it: the developer view
      // shows it and its validation issues, but only the front man's reaches the chat.
      const proposal = parseAgentResponse(text, { origin: where, network, agent, invocation: path });
      this.trace.note("presentation_proposal", {
        parent: entry.span, origin: where, network, agent, invocation: path,
        presentation: proposal.presentation, issues: proposal.presentationIssues,
      });
      this.trace.note("agent_result", {
        parent: entry.span, origin: where, network, agent, invocation: path, text,
      });
      this.trace.end(entry.span, { answerChars: text.length });
      this._endTool(`agent::${path}`, { result: text });
    }
  }
}

// The chat_context with this turn's steering in the front man's history, right
// after the turn's own message, so the next turn knows the user said it.
function withSteering(chatContext, frontMan, accepted) {
  if (!accepted.length || !chatContext?.chat_histories) return chatContext;
  const context = structuredClone(chatContext);
  for (const history of context.chat_histories) {
    const origin = history.origin || [];
    if (origin.length !== 1 || origin[0].tool !== frontMan || !Array.isArray(history.messages)) continue;
    let at = -1;
    history.messages.forEach((message, index) => { if (message.type === ChatMessageType.HUMAN) at = index; });
    if (at < 0) continue;
    const added = accepted.map((input) => ({ type: ChatMessageType.HUMAN, origin, text: input.text }));
    history.messages.splice(at + 1, 0, ...added);
  }
  return context;
}

// A network's llm_config can ask for its key from the request instead of the
// environment ("openai_api_key": "sly_data", common in fallbacks), and neuro-san then
// reads it from sly_data.llm_config. The BYOK key is put there too, so those networks
// run on it as well. The key never leaves this browser: partner networks run here, and
// neuro-san's own redaction decides what sly_data they see.
function withLlmKey(slyData, apiKey) {
  const out = { ...(slyData || {}) };
  out.llm_config = { ...(out.llm_config || {}), openai_api_key: apiKey || "demo" };
  return out;
}

// The text of a message's content, which is a string or a list of parts.
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => String(part?.text ?? "")).join("");
  return "";
}

// The text one line of a streamed model response adds, for the Responses API and
// chat completions alike.
function streamedText(line) {
  if (!line.startsWith("data:")) return "";
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const event = JSON.parse(payload);
    if (event.type === "response.output_text.delta") return String(event.delta || "");
    return String(event.choices?.[0]?.delta?.content || "");
  } catch {
    return "";
  }
}

// How many of an agent's sibling tool calls run at once, as in main.
const MAX_PARALLEL_TOOLS = 4;

// Whether a tool can run alongside its siblings: not when its spec says
// parallel_safe = false, and for a REST (toolbox) tool only when it only reads (GET).
function toolAllowsParallel(spec) {
  if (!spec) return true;
  if (spec.parallel_safe === false || spec.execution?.parallel_safe === false) return false;
  if (spec.toolbox != null) return String(spec.args?.method || "GET").toUpperCase() === "GET";
  return true;
}

// The tools a model response calls, in the model's order: from the Responses API or
// chat completions, whole or streamed.
function functionCallNames(text) {
  const names = [];
  const fromResponse = (response) => {
    for (const item of response?.output || []) if (item?.type === "function_call" && item.name) names.push(item.name);
  };
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{")) {
    try {
      const body = JSON.parse(trimmed);
      fromResponse(body);
      for (const call of body.choices?.[0]?.message?.tool_calls || []) if (call?.function?.name) names.push(call.function.name);
    } catch {}
    return names;
  }
  const streamed = [];
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (event.type === "response.completed") {
      names.length = 0;
      fromResponse(event.response);
      return names;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") names.push(event.item.name);
    for (const call of event.choices?.[0]?.delta?.tool_calls || []) {
      if (call?.function?.name) streamed[call.index ?? streamed.length] = call.function.name;
    }
  }
  return names.length ? names : streamed.filter(Boolean);
}

// The MCP tool a request calls, when it is an MCP tools/call.
function mcpToolCall(url, init) {
  if (init?.method !== "POST" || typeof init.body !== "string") return null;
  try {
    if (!new URL(url).pathname.endsWith("/mcp")) return null;
    const message = JSON.parse(init.body);
    return message?.method === "tools/call" && message.params?.name ? { tool: String(message.params.name) } : null;
  } catch {
    return null;
  }
}

// Calls onEvent with each JSON event of a server-sent event stream, as it arrives.
async function readSseEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0 || (done && buffer.trim())) {
      const block = boundary >= 0 ? buffer.slice(0, boundary) : buffer;
      buffer = boundary >= 0 ? buffer.slice(boundary + 2) : "";
      const payload = block.split("\n")
        .filter((line) => line.trimStart().startsWith("data:"))
        .map((line) => line.slice(line.indexOf(":") + 1).trimStart())
        .join("\n");
      try { if (payload) onEvent(JSON.parse(payload)); } catch {}
    }
    if (done) return;
  }
}

// A steering message, shaped like the user messages neuro-san sends.
function steeringItem(text, responses) {
  return responses ? { type: "message", role: "user", content: text } : { role: "user", content: text };
}

// The messages with this turn's steering put back where each went in.
function steeredItems(items, steeringAt, responses) {
  const out = [...items];
  let shift = 0;
  for (const { at, text } of steeringAt) {
    if (at > items.length) continue;
    out.splice(at + shift, 0, steeringItem(text, responses));
    shift += 1;
  }
  return out;
}

// An unlinked link slot, until the developer links it: resolvePeer asks for the URL.
const LINK_SLOT_PREFIX = "https://nsdeploy-link-slot.invalid/";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
