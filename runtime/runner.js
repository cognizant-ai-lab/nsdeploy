// runner.js — the AgentRunner intrinsic.
//
// Two interchangeable implementations of one agent's LLM tool-calling loop:
//   * runAgentManual   — a dependency-free reference loop (default).
//   * langGraphRunner   — LangChain.js + LangGraph.js createReactAgent, loaded as a
//                         pre-bundled browser artifact (runtime/generated/agent-runner.bundle.js).
// Both share buildToolTable() + dispatchToolCall() so a neuro-san tool (peer agent,
// sandboxed coded tool, REST/toolbox tool, remote fetched-and-run network) executes
// identically regardless of which loop drives it. The engine selects via ctx.useLangGraph.

import { ChatMessageType, filterSlyData, allowedDownstreamSly, parseExternalAgent } from "./kernel.js";

export function argsToText(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  if (args.request) return String(args.request);
  if (args.input) return String(args.input);
  if (args.input_string) return String(args.input_string);
  return JSON.stringify(args);
}

export function safeName(s) {
  return s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "").slice(0, 60) || "tool";
}

function hostOfUrl(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Pull any ```cruse-ui {json}``` widget(s) out of an agent's answer, emit each as a
// "widget" trace event (so it surfaces to the UI), and return the text with the
// blocks removed. This lets ANY agent in the chain contribute widgets, generated on
// the fly, while keeping the text passed up to its caller clean (consolidation).
function tolerantJsonParse(s) {
  try { return JSON.parse(s); } catch {}
  // Best-effort repair: normalize smart quotes and drop trailing commas.
  const fixed = s
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(fixed); } catch {}
  return null;
}

