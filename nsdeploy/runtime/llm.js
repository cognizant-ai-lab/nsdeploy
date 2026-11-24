// llm.js — the LlmClient intrinsic: an OpenAI-compatible chat-completions client.

import { assertModelForRouter, normalizeModelName } from "./model.js";
import { ProviderError } from "./provider-error.js";

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || "?"; }
}

export function isMockResponse(configuredMock, routeKind, model) {
  return !!configuredMock || routeKind === "mock" || /neuro-san-mock/.test(model || "");
}

export function browserMockCompletion(messages = [], tools = []) {
  const called = new Set(messages.filter((m) => m?.role === "tool" && m.name).map((m) => m.name));
  const available = (tools || []).map((tool) => tool?.function).filter((fn) => fn?.name);
  const next = available.find((fn) => !called.has(fn.name));
  const lastUser = [...messages].reverse().find((m) => m?.role === "user");
  const request = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content || "");
  if (next) {
    const args = {};
    const schema = next.parameters || {};
    for (const name of schema.required || []) args[name] = request;
    for (const name of ["request", "inquiry", "search_terms", "query", "input"]) {
      if (schema.properties?.[name] || (schema.required || []).includes(name)) args[name] ??= request;
    }
    return {
      content: "",
      toolCalls: [{
        id: `call_${next.name}`,
        type: "function",
        function: { name: next.name, arguments: JSON.stringify(args) },
      }],
      finishReason: "tool_calls",
      usage: null,
      model: "neuro-san-mock-browser",
    };
  }
  const results = messages.filter((m) => m?.role === "tool").map((m) => String(m.content || ""));
  const content = results.length
    ? `(mock summary) Based on the tools I consulted: ${results.join(" ").slice(0, 1200)}`
    : "(mock) I have no grounded tool output to summarize for this request.";
  return { content, toolCalls: [], finishReason: "stop", usage: null, model: "neuro-san-mock-browser" };
}

//
// In production this is @langchain/openai's ChatOpenAI pointed at a router base
// URL. Here it is a direct fetch to any OpenAI-compatible endpoint (LiteLLM,
// OpenRouter, vLLM, Ollama, Docker Model Runner, or the demo mock router). The
// BYOK key is never put in the URL and is sent only to the chosen router as
// Authorization.

export class LlmClient {
  constructor({ baseUrl, apiKey, trace, mock }) {
    this.baseUrl = (baseUrl || "").replace(/\/$/, "");
    this.apiKey = apiKey || "";
    this.trace = trace;
    this.mock = !!mock;
  }

