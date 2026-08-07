// engine.js — top-level orchestration: load a published network from an origin,
// compile it (HOCON -> filter chain -> validate -> AgentNetwork), and run it. Owns
// the intrinsics (LLM client, sandbox, trace) and implements resolveRemote, the
// fetch-and-run-locally bridge that turns a peer URL into a runnable Session.

import { parseHocon } from "./hocon.js";
import { AgentNetwork, validateNetwork, parseExternalAgent, redactSlyData, ChatMessageType } from "./kernel.js";
import { LlmClient } from "./llm.js";
import { ToolSandbox } from "./sandbox.js";
import { TraceBus } from "./trace.js";
import { fetchManifest, fetchText, resolveUrl, RemoteRegistry } from "./remote.js";
import { runAgent } from "./runner.js";
import { McpClient } from "./mcp.js";

export class Engine {
  constructor({ originUrl, trace, sandboxWorkerUrl, byokKey, routerOverride } = {}) {
    this.originUrl = (originUrl || (typeof location !== "undefined" ? location.origin : "")).replace(/\/$/, "");
    this.trace = trace || new TraceBus();
    this.sandboxWorkerUrl = sandboxWorkerUrl || "/runtime/sandbox-worker.js";
    this.byokKey = byokKey || "";
    this.routerOverride = routerOverride || "";
    this.modelOverride = (arguments[0] && arguments[0].modelOverride) || "";
    this.registry = new RemoteRegistry({ trace: this.trace });
    this.sandbox = new ToolSandbox({ workerUrl: this.sandboxWorkerUrl, trace: this.trace });
    this.top = null; // {network, base, bundleUrl, manifest, llm}
    this.agentRunner = null; // set by enableLangChain(); neuro-san-web owns the loop
    this.history = []; // top-level conversation turns ([{role,content}]) across runs
    this.consent = new Map(); // peerOrigin -> "always" (remembered approvals)
    this.onConsent = null; // UI hook: async (info) => "allow"|"always"|"decline"
    this.onLinkRequired = null; // UI hook: async ({reference,...}) => peer URL|null
    this.runtimeAllowedPeers = new Set(); // user-entered, validated link origins
  }