export function extractWidgets(text, ctx, agentName) {
  if (!text) return text;
  // Accept ```cruse-ui (preferred), or a bare ```json fence whose body is a widget.
  const re = /```(?:cruse-ui|json)\s*([\s\S]*?)```/gi;
  let m;
  let found = false;
  while ((m = re.exec(text))) {
    const widget = tolerantJsonParse(m[1].trim());
    if (widget && typeof widget === "object" && widget.display !== false && (widget.schema || widget.kind || widget.options || widget.fields)) {
      found = true;
      ctx.trace.note("widget", { origin: ctx.displayOrigin, agent: agentName, network: ctx.network?.name, widget });
    }
  }
  if (!found) return text;
  // Remove only blocks we actually turned into widgets (cruse-ui, or json that parsed as a widget).
  return text
    .replace(/```cruse-ui[\s\S]*?```/gi, "")
    .replace(/```json\s*([\s\S]*?)```/gi, (full, body) => {
      const w = tolerantJsonParse(body.trim());
      return w && (w.schema || w.kind || w.options || w.fields) ? "" : full;
    })
    .trim();
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

export function schemaFor(name, fn) {
  return {
    type: "function",
    function: {
      name,
      description: (fn && fn.description) || name,
      parameters: (fn && fn.parameters) || {
        type: "object",
        properties: { request: { type: "string", description: "The request to handle." } },
        required: ["request"],
      },
    },
  };
}

// Build the tool table + OpenAI-style schemas for one agent's `tools`.
export async function buildToolTable(ctx, spec, chain, parentSpan) {
  const { network } = ctx;
  const toolByName = new Map();
  const toolSchemas = [];
  for (const ref of spec.tools || []) {
    const c = network.classifyTool(ref);
    if (c.kind === "missing") continue;

    if (c.kind === "mcp") {
      // Discovering MCP tools requires a tools/list call — that IS contact with the
      // MCP origin. Gate it behind consent FIRST: nothing is sent to the server
      // (no initialize, no tools/list, no IP/headers) until the user approves. If
      // declined, the agent simply proceeds without these tools.
      const host = hostOfUrl(typeof ref === "string" ? ref : ref.url);
      const decision = await ctx.requestConsent?.({
        kind: "mcp", phase: "discover", peerLabel: "Destination service", peerOrigin: host,
        requestText: "(discover available tools)",
        est: { totalTokens: 0, costText: ctx.mock ? "$0.00 (mock)" : "metadata only" },
      });
      if (decision === "decline") {
        ctx.trace.note("consent", { parent: parentSpan, origin: ctx.displayOrigin, peerOrigin: host, phase: "discover", decision: "declined" });
        continue;
      }
      const client = await ctx.resolveMcp(ref, parentSpan);
      for (const t of await client.listTools(parentSpan)) {
        const name = safeName(`mcp_${t.name}`);
        // The origin is approved at discovery; the call itself won't re-prompt.
        toolByName.set(name, { kind: "mcp", ref, client, mcpName: t.name });
        toolSchemas.push(schemaFor(name, { description: t.description, parameters: t.inputSchema }));
      }
    } else if (c.kind === "remote") {
      // Do NOT contact the peer here. Advertise a generic schema and defer the
      // fetch-and-run (manifest + HOCON + tool bundle) until the user consents at
      // call time — so consent truly precedes any contact with the partner origin.
      const name = safeName(parseExternalAgent(ref, ctx.baseOrigin).agentName);
      const host = hostOfUrl(ref);
      toolByName.set(name, { kind: "remote", url: ref });
      toolSchemas.push(schemaFor(name, { description: `Hand off to the ${host} network ("${name}"). Provide a natural-language request.` }));
    } else if (c.kind === "link") {
      // A dangling HOCON reference remains callable. Resolution is deferred until
      // the model actually selects it, at which point the UI asks for a peer URL.
      const name = safeName(ref);
      toolByName.set(name, { kind: "link", reference: ref });
      toolSchemas.push(schemaFor(name, {
        description: `Hand off to the linked agent network "${ref}". If it is not linked yet, ask the developer for its nsDeploy site URL.`,
      }));
    } else {
      const name = safeName(c.ref);
      toolByName.set(name, c);
      toolSchemas.push(schemaFor(name, c.spec.function));
    }
  }
  return { toolByName, toolSchemas };
}

// Merge a coded tool's returned sly_data back into the context with output
// filtering. If the tool's function declares `sly_data_output_schema`, only those
// keys may be written. Otherwise the tool may ADD new keys but must not OVERWRITE
// existing ones — so untrusted code can't clobber sensitive entries (e.g. tokens).
function mergeToolSlyData(ctx, spec, slyData) {
  if (!slyData || typeof slyData !== "object") return;
  const declared = spec.function?.sly_data_output_schema?.properties;
  const allowWrite = declared ? new Set(Object.keys(declared)) : null;
  for (const [k, v] of Object.entries(slyData)) {
    if (allowWrite) {
      if (allowWrite.has(k)) ctx.slyData[k] = v;
    } else if (!(k in ctx.slyData)) {
      ctx.slyData[k] = v;
    }
  }
}

export async function dispatchToolCall(ctx, entry, args, parentSpan, chain) {
  const { trace } = ctx;

  if (entry.kind === "agent") {
    return runAgent(ctx, entry.ref, argsToText(args), parentSpan, chain);
  }

  if (entry.kind === "coded") {
    // Secure default: a coded tool receives NO sly_data unless its spec explicitly
    // grants keys via an allow block. (The old default handed the tool everything —
    // including secrets like backend_token.) Untrusted peer code never sees more
    // than it is declared to need.
    const permitted = filterSlyData(ctx.slyData, allowedDownstreamSly(entry.spec) || []);
    const { result, slyData } = await ctx.sandbox.invoke({
      bundleUrl: ctx.codedToolBundleUrl,
      integrity: ctx.codedToolIntegrity,
      className: entry.spec.class,
      args,
      permittedSly: permitted,
      origin: ctx.displayOrigin,
      parentSpan,
    });
    mergeToolSlyData(ctx, entry.spec, slyData);
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  if (entry.kind === "toolbox") {
    return dispatchRest(ctx, entry, args, parentSpan);
  }

  if (entry.kind === "mcp") {
    // Discovery (tools/list) was approved separately. Now confirm the ACTUAL call
    // with the real payload the user is about to send. A per-origin "always"
    // decision auto-allows and skips this prompt; otherwise the user sees exactly
    // what is being sent — discovery consent never silently authorizes execution.
    const host = hostOfUrl(entry.client.url);
    const requestText = argsToText(args);
    const decision = await ctx.requestConsent?.({
      kind: "mcp", phase: "call", peerLabel: "Destination service", peerOrigin: host,
      requestText,
      est: { totalTokens: Math.round((requestText.length + 80) / 4), costText: ctx.mock ? "$0.00 (mock)" : null },
    });
    if (decision === "decline") {
      ctx.trace.note("consent", { parent: parentSpan, origin: ctx.displayOrigin, peerOrigin: host, phase: "call", decision: "declined" });
      return `The user declined to send this request to ${host}. Continue without it.`;
    }
    return entry.client.callTool(entry.mcpName, args, parentSpan);
  }

  if (entry.kind === "link") {
    const target = await ctx.resolveLink(entry.reference, parentSpan);
    if (!target) return `The user did not link '${entry.reference}'. Continue without it.`;
    return dispatchToolCall(ctx, { kind: "remote", url: target }, args, parentSpan, chain);
  }

  if (entry.kind === "remote") {
    const requestText = argsToText(args);
    const host = hostOfUrl(entry.url);
    // Coarse estimate: the peer has NOT been fetched yet (that happens only after
    // approval), so consent genuinely precedes any contact with the partner origin.
    const est = {
      totalTokens: Math.round((requestText.length + 300) / 4) * 2,
      costText: ctx.mock ? "$0.00 (mock)" : null,
    };
    const decision = await ctx.requestConsent?.({
      kind: "network", peerLabel: host, peerOrigin: host, requestText, est,
    });
    if (decision === "decline") {
      ctx.trace.note("consent", { parent: parentSpan, origin: ctx.displayOrigin, peerOrigin: host, decision: "declined" });
      return `The user declined to contact ${host}. Proceed without it and note that to the user.`;
    }
    // Approved — only now fetch-and-run the peer network.
    const session = await ctx.resolveRemote(entry.url, chain, parentSpan);
    const downstreamSly = filterSlyData(ctx.slyData, allowedDownstreamSly(ctx.network.getAgentSpec(ctx.frontMan)) || []);
    const request = {
      user_message: { type: ChatMessageType.HUMAN, text: requestText },
      sly_data: downstreamSly,
      chat_filter: { chat_filter_type: "MINIMAL" },
    };
    return session.invoke(request, { parentSpan, chain });
  }

  return `Error: unsupported tool kind '${entry.kind}'`;
}

// Dispatcher: the LangChain.js runner when enabled, else the dependency-free
// reference loop. Either way neuro-san-web owns multi-agent orchestration.
export async function runAgent(ctx, agentName, userText, parentSpan, chain) {
  if (ctx.externalRunner) {
    return ctx.externalRunner(ctx, agentName, userText, parentSpan, chain, {
      buildToolTable, dispatchToolCall, schemaFor, argsToText, extractWidgets,
    });
  }
  return runAgentManual(ctx, agentName, userText, parentSpan, chain);
}

export async function runAgentManual(ctx, agentName, userText, parentSpan, chain) {
  const { network, llm, trace } = ctx;
  const spec = network.getAgentSpec(agentName);
  if (!spec) throw new Error(`agent '${agentName}' not found`);

  const origin = ctx.displayOrigin;
  const isTopFrontMan = ctx.isTop && agentName === ctx.frontMan;
  const agentSpan = trace.start("agent", {
    parent: parentSpan, origin, agent: agentName, network: network.name,
    displayAs: spec.class ? "coded_tool" : "llm_agent", runner: "manual",
  });

  try {
    const { toolByName, toolSchemas } = await buildToolTable(ctx, spec, chain, agentSpan);

    const sysParts = [];
    if (spec.instructions) sysParts.push(spec.instructions.trim());
    if (spec.command) sysParts.push(spec.command.trim());
    const messages = [{ role: "system", content: sysParts.join("\n\n") || "You are a helpful agent." }];
    if (isTopFrontMan && ctx.history?.length) messages.push(...ctx.history);
    messages.push({ role: "user", content: userText });

    const model = ctx.modelOverride || spec.llm_config?.model_name || network.config.llm_config?.model_name || ctx.defaultModel;
    const maxSteps = spec.max_steps || network.config.max_steps || 12;

    let finalText = "";
    for (let step = 0; step < maxSteps; step++) {
      const onContentDelta = isTopFrontMan ? (t) => ctx.onAnswerDelta?.(t) : undefined;
      const res = await llm.chat({ model, messages, tools: toolSchemas, origin, parentSpan: agentSpan, onContentDelta });
      if (res.toolCalls.length === 0) {
        finalText = res.content;
        break;
      }
      messages.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
      for (const tc of res.toolCalls) {
        let args = {};
        try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch { args = { request: tc.function.arguments }; }
        const entry = toolByName.get(tc.function.name);
        const resultText = entry ? await dispatchToolCall(ctx, entry, args, agentSpan, chain) : `Error: unknown tool '${tc.function.name}'`;
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: typeof resultText === "string" ? resultText : JSON.stringify(resultText) });
        trace.note("tool_result", { parent: agentSpan, origin, tool: tc.function.name, preview: String(resultText).slice(0, 200), type: ChatMessageType.AGENT_TOOL_RESULT });
      }
    }

    finalText = extractWidgets(finalText, ctx, agentName); // contribute widgets up the chain
    trace.end(agentSpan, { answerChars: finalText.length });
    return finalText;
  } catch (err) {
    trace.fail(agentSpan, err);
    throw err;
  }
}

