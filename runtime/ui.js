// ui.js — the themeable chat + execution-trace inspector.
//
// Renders three surfaces from the trace bus: a chat pane, a live network/origin
// graph, and a chronological execution log. Businesses restyle via CSS variables
// (--ns-primary, --ns-bg, --ns-font, etc.) set on the host page; this module
// imposes layout, not brand.

import { ChatMessageType } from "./kernel.js";

const BASE_CSS = `
.ns-app{display:grid;grid-template-columns:1fr;grid-template-rows:auto 1fr;gap:12px;height:100%;min-height:0;overflow:hidden;
  font-family:var(--ns-font,system-ui,sans-serif);color:var(--ns-fg,#1a1a1a);background:var(--ns-bg,#fff);box-sizing:border-box;padding:12px}
.ns-app[data-dev="true"]{grid-template-columns:minmax(0,1fr) minmax(0,44%)}
.ns-header{grid-column:1/-1;display:flex;align-items:center;gap:12px;border-bottom:2px solid var(--ns-accent,var(--ns-primary,#2563eb));background:var(--ns-header-bg,transparent);color:var(--ns-header-fg,inherit);padding:var(--ns-header-pad,0 0 8px)}
.ns-header .ns-logo{height:32px}
.ns-title{font-weight:700;font-size:18px}
.ns-main{min-height:0;overflow:hidden;display:flex;justify-content:center}
.ns-stage{display:flex;gap:14px;width:100%;max-width:1140px;min-height:0;flex-wrap:nowrap}
.ns-stage>.ns-chat{flex:1 1 460px;min-width:0;min-height:0}
.ns-agents{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--ns-border,#e2e2e2);border-radius:12px;padding:12px;background:var(--ns-panelbg,#fbfcfe);min-height:0;overflow:auto}
.ns-agents h3{margin:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ns-muted,#888)}
.ns-status{font-size:13px;color:var(--ns-fg,#333);display:flex;align-items:center;gap:8px;min-height:20px}
.ns-status .ns-spin{width:12px;height:12px;border:2px solid var(--ns-primary,#2563eb);border-top-color:transparent;border-radius:50%;animation:ns-spin .8s linear infinite;display:none}
.ns-status.busy .ns-spin{display:inline-block}
@keyframes ns-spin{to{transform:rotate(360deg)}}
.ns-anode{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--ns-border,#e6e6e6);border-radius:10px;background:#fff;cursor:pointer;transition:all .15s}
.ns-anode:hover{border-color:var(--ns-primary,#2563eb)}
.ns-anode .ns-aicon{font-size:18px;line-height:1}
.ns-anode .ns-ameta{flex:1;min-width:0}
.ns-anode .ns-aname{font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-anode .ns-arole{font-size:11px;color:var(--ns-muted,#999)}
.ns-anode .ns-adot{width:9px;height:9px;border-radius:50%;background:#cbd5e1;flex:0 0 auto}
.ns-anode.active{border-color:var(--ns-primary,#2563eb);box-shadow:0 0 0 3px color-mix(in srgb,var(--ns-primary,#2563eb) 18%,transparent)}
.ns-anode.active .ns-adot{background:var(--ns-primary,#2563eb);animation:ns-pulse 1s ease-in-out infinite}
.ns-anode.done .ns-adot{background:#16a34a}
@keyframes ns-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.ns-modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:50}
.ns-modal[hidden]{display:none}
.ns-modal-card{background:#fff;border-radius:12px;max-width:560px;width:92%;max-height:80vh;overflow:auto;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.ns-modal-card h4{margin:0 0 4px;font-size:16px}
.ns-modal-card .ns-mrole{font-size:12px;color:var(--ns-muted,#888);margin-bottom:12px}
.ns-modal-card h5{margin:14px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ns-muted,#888)}
.ns-modal-card pre{white-space:pre-wrap;background:#f6f7f9;border-radius:8px;padding:10px;font-size:12px;line-height:1.4;margin:0}
.ns-mact{font-size:12px;border-left:3px solid var(--ns-border,#ddd);padding:4px 8px;margin:4px 0;background:#fafafa;border-radius:4px}
.ns-modal-close{float:right;border:0;background:transparent;font-size:20px;cursor:pointer;color:#888;line-height:1}
.ns-consent{background:#fffbeb;border:1px solid #f59e0b;max-width:95%}
.ns-consent-title{font-size:14px;margin-bottom:2px}
.ns-consent-sub{font-size:12px;color:var(--ns-muted,#92704a);font-family:ui-monospace,monospace;margin-bottom:6px}
.ns-consent-req{font-size:12px;font-style:italic;color:#555;margin-bottom:8px}
.ns-consent-actions{display:flex;gap:8px}
.ns-consent-actions button{padding:6px 14px;border:0;border-radius:8px;background:var(--ns-primary,#2563eb);color:#fff;font-weight:600;cursor:pointer;font-size:13px}
.ns-consent-actions button.ghost{background:transparent;color:#b45309;border:1px solid #f59e0b}
.ns-consent-done{font-weight:700;color:#166534}
.ns-widget{align-self:flex-start;max-width:95%;border:1px solid var(--ns-border,#e2e2e2);border-top:3px solid var(--w,var(--ns-primary,#2563eb));border-radius:12px;padding:14px;background:#fff;display:flex;flex-direction:column;gap:8px}
.ns-widget.done{opacity:.7}
.ns-w-head{display:flex;align-items:center;gap:8px;font-size:15px}
.ns-w-icon{font-size:18px}
.ns-w-desc{font-size:13px;color:var(--ns-muted,#666)}
.ns-w-form{display:flex;flex-direction:column;gap:10px}
.ns-w-row{display:flex;flex-direction:column;gap:3px}
.ns-w-label{font-size:13px;font-weight:600}
.ns-w-fdesc{font-size:11px;color:var(--ns-muted,#999)}
.ns-w-row input[type=text],.ns-w-row input[type=number],.ns-w-row input[type=date],.ns-w-row select,.ns-w-row textarea{padding:7px 9px;border:1px solid var(--ns-border,#ccc);border-radius:8px;font-size:14px;font-family:inherit}
.ns-w-radio,.ns-w-multi{display:flex;flex-wrap:wrap;gap:10px;font-size:13px}
.ns-w-radio label,.ns-w-multi label,.ns-w-toggle{display:flex;align-items:center;gap:4px}
.ns-w-actions{display:flex;gap:8px;margin-top:4px}
.ns-w-btn{padding:8px 16px;border:0;border-radius:8px;background:var(--w,var(--ns-primary,#2563eb));color:#fff;font-weight:600;cursor:pointer;font-size:14px}
.ns-w-btn.ghost{background:transparent;color:var(--ns-muted,#666);border:1px solid var(--ns-border,#ccc)}
.ns-w-btn:disabled,.ns-w-choice:disabled{opacity:.55;cursor:default}
.ns-w-choices{display:flex;flex-direction:column;gap:8px}
.ns-w-choice{text-align:left;padding:10px 12px;border:1px solid var(--ns-border,#ddd);border-radius:10px;background:#fafbfc;cursor:pointer}
.ns-w-choice:hover:not(:disabled){border-color:var(--w,var(--ns-primary,#2563eb));background:#fff}
.ns-w-ctitle{font-weight:600;font-size:14px}
.ns-w-csub{font-size:12px;color:var(--ns-muted,#666)}
.ns-w-cmeta{font-size:12px;font-weight:600;color:var(--w,var(--ns-primary,#2563eb))}
.ns-w-fields{display:flex;flex-direction:column;gap:4px}
.ns-w-field{display:flex;justify-content:space-between;gap:12px;font-size:13px;border-bottom:1px dashed var(--ns-border,#eee);padding:3px 0}
.ns-w-fk{color:var(--ns-muted,#888)}
.ns-w-fv{font-weight:600}
.ns-devtoggle{font-size:12px;padding:4px 10px;border:1px solid var(--ns-border,#ccc);border-radius:8px;background:transparent;color:var(--ns-muted,#666);cursor:pointer}
.ns-devtoggle.on{background:#1e293b;color:#fff;border-color:#1e293b}
.ns-dev{display:none;flex-direction:column;gap:12px;min-height:0}
.ns-app[data-dev="true"] .ns-dev{display:flex}
.ns-app:not([data-dev="true"]) .ns-breadcrumb{display:none}
.ns-breadcrumb{font-size:12px;color:var(--ns-muted,#666);font-family:ui-monospace,monospace}
.ns-llmbadge{margin-left:auto;font-size:12px;font-weight:700;padding:3px 10px;border-radius:12px}
.ns-llmbadge.mock{background:#fef3c7;color:#b45309;border:1px solid #f59e0b}
.ns-llmbadge.real{background:#dcfce7;color:#166534;border:1px solid #16a34a}
.ns-chat{display:flex;flex-direction:column;border:1px solid var(--ns-border,#e2e2e2);border-radius:10px;overflow:hidden;min-height:0}
.ns-msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px}
.ns-msg{max-width:85%;padding:8px 12px;border-radius:var(--ns-radius,12px);white-space:pre-wrap;line-height:1.4}
.ns-msg.user{align-self:flex-end;background:var(--ns-user-bg,var(--ns-primary,#2563eb));color:var(--ns-user-fg,#fff)}
.ns-msg.bot{align-self:flex-start;background:var(--ns-msgbg,#f1f3f5)}
.ns-inputbar{display:flex;gap:8px;padding:10px;border-top:1px solid var(--ns-border,#e2e2e2)}
.ns-inputbar input{flex:1;padding:8px 10px;border:1px solid var(--ns-border,#ccc);border-radius:8px;font-size:14px}
.ns-inputbar button{padding:8px 16px;background:var(--ns-primary,#2563eb);color:#fff;border:0;border-radius:8px;cursor:pointer;font-weight:600}
.ns-inputbar button:disabled{opacity:.5;cursor:default}
.ns-right{display:flex;flex-direction:column;gap:12px;min-height:0}
.ns-graph{border:1px solid var(--ns-border,#e2e2e2);border-radius:10px;padding:10px;font-size:13px}
.ns-graph h3,.ns-log h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--ns-muted,#888)}
.ns-node{display:inline-block;margin:3px;padding:4px 8px;border-radius:8px;border:1px solid var(--ns-border,#ddd);font-family:ui-monospace,monospace;font-size:12px}
.ns-node.active{background:var(--ns-primary,#2563eb);color:#fff;border-color:var(--ns-primary,#2563eb)}
.ns-node.origin{background:#fef3c7;border-color:#f59e0b}
.ns-log{flex:1;border:1px solid var(--ns-border,#e2e2e2);border-radius:10px;padding:10px;overflow:auto;min-height:0}
.ns-row{font-family:ui-monospace,monospace;font-size:12px;border-left:3px solid #cbd5e1;padding:4px 8px;margin:3px 0;background:#fafafa;border-radius:4px;cursor:pointer}
.ns-row .ns-tag{font-weight:700;margin-right:6px}
.ns-row .ns-meta{color:var(--ns-muted,#888)}
.ns-row.k-run{border-left-color:#7c3aed}
.ns-row.k-agent{border-left-color:#2563eb}
.ns-row.k-model_call{border-left-color:#0891b2}
.ns-row.k-tool_call{border-left-color:#16a34a}
.ns-row.k-rest_call{border-left-color:#ca8a04}
.ns-row.k-remote_fetch{border-left-color:#db2777}
.ns-row.k-remote_call{border-left-color:#db2777;background:#fdf2f8}
.ns-row.k-mcp_call{border-left-color:#0d9488;background:#f0fdfa}
.ns-row.k-error,.ns-row.status-error{border-left-color:#dc2626;background:#fef2f2}
.ns-row pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #eee;border-radius:4px;padding:6px;max-height:240px;overflow:auto}
.ns-toolbar{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.ns-toolbar input{font-size:12px;padding:4px 6px;border:1px solid #ccc;border-radius:6px}
.ns-pill{font-size:11px;padding:1px 6px;border-radius:10px;background:#eef;color:#446;margin-left:6px}
.ns-settings{border-top:1px solid var(--ns-border,#e2e2e2);font-size:12px}
.ns-settings summary{padding:6px 10px;cursor:pointer;color:var(--ns-muted,#666)}
.ns-settings-body{padding:6px 10px;display:flex;flex-direction:column;gap:6px}
.ns-settings-body label{display:flex;flex-direction:column;gap:2px;color:var(--ns-muted,#666)}
.ns-settings-body input[type=text],.ns-settings-body input[type=password],.ns-settings-body input:not([type]){padding:5px 7px;border:1px solid var(--ns-border,#ccc);border-radius:6px;font-size:12px}
.ns-settings-body .ns-row-inline{flex-direction:row;align-items:center;gap:6px}
.ns-settings-body button{padding:6px 12px;background:var(--ns-primary,#2563eb);color:#fff;border:0;border-radius:6px;cursor:pointer;align-self:flex-start}
.ns-hint{font-size:11px;color:var(--ns-muted,#777);margin-top:-2px}
.ns-hint.warn{color:#b45309;font-weight:600}
`;

