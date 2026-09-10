// mcp.js — an MCP (Model Context Protocol) client.
//
// Lets a browser-run agent call a HOSTED MCP server over JSON-RPC 2.0 / HTTP
// (protocol 2025-06-18): initialize -> notifications/initialized -> tools/list ->
// tools/call. This is fully compatible with the serverless model — the browser is
// an MCP *client*; the MCP server is hosted elsewhere. The only constraint is CORS:
// the hosted server (or a proxy) must allow the browser origin. Per-server auth
// headers can be supplied via sly_data.http_headers[serverUrl].

const PROTOCOL_VERSION = "2025-06-18";

export class McpClient {
  constructor({ url, trace, headers } = {}) {
    this.url = url;
    this.trace = trace;
    this.headers = headers || {};
    this.sessionId = null;
    this.initialized = null; // a promise, once
    this.rpcId = 0;
  }

  async _rpc(method, params, { parentSpan, notification = false } = {}) {
    const span = this.trace?.start("mcp_call", {
      parent: parentSpan, peerOrigin: hostOf(this.url), url: this.url, method, args: params,
    });
    try {
      const body = { jsonrpc: "2.0", method, params: params || {} };
      if (!notification) body.id = ++this.rpcId;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...this.headers,
      };
      if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

      const resp = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
      const sid = resp.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      if (notification) { this.trace?.end(span, { status: "ok", notification: true }); return null; }

      const text = await resp.text();
      if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 200)}`);
      const json = parseMaybeSse(text);
      if (json.error) throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
      this.trace?.end(span, { status: "ok" });
      return json.result;
    } catch (err) {
      this.trace?.fail(span, err);
      throw err;
    }
  }

  async ensureInit(parentSpan) {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await this._rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "neuro-san-web", title: "neuro-san-web MCP client", version: "0.1.0" },
      }, { parentSpan });
      await this._rpc("notifications/initialized", {}, { parentSpan, notification: true });
    })();
    return this.initialized;
  }

  async listTools(parentSpan) {
    await this.ensureInit(parentSpan);
    const result = await this._rpc("tools/list", {}, { parentSpan });
    return result?.tools || [];
  }

  async callTool(name, args, parentSpan) {
    await this.ensureInit(parentSpan);
    const result = await this._rpc("tools/call", { name, arguments: args || {} }, { parentSpan });
    const parts = (result?.content || []).map((c) => (c.type === "text" ? c.text : JSON.stringify(c)));
    const text = parts.join("\n");
    return result?.isError ? `MCP tool error: ${text}` : text;
  }
}

// MCP servers may answer JSON-RPC as plain JSON or as a single SSE event.
function parseMaybeSse(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice(5).trim();
      if (payload && payload !== "[DONE]") return JSON.parse(payload);
    }
  }
  throw new Error("unparseable MCP response");
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