// Built-in REST toolbox (requests_get / http_get): fetch a URL, attaching a bearer
// token from sly_data if present — an authenticated call to a business backend.
async function dispatchRest(ctx, entry, args, parentSpan) {
  const { trace } = ctx;
  // The configured backend URL is authoritative. A (prompt-injected) model must
  // NOT be able to supply args.url to redirect this authenticated request to an
  // arbitrary origin and exfiltrate the bearer token. A dynamic URL would require
  // an explicit, validated allow-list on the tool spec — none exists here, so the
  // model-supplied url is ignored entirely.
  const url = entry.spec.args?.url;
  if (!url) return `Error: REST tool '${entry.ref}' has no configured URL.`;
  const method = (entry.spec.args?.method || "GET").toUpperCase();
  const headers = {};
  const token = ctx.slyData?.backend_token;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const span = trace.start("rest_call", {
    parent: parentSpan, origin: ctx.displayOrigin, tool: entry.ref, toolKind: "REST (backend)",
    method, url, headers: token ? { Authorization: "Bearer <redacted>" } : {},
  });
  try {
    const resp = await fetch(url, { method, headers });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`REST ${resp.status}`);
    trace.end(span, { status: "ok", httpStatus: resp.status, preview: text.slice(0, 200) });
    return text;
  } catch (err) {
    trace.fail(span, err);
    return `Error calling ${url}: ${err.message}`;
  }
}