const KIND_TAG = {
  run: "RUN",
  compile: "COMPILE",
  agent: "AGENT",
  model_call: "LLM",
  tool_call: "TOOL",
  rest_call: "REST",
  remote_fetch: "FETCH",
  remote_call: "REMOTE CALL",
  mcp_call: "MCP",
  tool_result: "RESULT",
};

export function mountApp(root, { engine, trace, manifest }) {
  const style = document.createElement("style");
  style.textContent = BASE_CSS;
  document.head.appendChild(style);

  const theme = manifest?.theme || {};
  if (theme.primary) root.style.setProperty("--ns-primary", theme.primary);

  const net = engine.top?.network;
  const title = manifest?.networks?.[0]?.description || net?.name || "Agent network";

  root.innerHTML = `
    <div class="ns-app" data-dev="false">
      <div class="ns-header">
        ${theme.logo ? `<img class="ns-logo" src="${theme.logo}" alt="logo">` : ""}
        <div class="ns-title">${escapeHtml(manifest?.brand || net?.name || "neuro-san-web")}</div>
        ${engine.mockLLM
          ? `<div class="ns-llmbadge mock" title="The default router is a deterministic mock — it ignores the model name. Add a real key + router in ⚙ settings.">⚠ MOCK LLM — no real model</div>`
          : `<div class="ns-llmbadge real" title="Real LLM via ${escapeHtml(engine.top?.llm?.baseUrl || "")}">● real LLM</div>`}
        <div class="ns-breadcrumb" id="ns-breadcrumb">${escapeHtml(location.host)}</div>
        <button class="ns-devtoggle" id="ns-devtoggle" title="Show the technical execution trace">⚙ Developer</button>
      </div>
      <main class="ns-main">
       <div class="ns-stage">
        <div class="ns-chat">
          <div class="ns-msgs" id="ns-msgs">
            <div class="ns-msg bot">${escapeHtml(title)}\n\nAsk me anything to see the web of agents in action.</div>
          </div>
          <details class="ns-settings">
            <summary>⚙ BYOK / router settings</summary>
            <div class="ns-settings-body">
              <label>API key <input id="ns-key" type="password" placeholder="sk-… (kept in this browser only — enables a REAL LLM)"></label>
              <label>Model <input id="ns-model" placeholder="e.g. gpt-4o, gpt-4o-mini"></label>
              <label>Router base URL <input id="ns-router" placeholder="OpenAI-compatible /v1"></label>
              <div id="ns-router-hint" class="ns-hint"></div>
              <label class="ns-row-inline"><input type="checkbox" id="ns-lg"> Drive the LLM via LangChain.js</label>
              <button id="ns-apply">Apply &amp; reload</button>
            </div>
          </details>
          <div class="ns-inputbar">
            <input id="ns-input" placeholder="Type a request…" />
            <button id="ns-send">Send</button>
            <button id="ns-newchat" title="Clear conversation history" style="background:transparent;color:var(--ns-muted,#888);border:1px solid var(--ns-border,#ccc)">New chat</button>
          </div>
        </div>
        <aside class="ns-agents">
          <h3>Agents working for you</h3>
          <div class="ns-status" id="ns-status"><span class="ns-spin"></span><span id="ns-status-text">Ready when you are.</span></div>
          <div id="ns-anodes"></div>
        </aside>
       </div>
      </main>
      <div class="ns-modal" id="ns-modal" hidden><div class="ns-modal-card" id="ns-modal-card"></div></div>
      <aside class="ns-dev">
        <div class="ns-graph" id="ns-graph"><h3>Agent graph &amp; origins</h3><div id="ns-nodes"></div></div>
        <div class="ns-log" id="ns-log">
          <div class="ns-toolbar">
            <h3 style="margin:0">Execution log</h3>
            <span class="ns-pill" id="ns-count">0 events</span>
            <button id="ns-export" style="margin-left:auto;font-size:11px">Export JSON</button>
          </div>
          <div id="ns-rows"></div>
        </div>
      </aside>
    </div>`;

  const msgs = root.querySelector("#ns-msgs");
  const rows = root.querySelector("#ns-rows");
  const nodesEl = root.querySelector("#ns-nodes");
  const input = root.querySelector("#ns-input");
  const sendBtn = root.querySelector("#ns-send");
  const countEl = root.querySelector("#ns-count");
  const breadcrumb = root.querySelector("#ns-breadcrumb");

  renderNodes(nodesEl, net, new Set());

  // --- trace rendering -------------------------------------------------------
  const activeOrigins = new Set();
  const activeAgents = new Set();
  let count = 0;
  // Widgets contributed by ANY agent during the current turn, consolidated and
  // rendered after the final answer.
  let pendingWidgets = [];
  trace.addEventListener("event", (e) => {
    const ev = e.detail;
    count++;
    countEl.textContent = `${count} events`;

    if (ev.phase === "note" && ev.kind === "widget" && ev.widget) pendingWidgets.push(ev.widget);

    if (ev.phase === "start") {
      if (ev.origin) activeOrigins.add(ev.origin);
      if (ev.kind === "agent" && ev.agent) activeAgents.add(ev.agent);
      addRow(rows, ev, "▶ start");
      if (ev.peerOrigin) breadcrumb.textContent = `${ev.origin} ▸ ${ev.peerOrigin}`;
    } else if (ev.phase === "end") {
      if (ev.kind === "agent" && ev.agent) activeAgents.delete(ev.agent);
      // Authoritative badge: derived from what the LLM endpoint actually returned.
      if (ev.kind === "model_call" && typeof ev.mock === "boolean") {
        const badge = root.querySelector(".ns-llmbadge");
        if (badge) {
          if (ev.mock) { badge.className = "ns-llmbadge mock"; badge.textContent = "⚠ MOCK LLM — no real model"; }
          else { badge.className = "ns-llmbadge real"; badge.textContent = `● real LLM (${ev.respModel || ev.model || "?"})`; }
        }
      }
      updateRow(rows, ev);
    } else if (ev.phase === "update") {
      // stream chunk: append to the active bot bubble handled via onAnswerDelta
    } else if (ev.phase === "note") {
      addRow(rows, ev, "•");
    }
    renderNodes(nodesEl, net, activeAgents, activeOrigins);
    rows.parentElement.scrollTop = rows.parentElement.scrollHeight;
  });

  // --- streaming answer + generative UI (CRUSE widgets) ----------------------
  let currentBot = null;
  let botBuffer = "";
  engine.onAnswerDelta = (t) => {
    botBuffer += t;
    if (!currentBot) currentBot = addBubble(msgs, "bot", "");
    currentBot.textContent = visibleText(botBuffer); // hide the cruse-ui block while streaming
    msgs.scrollTop = msgs.scrollHeight;
  };

  async function runUserTurn(text) {
    text = (text || "").trim();
    if (!text || sendBtn.disabled) return;
    input.value = "";
    sendBtn.disabled = true;
    addBubble(msgs, "user", text);
    currentBot = null;
    botBuffer = "";
    pendingWidgets = [];
    try {
      // The runtime strips cruse-ui blocks from each agent's answer and emits them
      // as "widget" trace events; we render the clean text + the consolidated widgets.
      const answer = await engine.run(text, { slyData: { backend_token: "demo-customer-token-123" } });
      const clean = visibleText(answer);
      // Always show the cleaned text — never the raw answer or retained streamed text
      // (which could be an AAOSA envelope / cruse-ui JSON). Empty is fine: widgets carry the turn.
      if (!currentBot) currentBot = addBubble(msgs, "bot", clean);
      else currentBot.textContent = clean;
      for (const w of pendingWidgets) renderWidget(msgs, w, runUserTurn);
    } catch (err) {
      addBubble(msgs, "bot", "⚠️ " + err.message);
    } finally {
      sendBtn.disabled = false;
      currentBot = null;
      botBuffer = "";
      pendingWidgets = [];
    }
  }
  const send = () => runUserTurn(input.value);

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
  root.querySelector("#ns-newchat").addEventListener("click", () => {
    engine.resetHistory();
    currentBot = null;
    [...msgs.querySelectorAll(".ns-msg, .ns-widget")].forEach((el, i) => { if (i > 0) el.remove(); });
  });

  // Developer mode: the technical execution trace is hidden by default. Reveal it
  // with the ⚙ Developer toggle or ?dev=1; the choice persists in this browser.
  const app = root.querySelector(".ns-app");
  const devToggle = root.querySelector("#ns-devtoggle");
  const store = (() => { try { return window.localStorage; } catch { return null; } })();
  let devOn = new URLSearchParams(location.search).get("dev") === "1" || store?.getItem("nsweb-dev") === "1";
  const applyDev = () => { app.dataset.dev = devOn ? "true" : "false"; devToggle.classList.toggle("on", devOn); };
  applyDev();
  devToggle.addEventListener("click", () => {
    devOn = !devOn;
    try { store?.setItem("nsweb-dev", devOn ? "1" : "0"); } catch {}
    applyDev();
  });

  // --- "Agents working for you" map (consumer transparency) ----------------
  const splitBrand = (brand) => {
    const ch = Array.from(brand || "");
    if (ch[0] && ch[0].codePointAt(0) > 0x2000) return { icon: ch[0], label: ch.slice(1).join("").trim() };
    return { icon: "🧭", label: brand || "" };
  };
  const localHost = location.host;
  const nodeMeta = new Map(); // host -> {label, role, icon, kind, origin}
  const nodeStatus = new Map(); // host -> idle|active|done
  {
    const b = splitBrand(manifest?.brand || net?.name);
    nodeMeta.set(localHost, { label: b.label || net?.name, role: "your concierge", icon: b.icon, kind: "local" });
  }
  const frontSpec = net?.getAgentSpec(net.findFrontMan());
  for (const ref of frontSpec?.tools || []) {
    const c = net.classifyTool(ref);
    try {
      if (c.kind === "remote") {
        const u = new URL(ref);
        if (!nodeMeta.has(u.host)) nodeMeta.set(u.host, { label: u.host, role: "partner network", icon: "🏢", kind: "remote", origin: u.origin });
      } else if (c.kind === "mcp") {
        const u = new URL(typeof ref === "string" ? ref : ref.url);
        if (!nodeMeta.has(u.host)) nodeMeta.set(u.host, { label: "Destination service", role: "hosted MCP server", icon: "🌐", kind: "mcp", origin: u.origin });
      }
    } catch {}
  }

  const anodesEl = root.querySelector("#ns-anodes");
  const statusEl = root.querySelector("#ns-status");
  const statusText = root.querySelector("#ns-status-text");
  const labelOf = (host) => nodeMeta.get(host)?.label || host;

  function renderANodes() {
    anodesEl.innerHTML = "";
    for (const [host, meta] of nodeMeta) {
      const st = nodeStatus.get(host) || "idle";
      const el = document.createElement("div");
      el.className = "ns-anode " + st;
      el.innerHTML = `<span class="ns-aicon">${escapeHtml(meta.icon)}</span>` +
        `<div class="ns-ameta"><div class="ns-aname">${escapeHtml(meta.label)}</div><div class="ns-arole">${escapeHtml(meta.role)}</div></div>` +
        `<span class="ns-adot" title="${st}"></span>`;
      el.addEventListener("click", () => openInspector(host));
      anodesEl.appendChild(el);
    }
  }
  renderANodes();

  // NB: we deliberately do NOT fetch peer manifests here to pretty-up the labels.
  // That would contact partner origins on page load — before the user has consented
  // to anything. Partner nodes show their host until the user approves a call and
  // resolveRemote fetches the peer; the label is then updated from that already-
  // fetched metadata (see the remote_fetch "end" handler below).

  const setActive = (host, busyText) => {
    for (const k of nodeStatus.keys()) if (nodeStatus.get(k) === "active") nodeStatus.set(k, "done");
    if (host && nodeMeta.has(host)) nodeStatus.set(host, "active");
    if (busyText) { statusText.textContent = busyText; statusEl.classList.add("busy"); }
    renderANodes();
  };

  trace.addEventListener("event", (e) => {
    const ev = e.detail;
    if (ev.phase === "start") {
      switch (ev.kind) {
        case "run": for (const k of nodeStatus.keys()) nodeStatus.set(k, "idle"); setActive(localHost, "Planning your trip…"); break;
        case "remote_fetch": setActive(ev.peerOrigin, `Loading ${labelOf(ev.peerOrigin)}…`); break;
        case "remote_call": setActive(ev.peerOrigin, `Contacting ${labelOf(ev.peerOrigin)}…`); break;
        case "mcp_call": setActive(ev.peerOrigin, `Asking ${labelOf(ev.peerOrigin)}…`); break;
        case "rest_call": statusText.textContent = `Checking ${labelOf(ev.origin)} systems…`; break;
        case "tool_call": statusText.textContent = `Running ${ev.tool}…`; break;
        case "model_call": if (nodeMeta.has(ev.origin)) setActive(ev.origin, ev.origin === localHost ? "Thinking…" : undefined); break;
        default: break;
      }
    } else if (ev.phase === "end" && ev.kind === "remote_fetch" && ev.brand) {
      // The peer was just fetched (after the user consented). Upgrade its label
      // from the now-available published brand — no pre-consent network call.
      const host = ev.peerOrigin;
      const meta = host && nodeMeta.get(host);
      if (meta) { const b = splitBrand(ev.brand); meta.label = b.label; meta.icon = b.icon; renderANodes(); }
    } else if (ev.phase === "end" && ev.kind === "run") {
      for (const k of nodeStatus.keys()) if (nodeStatus.get(k) === "active") nodeStatus.set(k, "done");
      statusEl.classList.remove("busy");
      statusText.textContent = "Done — see your answer on the left.";
      renderANodes();
    }
  });

  // --- cross-network consent (approve calls to other hosted networks) ------
  engine.onConsent = (info) => new Promise((resolve) => {
    statusEl.classList.remove("busy");
    statusText.textContent = `Waiting for your OK to contact ${info.peerLabel}…`;
    const tokens = info.est?.totalTokens ? `~${Number(info.est.totalTokens).toLocaleString()} tokens` : "";
    const cost = info.est?.costText ? ` (~${info.est.costText})` : "";
    const el = document.createElement("div");
    el.className = "ns-msg bot ns-consent";
    el.innerHTML =
      `<div class="ns-consent-title">🔗 Contact <b>${escapeHtml(info.peerLabel)}</b> on your behalf?</div>` +
      `<div class="ns-consent-sub">${escapeHtml(info.peerOrigin)}${tokens ? " · est. " + escapeHtml(tokens) + escapeHtml(cost) : ""}</div>` +
      (info.requestText ? `<div class="ns-consent-req">“${escapeHtml(info.requestText.slice(0, 140))}”</div>` : "") +
      `<div class="ns-consent-actions">` +
        `<button data-d="allow">Allow</button>` +
        `<button data-d="always">Always allow</button>` +
        `<button data-d="decline" class="ghost">Decline</button>` +
      `</div>`;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    el.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        const d = b.dataset.d;
        el.querySelector(".ns-consent-actions").outerHTML =
          `<div class="ns-consent-done">${d === "decline" ? "✕ Declined" : "✓ Allowed"}</div>`;
        statusEl.classList.add("busy");
        statusText.textContent = d === "decline" ? "Skipping that partner…" : `Contacting ${info.peerLabel}…`;
        resolve(d);
      }, { once: true }),
    );
  });

  // --- node inspector (instructions + what the agent did) ------------------
  const modal = root.querySelector("#ns-modal");
  const modalCard = root.querySelector("#ns-modal-card");
  const closeModal = () => { modal.hidden = true; };
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  function friendlyActivity(ev) {
    switch (ev.kind) {
      case "remote_call": return ev.phase === "start"
        ? `→ Asked: “${(ev.requestPayload?.user_message?.text || "").slice(0, 120)}”`
        : `← Replied: ${(ev.responsePreview || "").slice(0, 140)}`;
      case "mcp_call": return ev.phase === "end" ? `MCP ${ev.method}` : null;
      case "tool_call": return ev.phase === "end" ? `Ran tool: ${ev.tool}` : null;
      case "rest_call": return ev.phase === "end" ? `Backend call: ${ev.url}` : null;
      case "model_call": return ev.phase === "end" ? `LLM call (${ev.model || "?"})${ev.mock ? " [mock]" : ""}` : null;
      case "agent": return ev.phase === "start" ? `Agent “${ev.agent}” started` : null;
      default: return null;
    }
  }

  function openInspector(host) {
    const meta = nodeMeta.get(host);
    if (!meta) return;
    let instructions = "";
    if (meta.kind === "local") {
      instructions = net.getAgentSpec(net.findFrontMan())?.instructions?.trim() || "";
    } else {
      const sess = [...(engine.registry?.cache?.values() || [])].find((s) => { try { return new URL(s.base).host === host; } catch { return false; } });
      if (sess) instructions = sess.network.getAgentSpec(sess.network.findFrontMan())?.instructions?.trim() || "";
    }
    const acts = trace.events.filter((ev) => ev.phase !== "update" && (ev.origin === host || ev.peerOrigin === host)).map(friendlyActivity).filter(Boolean);
    modalCard.innerHTML =
      `<button class="ns-modal-close" title="Close">×</button>` +
      `<h4>${escapeHtml(meta.icon)} ${escapeHtml(meta.label)}</h4>` +
      `<div class="ns-mrole">${escapeHtml(meta.role)} · ${escapeHtml(host)}</div>` +
      `<h5>Instructions</h5>` +
      (instructions ? `<pre>${escapeHtml(instructions)}</pre>` : `<div class="ns-mrole">Loaded when first contacted.</div>`) +
      `<h5>What it did this session</h5>` +
      (acts.length ? acts.map((a) => `<div class="ns-mact">${escapeHtml(a)}</div>`).join("") : `<div class="ns-mrole">Nothing yet.</div>`);
    modalCard.querySelector(".ns-modal-close").addEventListener("click", closeModal);
    modal.hidden = false;
  }

  // BYOK / router settings: prefill from current state. The key lives ONLY in
  // sessionStorage (this tab) and is never written to the URL; router/model are
  // non-secret and ride in the query string so links stay shareable.
  const params = new URLSearchParams(location.search);
  const routerEl = root.querySelector("#ns-router");
  const keyEl = root.querySelector("#ns-key");
  const hintEl = root.querySelector("#ns-router-hint");
  const mockUrl = engine.top?.llm?.baseUrl || "";
  const byokRouter = engine.byokRouter || "";

  routerEl.value = engine.routerOverride || mockUrl;
  root.querySelector("#ns-model").value = engine.modelOverride || "";
  let storedKey = "";
  try { storedKey = sessionStorage.getItem("nsweb-byok-key") || ""; } catch {}
  keyEl.value = storedKey;
  root.querySelector("#ns-lg").checked = !!engine.agentRunner;

  const isMockRouter = (url) => !url || (engine.mockLLM && url === mockUrl) || /:8003(\/|$)/.test(url);
  const refreshHint = () => {
    const hasKey = keyEl.value.trim().length > 0;
    if (hasKey && isMockRouter(routerEl.value.trim())) {
      hintEl.className = "ns-hint warn";
      hintEl.textContent = `⚠ This router is the MOCK (ignores your key). It will be switched to the real proxy ${byokRouter || ""} on Apply.`;
    } else if (isMockRouter(routerEl.value.trim())) {
      hintEl.className = "ns-hint";
      hintEl.textContent = `Mock router (no key needed). To use a real LLM, enter a key — it will route via ${byokRouter || "the proxy"}.`;
    } else {
      hintEl.className = "ns-hint";
      hintEl.textContent = "Real LLM router. Your key is sent only here (a CORS pass-through to your provider).";
    }
  };
  // When a key is entered against the mock router, auto-fill the real proxy.
  keyEl.addEventListener("input", () => {
    if (keyEl.value.trim() && byokRouter && isMockRouter(routerEl.value.trim())) routerEl.value = byokRouter;
    refreshHint();
  });
  routerEl.addEventListener("input", refreshHint);
  refreshHint();

  root.querySelector("#ns-apply").addEventListener("click", () => {
    const p = new URLSearchParams(location.search);
    p.delete("key"); // the key must never appear in the URL
    let router = routerEl.value.trim();
    const key = keyEl.value.trim();
    const model = root.querySelector("#ns-model").value.trim();
    // Safety net: a real key must never be sent to the mock router.
    if (key && byokRouter && isMockRouter(router)) router = byokRouter;
    // The key is kept in sessionStorage (this tab only), never the query string.
    try {
      if (key) sessionStorage.setItem("nsweb-byok-key", key);
      else sessionStorage.removeItem("nsweb-byok-key");
    } catch {}
    if (router) p.set("router", router); else p.delete("router");
    if (model) p.set("model", model); else p.delete("model");
    if (root.querySelector("#ns-lg").checked) p.set("runner", "langchain"); else p.delete("runner");
    const qs = p.toString();
    // Rewrite the (key-free) query string, then reload so the change applies even
    // when only the key changed (router/model unchanged).
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch {}
    location.reload();
  });
  root.querySelector("#ns-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(trace.export(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agent-trace.json";
    a.click();
  });

  // Optional landing form: if this site's manifest declares a `welcome` widget,
  // render it on load (with an intro line) so the site doesn't open as a bare
  // chatbot. Submitting it passes the composed input to the agent; the user can
  // also just type a query instead. Authored by the site, collects customer info.
  if (manifest?.welcome?.widget) {
    const greet = msgs.querySelector(".ns-msg.bot");
    if (manifest.welcome.message && greet) greet.textContent = manifest.welcome.message;
    renderWidget(msgs, manifest.welcome.widget, runUserTurn);
  }
}