  // messages: [{role, content, tool_calls?, tool_call_id?, name?}]
  // tools: [{type:'function', function:{name, description, parameters}}]
  // onContentDelta: (text) => void  — streamed natural-language tokens
  async chat({ model, messages, tools, origin, parentSpan, onContentDelta, signal }) {
    model = normalizeModelName(model);
    // A real (non-mock) router with no API key: refuse rather than forward the
    // placeholder "demo" to a live provider (which returns a confusing 401). This
    // happens e.g. when a shared/reloaded URL keeps the proxy router but no saved
    // BYOK profile/key is available in this browser.
    if (!this.mock && (!this.apiKey || this.apiKey === "demo")) {
      throw new Error(`An AI provider key is required for ${hostOf(this.baseUrl) || "the configured provider"}. Open ⚙ AI model settings, paste your key, then select Save and start. Your key stays in this browser and is sent only to the configured provider.`);
    }
    assertModelForRouter(model, this.mock, hostOf(this.baseUrl));
    const span = this.trace?.start("model_call", {
      parent: parentSpan,
      origin,
      model,
      mock: this.mock,
      routerHost: hostOf(this.baseUrl),
      endpoint: `${this.baseUrl}/chat/completions`,
      keySource: this.apiKey ? "local BYOK (not shown)" : "none",
      toolNames: (tools || []).map((t) => t.function.name),
    });

    const body = {
      model,
      messages,
      stream: true,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    try {
      if (this.baseUrl === "browser://mock") {
        signal?.throwIfAborted?.();
        const result = browserMockCompletion(messages, tools);
        if (result.content) {
          onContentDelta?.(result.content);
          this.trace?.update(span, { streamChunk: result.content });
        }
        this.trace?.end(span, {
          finishReason: result.finishReason,
          contentChars: result.content.length,
          toolCalls: result.toolCalls.map((t) => t.function.name),
          usage: null,
          mock: true,
          verifiedReal: false,
          respModel: result.model,
          routeKind: "browser-mock",
        });
        return result;
      }
      const headers = {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      };
      if (hostOf(this.baseUrl) === "api.anthropic.com") {
        headers["anthropic-dangerous-direct-browser-access"] = "true";
      }
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`LLM HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }

      const routeKind = resp.headers.get("X-Nsdeploy-LLM-Route") || "";
      const result = await this._readSse(resp, onContentDelta, span, signal);
      const respMock = isMockResponse(this.mock, routeKind, result.model);
      this.trace?.end(span, {
        finishReason: result.finishReason,
        contentChars: result.content.length,
        toolCalls: result.toolCalls.map((t) => t.function.name),
        usage: result.usage,
        mock: respMock,
        verifiedReal: !respMock && !!result.model,
        respModel: result.model,
        routeKind,
      });
      return result;
    } catch (err) {
      const friendlyError = ProviderError.friendly(err, this.baseUrl);
      if (err?.name === "AbortError" && signal?.aborted) {
        this.trace?.end(span, { status: "steered", interrupted: true });
      } else {
        this.trace?.fail(span, friendlyError);
      }
      throw friendlyError;
    }
  }

  async _readSse(resp, onContentDelta, span, signal) {
    const reader = resp.body.getReader();
    const cancel = () => reader.cancel(signal?.reason).catch(() => {});
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      await cancel();
      signal.throwIfAborted();
    }
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls = []; // assembled in the order the calls start
    const currentByIndex = new Map(); // each index (null for none) -> the slot its latest piece went to
    let finishReason = null;
    let usage = null;
    let model = null;

    const handleChunk = (json) => {
      if (json.model) model = json.model;
      if (json.usage) usage = json.usage;
      const choice = json.choices?.[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (delta.content) {
        content += delta.content;
        if (!signal?.aborted) {
          onContentDelta?.(delta.content);
          this.trace?.update(span, { streamChunk: delta.content });
        }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = LlmClient.toolCallSlot(toolCalls, tc, currentByIndex);
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          // Gemini 3 puts a thought signature here. It rejects the next request unless
          // the signature comes back on the same call, so keep the field as received.
          if (tc.extra_content) toolCalls[idx].extra_content = tc.extra_content;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            handleChunk(JSON.parse(payload));
          } catch {
            /* ignore malformed keep-alive lines */
          }
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
    }

    return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage, model };
  }

  /**
   * Return the slot in toolCalls that one streamed tool-call piece belongs to.
   *
   * A piece with the id of a call already started continues that call, even when pieces
   * of two calls interleave. Otherwise the piece goes to the current call at its index.
   * Most routers number each call and send its id on the first piece. Some routers
   * (LiteLLM, MLflow, older Ollama) number every call 0, so a new id starts a new call.
   * Gemini sends no index (or index null), sometimes with an empty id, so with no index a
   * second function name starts a new call too.
   *
   * :param toolCalls: The calls put together so far, one per slot.
   * :param piece: One entry of a chunk's delta.tool_calls.
   * :param currentByIndex: For each index in this stream, and null for pieces with no
   *     index, the slot its latest piece went to. Updated here.
   * :return: The slot number.
   */
  static toolCallSlot(toolCalls, piece, currentByIndex) {
    const index = Number.isInteger(piece.index) ? piece.index : null;
    let slot = piece.id ? toolCalls.findIndex((call) => call?.id === piece.id) : -1;
    if (slot < 0) {
      slot = currentByIndex.get(index);
      const call = slot === undefined ? undefined : toolCalls[slot];
      // A new id starts a new call. With no index, so does a second name: numbered pieces
      // may split a name, but a call with no index sends its name once.
      const secondName = index === null && piece.function?.name && call?.function?.name;
      if (!call || (piece.id && call.id) || secondName) slot = toolCalls.length;
    }
    currentByIndex.set(index, slot);
    return slot;
  }
}
