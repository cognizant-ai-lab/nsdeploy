// llm.js — the LlmClient intrinsic: an OpenAI-compatible chat-completions client.

import { normalizeModelName } from "./model.js";

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || "?"; }
}

export function isMockResponse(configuredMock, routeKind, model) {
  return !!configuredMock || routeKind === "mock" || /neuro-san-mock/.test(model || "");
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
  async chat({ model, messages, tools, origin, parentSpan, onContentDelta }) {
    model = normalizeModelName(model);
    // A real (non-mock) router with no API key: refuse rather than forward the
    // placeholder "demo" to a live provider (which returns a confusing 401). This
    // happens e.g. when a shared/reloaded URL keeps the proxy router but no saved
    // BYOK profile/key is available in this browser.
    if (!this.mock && (!this.apiKey || this.apiKey === "demo")) {
      throw new Error(`The selected LLM router (${hostOf(this.baseUrl) || "a real provider"}) needs your API key. Open ⚙ BYOK settings and enter it — or switch the router back to the mock to run without a key.`);
    }
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
      const resp = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`LLM HTTP ${resp.status}: ${txt.slice(0, 300)}`);
      }

      const routeKind = resp.headers.get("X-Nsdeploy-LLM-Route") || "";
      const result = await this._readSse(resp, onContentDelta, span);
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
      this.trace?.fail(span, err);
      throw err;
    }
  }

  async _readSse(resp, onContentDelta, span) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let content = "";
    const toolCalls = []; // assembled by index
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
        onContentDelta?.(delta.content);
        this.trace?.update(span, { streamChunk: delta.content });
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    for (;;) {
      const { value, done } = await reader.read();
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

    return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage, model };
  }
}