function addBubble(msgs, cls, text) {
  const el = document.createElement("div");
  el.className = `ns-msg ${cls}`;
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}

// --- CRUSE generative-UI: parse a fenced ```cruse-ui {json}``` block ---------
function visibleText(s) {
  if (!s) return "";
  let out = s.replace(/```cruse-ui[\s\S]*?```/g, "").trim();
  const i = out.indexOf("```cruse-ui");
  if (i >= 0) out = out.slice(0, i).trim();
  return unwrapAaosa(out);
}

// neuro-san agents speak the AAOSA wire format: a JSON envelope with a "Mode" plus
// Name/Inquiry (and Response/Requirements/…), sometimes wrapped in <tool_response>
// tags. Only the human-facing parts are meant for the user; the rest is inter-agent
// protocol the framework normally unwraps. Surface that and drop the envelope/tags so
// they never leak into the chat. Applied only at display time — inter-agent results
// keep their structure.
function unwrapAaosa(s) {
  if (!s) return s;
  const t = s.replace(/<\/?tool_(?:response|call)>/gi, "").trim();
  // Only act on an AAOSA envelope: a JSON object with a "Mode" plus "Name"/"Inquiry".
  if (!/"Mode"\s*:/.test(t) || !t.includes("{")) return t;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (end <= start) return t;
  const obj = tolerantParse(t.slice(start, end + 1));
  if (!obj || obj.Mode === undefined || (obj.Name === undefined && obj.Inquiry === undefined)) return t;
  // Fulfill / clarify mode: the human-facing answer.
  if (typeof obj.Response === "string" && obj.Response.trim()) return obj.Response.trim();
  // Determine mode: a request for info — surface the requirement prompts as a question.
  if (Array.isArray(obj.Requirements)) {
    const qs = obj.Requirements.map((r) => r && (r.description || r.title)).filter(Boolean);
    if (qs.length) return qs.join("\n");
  }
  return "";  // pure protocol with nothing user-facing → show nothing (never the raw JSON)
}