  // Clear the multi-turn conversation history (start a new chat).
  resetHistory() {
    this.history = [];
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

  // Load the prebuilt LangChain.js AgentRunner bundle and use it as the loop.
  async enableLangChain() {
    const mod = await import("./generated/agent-runner.bundle.js");
    this.agentRunner = mod.runAgentLangChain || mod.default;
    return this.agentRunner;
  }

  // Compile the origin's own published front network.
  async loadTop() {
    const span = this.trace.start("compile", { origin: hostOf(this.originUrl), what: "top network" });
    try {
      const { manifest, base } = await fetchManifest(this.originUrl);
      const entry = manifest.networks[0];
      // Set manifest early so resolveRemote/resolveMcp policy checks have it.
      this.top = { manifest, base };
      const { network, bundleUrl, integrity, llm, validation: v } = await this._compile(base, manifest, entry, { isTop: true });
      this.top = { network, base, bundleUrl, integrity, manifest, llm };
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
    // Validation gate: a network with structural errors must never run. (Warnings
    // are non-fatal and surfaced in the trace/UI.) This applies to the top network
    // AND to every fetched-and-run peer network compiled below.
    const validation = validateNetwork(network);
    if (validation.errors && validation.errors.length) {
      throw new Error(`Network '${network.name}' (${hostOf(base)}) failed validation: ${validation.errors.join("; ")}`);
    }
    const bundleUrl = manifest.coded_tools?.bundle ? resolveUrl(base, manifest.coded_tools.bundle) : null;
    const integrity = manifest.coded_tools?.integrity || null; // optional SRI digest
    // Router selection guards the BYOK key. The user's key may ONLY be sent to a
    // router the user approved: an explicit override, or the TOP origin's router
    // (the site the user chose to visit). A PEER manifest's llm_router.base_url is
    // untrusted — a malicious peer must not be able to redirect the key to its own
    // server — so it is used only when there is no real key (nothing to leak).
    const hasRealKey = !!(this.byokKey && this.byokKey !== "demo");
    let routerBase;
    let mock;
    if (this.routerOverride) {
      routerBase = this.routerOverride;
      mock = false;
    } else if (isTop) {
      routerBase = manifest.llm_router?.base_url;
      mock = manifest.llm_router?.mock === true;
      this.userRouter = { baseUrl: routerBase, mock }; // remember for peer calls
    } else if (hasRealKey) {
      // Peer + real key: the key may go ONLY to a user-approved router (override or
      // the top site's), NEVER the peer's own llm_router. If no approved router
      // exists, fail closed — do not fall back to the peer-chosen URL.
      if (!this.userRouter?.baseUrl) {
        throw new Error(`Refusing to run ${hostOf(base)} with your API key: no user-approved LLM router is configured (the top site declared none and you set no override). Set a router in BYOK settings.`);
      }
      routerBase = this.userRouter.baseUrl;
      mock = this.userRouter.mock ?? false;
    } else {
      routerBase = manifest.llm_router?.base_url;
      mock = manifest.llm_router?.mock === true;
    }
    const llm = new LlmClient({ baseUrl: routerBase, apiKey: this.byokKey, trace: this.trace, mock });
    return { network, bundleUrl, integrity, llm, hoconUrl, validation };
  }

  // Policy gate: a network may only fetch-and-run / call peers whose origin is
  // declared in the TOP manifest's `allowed_peers`. Fails closed otherwise — so a
  // fetched peer can't pull in arbitrary third origins, and a hostile/typo'd URL
  // is refused before anything is fetched.
  _assertAllowedPeer(target) {
    const norm = (u) => { try { return new URL(u).origin; } catch { return String(u || ""); } };
    const allowed = (this.top?.manifest?.allowed_peers || []).map(norm);
    if (!allowed.includes(norm(target)) && !this.runtimeAllowedPeers.has(norm(target))) {
      throw new Error(`Policy: ${hostOf(target)} is not in this network's allowed_peers; refusing to contact it.`);
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

  _makeCtx({ network, base, bundleUrl, integrity, llm, slyData, chain, isTop, history }) {
    const self = this;
    const ctx = {
      network,
      baseOrigin: base,
      displayOrigin: hostOf(base),
      codedToolBundleUrl: bundleUrl,
      codedToolIntegrity: integrity || null,
      llm,
      sandbox: this.sandbox,
      trace: this.trace,
      slyData,
      // Prior conversation turns ([{role,content}]), only for the top front-man.
      history: history || [],
      defaultModel: network.config.llm_config?.model_name || "mock-1",
      isTop: !!isTop,
      frontMan: network.findFrontMan(),
      onAnswerDelta: isTop ? (t) => self.onAnswerDelta?.(t) : undefined,
      resolveRemote: (ref, callChain, parentSpan) => self.resolveRemote(ref, callChain || chain, parentSpan),
      resolveMcp: (ref, parentSpan) => self.resolveMcp(ref, parentSpan, slyData),
      resolveLink: (ref, parentSpan) => self.resolveLink(ref, network, base, parentSpan),
      requestConsent: (info) => self.requestConsent(info),
      // LangChain.js AgentRunner intrinsic (neuro-san-web owns the loop)
      externalRunner: self.agentRunner,
      routerBaseUrl: llm.baseUrl,
      mock: llm.mock,
      apiKey: self.byokKey,
      modelOverride: self.modelOverride,
    };
    return ctx;
  }

  // fetch-and-run-locally: turn a peer URL into a runnable Session.
  async resolveRemote(ref, chain, parentSpan) {
    const { origin } = parseExternalAgent(ref, this.top?.base);
    this._assertAllowedPeer(origin); // publish-time policy gate; fails closed
    const lastSeg = ref.split("/").filter(Boolean).pop();
    this.registry.checkCycle(chain, origin, lastSeg);

    const cached = this.registry.get(origin, lastSeg);
    if (cached) return cached;

    const fetchSpan = this.trace.start("remote_fetch", {
      parent: parentSpan,
      origin: hostOf(this.top.base),
      peerOrigin: hostOf(origin),
      url: ref,
    });
    let session;
    try {
      const { manifest, base } = await fetchManifest(origin);
      // Fail closed: only run the exact published network that was requested —
      // never silently fall back to a different (e.g. networks[0]) network.
      const entry = manifest.networks.find((n) => n.name === lastSeg);
      if (!entry) {
        throw new Error(`No published network named '${lastSeg}' at ${hostOf(origin)}; refusing to run a different network.`);
      }
      const fetchedUrls = {
        manifest: `${base}/agent-manifest.json`,
        hocon: resolveUrl(base, entry.hocon),
        toolBundle: manifest.coded_tools?.bundle ? resolveUrl(base, manifest.coded_tools.bundle) : null,
      };
      const { network, bundleUrl, integrity, llm } = await this._compile(base, manifest, entry);
      this.trace.end(fetchSpan, { network: network.name, fetchedUrls, peerOrigin: hostOf(origin), brand: manifest.brand });
      session = new Session(this, { network, base, bundleUrl, integrity, llm, fetchedUrls, brand: manifest.brand, chain: [...chain, `${origin}::${lastSeg}`] });
      this.registry.set(origin, lastSeg, session);
      return session;
    } catch (err) {
      this.trace.fail(fetchSpan, err);
      throw err;
    }
  }

  // Resolve an MCP tool reference (string URL or { url, tools }) to a cached
  // MCP client. The browser acts as MCP client to a hosted MCP server.
  async resolveMcp(ref, parentSpan, slyData) {
    const url = typeof ref === "string" ? ref : ref.url;
    this._assertAllowedPeer(url); // same publish-time policy gate as peer networks
    if (!this._mcpClients) this._mcpClients = new Map();
    let client = this._mcpClients.get(url);
    if (!client) {
      const headers = (slyData && slyData.http_headers && slyData.http_headers[url]) || {};
      client = new McpClient({ url, trace: this.trace, headers });
      this._mcpClients.set(url, client);
    }
    return client;
  }

  async run(userText, { slyData } = {}) {
    if (!this.top) await this.loadTop();
    const runSpan = this.trace.start("run", { origin: hostOf(this.top.base), input: userText });
    try {
      const ctx = this._makeCtx({
        network: this.top.network,
        base: this.top.base,
        bundleUrl: this.top.bundleUrl,
        integrity: this.top.integrity,
        llm: this.top.llm,
        slyData: { ...(slyData || {}) },
        chain: [`${this.top.base}::${this.top.network.findFrontMan()}`],
        isTop: true,
        history: this.history,
      });
      const text = await runAgent(ctx, this.top.network.findFrontMan(), userText, runSpan, ctx_chain(ctx, this.top));
      // Persist this turn so the next turn has conversation context.
      this.history.push({ role: "user", content: userText });
      this.history.push({ role: "assistant", content: text });
      if (this.history.length > 24) this.history = this.history.slice(-24); // bound tokens
      this.trace.end(runSpan, { answerPreview: text.slice(0, 300) });
      return text;
    } catch (err) {
      this.trace.fail(runSpan, err);
      throw err;
    }
  }
}

function ctx_chain(ctx, top) {
  return [`${top.base}::${top.network.findFrontMan()}`];
}

// A peer network made runnable locally, exposed through the uniform Session API.
class Session {
  constructor(engine, { network, base, bundleUrl, integrity, llm, fetchedUrls, brand, chain }) {
    this.engine = engine;
    this.network = network;
    this.brand = brand;
    this.base = base;
    this.bundleUrl = bundleUrl;
    this.integrity = integrity || null;
    this.llm = llm;
    this.fetchedUrls = fetchedUrls;
    this.chain = chain;
  }

  async func() {
    const front = this.network.getAgentSpec(this.network.findFrontMan());
    return front?.function || { description: this.network.name };
  }

  async invoke(request, { parentSpan } = {}) {
    const trace = this.engine.trace;
    const span = trace.start("remote_call", {
      parent: parentSpan,
      origin: hostOf(this.engine.top.base),
      peerOrigin: hostOf(this.base),
      method: "fetch-and-run-locally",
      fetchedUrls: this.fetchedUrls,
      requestPayload: { ...request, sly_data: redactSlyData(request.sly_data) },
      network: this.network.name,
    });
    try {
      const ctx = this.engine._makeCtx({
        network: this.network,
        base: this.base,
        bundleUrl: this.bundleUrl,
        integrity: this.integrity,
        llm: this.llm,
        slyData: { ...(request.sly_data || {}) },
        chain: this.chain,
        isTop: false,
      });
      const text = await runAgent(ctx, this.network.findFrontMan(), request.user_message.text, span, this.chain);
      trace.end(span, { responsePreview: text.slice(0, 300), type: ChatMessageType.AGENT });
      return text;
    } catch (err) {
      trace.fail(span, err);
      return `Error from ${hostOf(this.base)}: ${err.message}`;
    }
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
