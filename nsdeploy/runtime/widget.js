/** Isolated, lazy-loading container for a static nsdeploy agent page. */
export class AgentWidget extends HTMLElement {
  /** Mount once so collapsing the panel preserves its iframe and conversation. */
  connectedCallback() {
    if (this.shadowRoot) {
      window.addEventListener("message", this.message_handler);
      return;
    }
    const source = new URL(this.getAttribute("src"), document.baseURI);
    if (!['http:', 'https:'].includes(source.protocol)) {
      throw new Error("Agent requires HTTP(S) hosting.");
    }
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host{all:initial;font:14px system-ui,sans-serif;color:#172b36;--agent-color:#175e57}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,a{font:inherit} button{cursor:pointer;border:0;border-radius:10px;padding:10px 14px}
      button:focus-visible,a:focus-visible{outline:3px solid #d58c22;outline-offset:3px}
      .launcher{position:fixed;bottom:24px;right:24px;z-index:10000;display:flex;gap:4px;
        padding:4px;border-radius:32px;background:var(--agent-color);box-shadow:0 6px 24px #0003}
      .launcher button{background:transparent;color:white;min-height:44px}
      .open{font-weight:650;padding:10px 18px}.hide{padding:8px}
      .panel{position:fixed;right:24px;bottom:90px;z-index:10000;width:min(430px,calc(100vw - 32px));
        height:min(690px,calc(100dvh - 112px));display:flex;flex-direction:column;background:white;
        border:1px solid #d9e3e0;border-radius:18px;overflow:hidden;box-shadow:0 12px 48px #0003}
      header{display:flex;align-items:center;gap:8px;padding:9px 14px;background:#f0f6f3;border-bottom:1px solid #d9e3e0}
      strong{flex:1}a{color:#175e57;font-size:12px}header button{background:transparent;min-height:44px}
      iframe{border:0;width:100%;flex:1;min-height:0;background:white}
      :host([mode="inline"]){display:block;height:650px;min-height:360px}
      :host([mode="inline"]) .panel{position:relative;inset:auto;width:100%;height:100%;box-shadow:none}
      :host([mode="inline"]) .launcher{position:static;display:inline-flex}
      @media(max-width:520px){:host(:not([mode="inline"])) .panel{inset:0;width:100%;height:100dvh;
        border-radius:0}:host(:not([mode="inline"])) .panel:not([hidden])~.launcher{display:none}}
    </style>
    <section class="panel" role="dialog" aria-label="Agent" hidden>
      <header><strong>Agent</strong><a target="_blank" rel="noopener">Open full page</a>
      <button class="close" aria-label="Close Agent">✕</button></header>
    </section>
    <div class="launcher"><button class="open" aria-expanded="false">Agent</button>
      <button class="hide" aria-label="Hide Agent for this session" title="Hide for this session">✕</button></div>`;
    this.source = source.href;
    this.panel = root.querySelector(".panel");
    this.launcher = root.querySelector(".launcher");
    this.open_button = root.querySelector(".open");
    root.querySelector("a").href = new URL("index.html", this.source).href;
    this.open_button.addEventListener("click", this.open.bind(this));
    root.querySelector(".close").addEventListener("click", this.close.bind(this));
    root.querySelector(".hide").addEventListener("click", this.dismiss.bind(this));
    root.addEventListener("keydown", this.keydown.bind(this));
    this.message_handler = this.message.bind(this);
    window.addEventListener("message", this.message_handler);
    if (this.getAttribute("mode") === "inline") {
      this.open(false);
    } else {
      try {
        this.launcher.hidden = sessionStorage.getItem(`agent-hidden:${this.source}`) === "true";
      } catch (error) {
        console.warn("Agent dismissal cannot be restored:", error);
      }
    }
  }

  /** Release the global listener when a host application removes this element. */
  disconnectedCallback() {
    window.removeEventListener("message", this.message_handler);
  }

  /** Open the agent without reloading a conversation; load nothing before first use. */
  open(focus = true) {
    this.launcher.hidden = true;
    this.panel.hidden = false;
    this.open_button.setAttribute("aria-expanded", "true");
    if (!this.frame) {
      this.frame = document.createElement("iframe");
      this.frame.title = "Agent chat and settings";
      this.frame.src = this.source;
      this.panel.append(this.frame);
    }
    if (focus) {
      this.shadowRoot.querySelector(".close").focus();
    }
  }

  /** Collapse the frame and return keyboard focus to the launcher. */
  close() {
    this.panel.hidden = true;
    this.launcher.hidden = false;
    this.open_button.setAttribute("aria-expanded", "false");
    this.open_button.focus();
  }

  /** Hide the launcher until the browser session ends. */
  dismiss() {
    this.launcher.hidden = true;
    try {
      sessionStorage.setItem(`agent-hidden:${this.source}`, "true");
    } catch (error) {
      console.warn("Agent dismissal cannot be saved:", error);
    }
  }

  /** Accept Escape requests only from this widget's frame and exact origin. */
  message(event) {
    if (event.source === this.frame?.contentWindow && event.origin === new URL(this.source).origin
        && event.data === "nsdeploy:close") {
      this.close();
    }
  }

  /** Support keyboard dismissal outside the iframe. */
  keydown(event) {
    if (event.key === "Escape" && !this.panel.hidden) {
      this.close();
    }
  }
}

if (!customElements.get("nsdeploy-widget")) {
  customElements.define("nsdeploy-widget", AgentWidget);
}