function tolerantParse(s) {
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1")); } catch {}
  return null;
}
function lockWidget(card) {
  card.querySelectorAll("button,input,select,textarea").forEach((el) => (el.disabled = true));
  card.classList.add("done");
}

// Render one schema property. Widgets are generated by LLMs / partner agents, so
// every interpolated value is untrusted. We never put the schema KEY (or any other
// untrusted string) into an HTML attribute or a CSS selector: each field gets a
// runtime-assigned, selector-safe id (`f0`, `f1`, …). Titles/enums are HTML-escaped;
// numeric bounds are coerced to real numbers. This closes the widget XSS surface.
function renderField(fid, key, f, req) {
  const ui = f["x-ui"] || {};
  const label = `<label class="ns-w-label">${escapeHtml(f.title || key)}${req ? " *" : ""}</label>`;
  const desc = f.description ? `<div class="ns-w-fdesc">${escapeHtml(f.description)}</div>` : "";
  const enumVals = Array.isArray(f.enum) ? f.enum.map((v) => escapeHtml(v)) : [];
  const itemVals = Array.isArray(f.items?.enum) ? f.items.enum.map((v) => escapeHtml(v)) : [];
  const min = Number(f.minimum);
  const max = Number(f.maximum);
  let ctl;
  if (enumVals.length && ui.widget === "radio") {
    ctl = `<div class="ns-w-radio">` + enumVals.map((v) => `<label><input type="radio" name="${fid}" value="${v}"> ${v}</label>`).join("") + `</div>`;
  } else if (enumVals.length) {
    ctl = `<select data-field="${fid}"><option value="">—</option>` + enumVals.map((v) => `<option value="${v}">${v}</option>`).join("") + `</select>`;
  } else if (f.type === "boolean") {
    ctl = `<label class="ns-w-toggle"><input type="checkbox" data-field="${fid}"> Yes</label>`;
  } else if (f.type === "array" && itemVals.length) {
    ctl = `<div class="ns-w-multi" data-field="${fid}">` + itemVals.map((v) => `<label><input type="checkbox" value="${v}"> ${v}</label>`).join("") + `</div>`;
  } else if (f.type === "number" || f.type === "integer") {
    ctl = `<input type="number" data-field="${fid}"${Number.isFinite(min) ? ` min="${min}"` : ""}${Number.isFinite(max) ? ` max="${max}"` : ""}>`;
  } else if (f.format === "date") {
    ctl = `<input type="date" data-field="${fid}">`;
  } else if (ui.widget === "textarea") {
    ctl = `<textarea data-field="${fid}" rows="3"></textarea>`;
  } else {
    ctl = `<input type="text" data-field="${fid}">`;
  }
  return `<div class="ns-w-row">${label}${desc}${ctl}</div>`;
}

