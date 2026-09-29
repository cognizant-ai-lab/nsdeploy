// engine.js: load a published network from an origin, compile it, and run it on
// neuro-san's own agent loop.
//
// The loop is neuro-san's DirectAgentSession, from @cognizant-ai-lab/neuro-san-npm
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

import { parseHocon } from "./hocon.js";
import {
  AgentNetwork, ChatMessageType, initKernel, loadNeuroSan, parseExternalAgent, redactSlyData, validateNetwork,
} from "./kernel.js";
import { neuroSanSession } from "./generated-bridge.js";
import { TraceBus } from "./trace.js";
import { fetchManifest, fetchText, resolveUrl, RemoteRegistry } from "./remote.js";
import { argsToText, consumeRemoteBudget, estimateRemoteCost, peerRequestText, remoteIsInChain } from "./composition.js";
import { agentPresentationContext, interactionMessage, parseAgentResponse } from "./cruse.js";
import { isMockResponse, normalizeModelName } from "./model.js";

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

// BYOK guarantee: a real (non-mock) router is never contacted without a key the
// visitor entered. Refuse rather than forward the placeholder "demo" to a live
// provider (which returns a confusing 401). This happens e.g. when a shared/reloaded
// URL keeps the proxy router but no saved BYOK profile/key is available here.
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
    this.onConsent = null; // UI hook: async (info) => "allow"|"always"|"decline"
    this.onLinkRequired = null; // UI hook: async ({reference,...}) => peer URL|null
    this.runtimeAllowedPeers = new Set(); // user-entered, validated link origins
    this.refOwners = new Map(); // tool reference URL -> the network (and site) that declares it
    this.composition = null; // this query's composition budget
    this.runSpan = null;
  }

  // Start a new chat.
  resetHistory() {
    this.chatContext = null;
  }

  // Ask the user to approve contacting another hosted network. Remembers
  // "always" per origin; defaults to allow when no UI hook is attached (headless).
  async requestConsent(info) {
    if (this.consent.get(info.peerOrigin) === "always") return "allow";
    if (typeof this.onConsent !== "function") return "allow";
    const decision = await this.onConsent(info);
    if (decision === "always") { this.consent.set(info.peerOrigin, "always"); return "allow"; }
    return decision || "allow";
  }

  // Compile the origin's own published front network.
  async loadTop() {
    await loadNeuroSan();
    initKernel();
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
  // OPENAI_BASE_URL), and link slots become partner URLs. A slot not linked yet
  // becomes LINK_SLOT_PREFIX + its name, which resolvePeer turns into a request for
  // the developer to link it.
  _runnableConfig(network) {
    const config = structuredClone(network.config);
    const override = this.modelOverride ? { model_name: this.modelOverride } : {};
    const llmConfig = (agentConfig) => ({ ...(agentConfig || {}), class: "openai", ...override });
    config.llm_config = llmConfig(config.llm_config);
    // CRUSE's presentation context for each agent (see cruse.js): whether its
    // presentation reaches the user or is a proposal for the agent that called it.
    const presentationContext = { network, isTop: network === this.top?.network, frontMan: network.findFrontMan() };
    for (const agent of config.tools || []) {
      if (agent.llm_config || !agent.class) agent.llm_config = llmConfig(agent.llm_config);
      const context = agent.name ? agentPresentationContext(presentationContext, agent.name) : "";
      if (context && typeof agent.instructions === "string") agent.instructions = `${agent.instructions}\n\n${context}`;
      if (!Array.isArray(agent.tools)) continue;
      agent.tools = agent.tools.map((ref) => {
        if (typeof ref !== "string" || !network.linkSlots.has(ref)) return ref;
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
    session.setHooks({
      mcpConsent: async ({ url }) => {
        const owner = this.refOwners.get(url);
        try {
          this._assertAllowedPeer(url, owner?.manifest);
        } catch (err) {
          this.trace.note("consent", { parent: this.runSpan, origin: hostOf(owner?.base || this.top.base), peerOrigin: hostOf(url), phase: "discover", decision: "blocked", reason: err.message });
          return false;
        }
        // Discovering MCP tools (initialize, tools/list) IS contact with the server, so
        // it waits for consent; declining means the agent runs without these tools.
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
      mcpCall: async ({ url, tool, args }) => {
        // Discovery consent never silently authorizes execution: the call itself is
        // confirmed with the real payload, unless the origin is "always" allowed.
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
        mcpSpans.set(`${url}::${tool}`, this.trace.start("mcp_call", {
          parent: this.runSpan, origin: hostOf(this.top.base), peerOrigin: hostOf(url), tool, requestPayload: args,
        }));
        return null;
      },
      mcpResult: ({ url, tool, result, error }) => {
        const key = `${url}::${tool}`;
        const span = mcpSpans.get(key);
        mcpSpans.delete(key);
        if (!span) return;
        if (error) this.trace.fail(span, error);
        else this.trace.end(span, { responsePreview: String(result ?? "").slice(0, 300) });
      },
      resolvePeer: (url, { chain, request }) => this._resolvePeer(url, chain, request, peerSpans),
      peerDone: ({ url, error }) => {
        const span = peerSpans.get(url);
        peerSpans.delete(url);
        if (!span) return;
        if (error) this.trace.fail(span, error);
        else this.trace.end(span, { type: ChatMessageType.AGENT });
      },
      // A partner's answer goes back to the agent that called it as CRUSE's
      // {cruse, text, presentation} (see cruse.js), so its presentation is a proposal
      // the caller consolidates, never shown to the user directly.
      peerAnswer: ({ url, text }) => {
        const owner = this.refOwners.get(url);
        const agentName = parseExternalAgent(url, owner?.base)?.agentName;
        const source = { origin: hostOf(url), network: agentName, agent: agentName, invocation: `peer-${agentName}` };
        const result = parseAgentResponse(text, source);
        this.trace.note("presentation_proposal", {
          parent: this.runSpan, ...source, presentation: result.presentation, issues: result.presentationIssues,
        });
        return JSON.stringify(result);
      },
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
    // Consent precedes any contact with the partner, so the estimate is coarse: the
    // partner has not been fetched yet.
    const requestText = peerRequestText(request) || "(the request your agent is sending)";
    const decision = await this.requestConsent({
      kind: "network", peerLabel: label, peerOrigin: hostOf(target), requestText,
      est: { totalTokens: Math.round((requestText.length + 300) / 4) * 2, costText: this.mockLLM ? "$0.00 (mock)" : null },
    });
    if (decision === "decline") {
      this.trace.note("consent", { parent: this.runSpan, origin: hostOf(base), peerOrigin: hostOf(target), decision: "declined" });
      return { answer: `The user declined to contact ${hostOf(target)}. Proceed without it and note that to the user.` };
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
  // enforces the BYOK guarantee (assertRouterKey) before each one goes out.
  _observeModelCalls() {
    if (this._observingModelCalls || typeof globalThis.fetch !== "function") return;
    this._observingModelCalls = true;
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = String(input?.url ?? input);
      const router = this.top?.llm?.baseUrl;
      // Chat completions, or the Responses API that neuro-san uses for OpenAI models.
      const base = router ? router.replace(/\/$/, "") : "";
      if (!router || !(url.startsWith(base + "/chat/completions") || url.startsWith(base + "/responses"))) {
        return originalFetch(input, init);
      }
      assertRouterKey(this.top.llm, this.byokKey);
      let requested = "";
      try { requested = JSON.parse(init?.body || "{}").model || ""; } catch {}
      const span = this.trace.start("model_call", { parent: this.runSpan, origin: hostOf(this.top.base), via: hostOf(router), model: requested });
      try {
        const response = await originalFetch(input, init);
        const route = response.headers.get("X-Nsdeploy-LLM-Route") || "";
        let model = requested;
        try {
          const text = await response.clone().text();
          model = (text.match(/"model"\s*:\s*"([^"]+)"/) || [])[1] || requested;
        } catch {}
        if (response.ok) {
          this.trace.end(span, { model, mock: isMockResponse(this.top?.llm?.mock, route, model), status: "ok" });
        } else {
          this.trace.fail(span, new Error(`LLM router returned ${response.status}`));
        }
        return response;
      } catch (err) {
        this.trace.fail(span, err);
        throw err;
      }
    };
  }

  async run(userText, { slyData } = {}) {
    return (await this.runTurn(userText, { slyData })).text;
  }

  async runTurn(userText, { slyData, interaction } = {}) {
    if (!this.top) await this.loadTop();
    const runSpan = this.trace.start("run", { origin: hostOf(this.top.base), input: userText });
    this.runSpan = runSpan;
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
      const agentSpans = new Map();
      for await (const chatResponse of loop.streaming_chat(request)) {
        const message = chatResponse?.response;
        if (!message) continue;
        this._traceMessage(message, agentSpans);
        if (message.type === ChatMessageType.AGENT_FRAMEWORK && message.chat_context) {
          answer = String(message.text ?? "");
          this.chatContext = message.chat_context;
        }
      }
      for (const span of agentSpans.values()) this.trace.end(span, {});
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
      this.runSpan = null;
    }
  }

  // One streamed neuro-san message, as trace events: an "agent" span for each agent
  // (by its origin path) the first time it speaks, and each tool result.
  _traceMessage(message, agentSpans) {
    const origin = Array.isArray(message.origin) ? message.origin : [];
    const path = origin.map((o) => o.tool).join("/");
    const agent = origin.length ? origin[origin.length - 1].tool : null;
    const peerRef = origin.map((o) => o.tool).find((tool) => typeof tool === "string" && /^https?:\/\//.test(tool));
    const where = peerRef ? hostOf(peerRef) : hostOf(this.top.base);
    if (agent && !agentSpans.has(path)) {
      agentSpans.set(path, this.trace.start("agent", {
        parent: this.runSpan, origin: where, agent, network: peerRef ? parseExternalAgent(peerRef)?.agentName : this.top.network.name,
      }));
    }
    if (message.type === ChatMessageType.AGENT_TOOL_RESULT) {
      this.trace.note("tool_result", {
        parent: agentSpans.get(path) || this.runSpan, origin: where, tool: agent,
        preview: String(message.text ?? "").slice(0, 200), type: ChatMessageType.AGENT_TOOL_RESULT,
      });
    }
  }
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

// An unlinked link slot, until the developer links it: resolvePeer asks for the URL.
const LINK_SLOT_PREFIX = "https://nsdeploy-link-slot.invalid/";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