// `entries` is the same Object.entries(props) array used to render, so index i
// maps to the field id `f${i}` (selector-safe; the untrusted key is never queried).
function collectForm(card, entries) {
  const vals = {};
  entries.forEach(([key, f], i) => {
    const fid = "f" + i;
    if (Array.isArray(f.enum) && f["x-ui"]?.widget === "radio") {
      const sel = card.querySelector(`input[name="${fid}"]:checked`);
      vals[key] = sel ? sel.value : "";
    } else if (f.type === "array" && f.items?.enum) {
      const box = card.querySelector(`[data-field="${fid}"]`);
      vals[key] = box ? [...box.querySelectorAll("input:checked")].map((i2) => i2.value) : [];
    } else if (f.type === "boolean") {
      const el = card.querySelector(`[data-field="${fid}"]`);
      vals[key] = el && el.checked ? "yes" : "no";
    } else {
      const el = card.querySelector(`[data-field="${fid}"]`);
      vals[key] = el ? el.value : "";
    }
  });
  return vals;
}

// Render a widget inline and feed the user's interaction back as the next turn.
function renderWidget(container, spec, onSubmit) {
  const kind = spec.kind || (spec.schema ? "form" : "info");
  const card = document.createElement("div");
  card.className = "ns-widget";
  // spec.color is untrusted (LLM/partner-supplied). Only accept a plain CSS color
  // token (#hex, rgb()/hsl(), or a bare keyword) so it can't smuggle extra CSS.
  if (spec.color && /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|(rgb|hsl)a?\([0-9.,%\s/]+\))$/.test(String(spec.color).trim())) {
    card.style.setProperty("--w", String(spec.color).trim());
  }
  let html = `<div class="ns-w-head">${spec.icon ? `<span class="ns-w-icon">${escapeHtml(spec.icon)}</span>` : ""}<b>${escapeHtml(spec.title || "")}</b></div>`;
  if (spec.description) html += `<div class="ns-w-desc">${escapeHtml(spec.description)}</div>`;

  if (kind === "confirm") {
    html += `<div class="ns-w-actions"><button class="ns-w-btn" data-act="confirm">${escapeHtml(spec.confirmLabel || "Confirm")}</button><button class="ns-w-btn ghost" data-act="cancel">${escapeHtml(spec.cancelLabel || "Cancel")}</button></div>`;
    card.innerHTML = html;
    card.querySelector('[data-act="confirm"]').addEventListener("click", () => { lockWidget(card); onSubmit(spec.confirmText || spec.confirmLabel || "Confirm"); });
    card.querySelector('[data-act="cancel"]').addEventListener("click", () => { lockWidget(card); onSubmit(spec.cancelText || "Not yet, hold off."); });
  } else if (kind === "choice") {
    html += `<div class="ns-w-choices">` + (spec.options || []).map((o, idx) =>
      `<button class="ns-w-choice" data-idx="${idx}"><div class="ns-w-ctitle">${escapeHtml(o.title || o.value || "")}</div>${o.subtitle ? `<div class="ns-w-csub">${escapeHtml(o.subtitle)}</div>` : ""}${o.meta ? `<div class="ns-w-cmeta">${escapeHtml(o.meta)}</div>` : ""}</button>`).join("") + `</div>`;
    card.innerHTML = html;
    card.querySelectorAll(".ns-w-choice").forEach((b) => b.addEventListener("click", () => {
      const o = (spec.options || [])[+b.dataset.idx];
      lockWidget(card);
      onSubmit(`${spec.choosePrefix || "I'll go with"}: ${o.title || o.value}`);
    }));
  } else if (kind === "info") {
    html += `<div class="ns-w-fields">` + Object.entries(spec.fields || {}).map(([k, v]) =>
      `<div class="ns-w-field"><span class="ns-w-fk">${escapeHtml(k)}</span><span class="ns-w-fv">${escapeHtml(String(v))}</span></div>`).join("") + `</div>`;
    card.innerHTML = html;
  } else { // form
    const props = (spec.schema && spec.schema.properties) || {};
    const required = (spec.schema && spec.schema.required) || [];
    const entries = Object.entries(props);
    html += `<form class="ns-w-form">` + entries.map(([key, f], i) => renderField("f" + i, key, f, required.includes(key))).join("") +
      `<div class="ns-w-actions"><button type="submit" class="ns-w-btn">${escapeHtml(spec.submitLabel || "Submit")}</button></div></form>`;
    card.innerHTML = html;
    card.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const vals = collectForm(card, entries);
      lockWidget(card);
      const summary = (spec.title ? `${spec.title} — ` : "") +
        Object.entries(vals).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && v.length === 0))
          .map(([k, v]) => `${props[k]?.title || k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("; ");
      onSubmit(summary || "(submitted)");
    });
  }
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  return card;
}

function renderNodes(el, net, activeAgents, activeOrigins = new Set()) {
  if (!net) return;
  const parts = [];
  for (const a of net.config.tools || []) {
    const cls = activeAgents.has(a.name) ? "ns-node active" : "ns-node";
    const isRemote = (a.tools || []).some((t) => typeof t === "string" && /^https?:/.test(t));
    parts.push(`<span class="${cls}" title="${escapeHtml(a.function?.description || "")}">${escapeHtml(a.name)}${a.class ? " ⚙" : ""}</span>`);
  }
  // remote origins
  const origins = new Set();
  for (const a of net.config.tools || []) {
    for (const t of a.tools || []) {
      if (typeof t === "string" && /^https?:/.test(t)) {
        try {
          origins.add(new URL(t).host);
        } catch {}
      }
    }
  }
  for (const o of origins) {
    const cls = activeOrigins.has(o) ? "ns-node origin active" : "ns-node origin";
    parts.push(`<span class="${cls}">🌐 ${escapeHtml(o)}</span>`);
  }
  el.innerHTML = parts.join("");
}

function rowLabel(ev) {
  const tag = ev.kind === "model_call" && ev.mock ? "MOCK" : KIND_TAG[ev.kind] || ev.kind.toUpperCase();
  let detail = "";
  switch (ev.kind) {
    case "run": detail = escapeHtml(ev.input || ""); break;
    case "agent": detail = `${escapeHtml(ev.agent)} <span class="ns-meta">@ ${escapeHtml(ev.origin || "")}</span>`; break;
    case "model_call": {
      const via = ev.routerHost ? ` via ${escapeHtml(ev.routerHost)}` : "";
      const flag = ev.mock ? ' <span style="color:#b45309;font-weight:700">[MOCK — not a real LLM]</span>' : "";
      detail = `${escapeHtml(ev.model || "")}${flag} <span class="ns-meta">${via} · key: ${escapeHtml(ev.keySource || "")}</span>`;
      break;
    }
    case "tool_call": detail = `${escapeHtml(ev.tool || "")} <span class="ns-meta">(${escapeHtml(ev.toolKind || "")})</span>`; break;
    case "rest_call": detail = `${escapeHtml(ev.method || "GET")} ${escapeHtml(ev.url || "")}`; break;
    case "remote_fetch": detail = `${escapeHtml(ev.peerOrigin || "")} <span class="ns-meta">${escapeHtml(ev.url || "")}</span>`; break;
    case "remote_call": detail = `${escapeHtml(ev.peerOrigin || "")}/${escapeHtml(ev.network || "")} <span class="ns-meta">via ${escapeHtml(ev.method || "")}</span>`; break;
    case "mcp_call": detail = `${escapeHtml(ev.method || "")} <span class="ns-meta">@ ${escapeHtml(ev.peerOrigin || "")}</span>`; break;
    case "tool_result": detail = `${escapeHtml(ev.tool || "")} <span class="ns-meta">${escapeHtml((ev.preview || "").slice(0, 80))}</span>`; break;
    default: detail = "";
  }
  return `<span class="ns-tag">${tag}</span>${detail}`;
}

function detailJson(ev) {
  const keep = {};
  for (const k of ["fetchedUrls", "requestPayload", "args", "result", "headers", "toolNames", "usage", "responsePreview", "preview", "errors", "warnings", "peers", "error", "httpStatus", "url", "method", "endpoint", "routerHost", "mock"]) {
    if (ev[k] !== undefined) keep[k] = ev[k];
  }
  return Object.keys(keep).length ? JSON.stringify(keep, null, 2) : "";
}

function addRow(rows, ev, marker) {
  const div = document.createElement("div");
  div.className = `ns-row k-${ev.kind}` + (ev.status === "error" ? " status-error" : "");
  if (ev.id) div.dataset.id = ev.id;
  const json = detailJson(ev);
  div.innerHTML = `<div class="ns-line">${rowLabel(ev)}</div>` + (json ? `<pre style="display:none">${escapeHtml(json)}</pre>` : "");
  if (json) {
    div.addEventListener("click", () => {
      const pre = div.querySelector("pre");
      pre.style.display = pre.style.display === "none" ? "block" : "none";
    });
  }
  rows.appendChild(div);
}

function updateRow(rows, ev) {
  const existing = ev.id ? rows.querySelector(`[data-id="${ev.id}"]`) : null;
  if (!existing) {
    addRow(rows, ev, "✓");
    return;
  }
  if (ev.status === "error") existing.classList.add("status-error");
  const ms = ev.durationMs != null ? ` <span class="ns-meta">· ${Math.round(ev.durationMs)}ms</span>` : "";
  const err = ev.error ? ` <span class="ns-meta" style="color:#dc2626">· ${escapeHtml(ev.error)}</span>` : "";
  existing.querySelector(".ns-line").innerHTML = rowLabel(ev) + ms + err;
  const json = detailJson(ev);
  if (json) {
    let pre = existing.querySelector("pre");
    if (!pre) {
      pre = document.createElement("pre");
      pre.style.display = "none";
      existing.appendChild(pre);
      existing.addEventListener("click", () => {
        pre.style.display = pre.style.display === "none" ? "block" : "none";
      });
    }
    pre.textContent = json;
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
