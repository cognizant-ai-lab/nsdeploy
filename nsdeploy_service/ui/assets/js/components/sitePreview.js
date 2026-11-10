/**
 * The live preview in the design editor: the deployed chat UI, drawn from a
 * draft theme, before anything is written.
 *
 * Built against the same contract the real site uses — the `--ns-*` custom
 * properties nsdeploy emits (`_root_vars` in nsdeploy/generate.py) and the
 * `.ns-*` class names its runtime emits (nsdeploy/runtime/ui.js, and the
 * fuller design study in nsdeploy_service/chat-ui-preview.html). Every colour,
 * radius and face here resolves through those properties and none is hardcoded,
 * so setting the draft's tokens recolours this exactly as it recolours a
 * deployed site.
 *
 * It renders in an iframe, for two reasons: the console's own stylesheet must
 * not reach a surface standing in for someone else's site, and the preview's
 * `font-family` and page background must not reach the console. The frame is
 * `srcdoc` + `sandbox="allow-same-origin"` — same origin so the editor can
 * reach in and restyle it without a reload, and no `allow-scripts`, so nothing
 * in the preview can ever execute. The draft is applied by rewriting one
 * <style> element, which is why dragging a colour slider costs no request.
 *
 * It is a FAITHFUL but GENERIC shell: the standard header/chat/agents surfaces,
 * not a model-authored layout. A network whose theme carries its own `body` has
 * a layout this cannot show, which is why the editor says so out loud rather
 * than implying the preview is the whole truth.
 */
import { esc } from '../util/dom.js';

/** The chrome the mock draws, in the runtime's own class names. */
const BODY = `
<div class="ns-app">
  <header class="ns-header">
    <div class="ns-brand"><span class="ns-icon" data-slot="icon"></span>
      <span class="ns-brandtext">
        <strong data-slot="brand"></strong>
        <small data-slot="tagline"></small>
      </span>
    </div>
    <div class="ns-headmeta"><span class="ns-dot"></span>online</div>
  </header>
  <div class="ns-body">
    <section class="ns-chat">
      <div class="ns-msgs">
        <div class="ns-msg ns-msg--agent">
          <div class="ns-avatar"></div>
          <div class="ns-bubble" data-slot="hero"></div>
        </div>
        <div class="ns-msg ns-msg--user">
          <div class="ns-bubble ns-bubble--user">Can you book me a slot on Saturday?</div>
        </div>
        <div class="ns-msg ns-msg--agent">
          <div class="ns-avatar"></div>
          <div class="ns-bubble">
            Saturday has two openings left.
            <div class="ns-widget">
              <div class="ns-widget__row"><span>09:30</span><span class="ns-chip">free</span></div>
              <div class="ns-widget__row"><span>14:00</span><span class="ns-chip">free</span></div>
              <button class="ns-btn" type="button">Reserve</button>
            </div>
          </div>
        </div>
      </div>
      <div class="ns-inputbar">
        <div class="ns-input">Ask something…</div>
        <button class="ns-send" type="button">Send</button>
      </div>
    </section>
    <aside class="ns-agents">
      <div class="ns-agents__title">Agents</div>
      <div class="ns-anode ns-anode--active"><span class="ns-anode__dot"></span>concierge</div>
      <div class="ns-anode"><span class="ns-anode__dot"></span>scheduler</div>
      <div class="ns-anode"><span class="ns-anode__dot"></span>inventory</div>
    </aside>
  </div>
</div>`;

/* Deliberately not a copy of the runtime's BASE_CSS: this is the smallest set of
   rules that puts the same surfaces in the same relationship, so the tokens are
   judged in context. Where the runtime and this disagree in a detail, the
   tokens still resolve identically — that is what the preview is for. */
const CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  font-family:var(--ns-font);
  color:var(--ns-fg);
  background:radial-gradient(1200px 500px at 20% -10%,var(--ns-bg-tint) 0%,var(--ns-bg) 60%);
  padding:14px;
  font-size:13px;
  -webkit-font-smoothing:antialiased;
}
.ns-app{
  height:100%;display:flex;flex-direction:column;overflow:hidden;
  background:var(--ns-panelbg);
  border:1px solid var(--ns-border);
  border-radius:var(--ns-radius);
  box-shadow:0 10px 30px -18px rgba(0,0,0,.45);
}
.ns-header{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:11px 13px;border-bottom:1px solid var(--ns-border);
}
.ns-brand{display:flex;align-items:center;gap:9px;min-width:0}
.ns-icon{
  display:grid;place-items:center;width:28px;height:28px;flex:none;font-size:15px;
  border-radius:calc(var(--ns-radius) * 0.55);
  background:var(--ns-user-bg);
}
.ns-icon:empty{display:none}
.ns-brandtext{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.ns-brandtext strong{font-size:14px;font-weight:650;letter-spacing:-0.01em}
.ns-brandtext small{color:var(--ns-muted);font-size:11px}
.ns-brandtext small:empty{display:none}
.ns-headmeta{display:flex;align-items:center;gap:5px;color:var(--ns-muted);font-size:11px;flex:none}
.ns-dot{width:6px;height:6px;border-radius:50%;background:var(--ns-accent)}
.ns-body{display:flex;min-height:0;flex:1}
.ns-chat{display:flex;flex-direction:column;min-width:0;flex:1}
/* Bottom-anchored, like a real transcript: when the frame is shorter than the
   mock conversation it is the OLDEST message that scrolls out of sight, not the
   newest. Clipping the latest reply mid-widget read as a broken layout. */
.ns-msgs{
  flex:1;overflow:hidden;padding:13px;
  display:flex;flex-direction:column;justify-content:flex-end;gap:11px;
}
.ns-msg{display:flex;gap:8px;align-items:flex-start;max-width:86%}
.ns-msg--user{align-self:flex-end}
.ns-avatar{
  width:22px;height:22px;border-radius:50%;flex:none;margin-top:2px;
  background:var(--ns-user-bg);opacity:.9;
}
.ns-bubble{
  background:var(--ns-msgbg);
  border:1px solid var(--ns-border);
  border-radius:calc(var(--ns-radius) * 0.8);
  padding:8px 11px;line-height:1.45;
}
.ns-bubble--user{
  background:var(--ns-user-bg);color:#fff;border-color:transparent;
}
.ns-widget{
  margin-top:9px;padding:9px;display:flex;flex-direction:column;gap:6px;
  background:var(--ns-panelbg);
  border:1px solid var(--ns-border);
  border-radius:calc(var(--ns-radius) * 0.7);
}
.ns-widget__row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.ns-chip{
  font-size:10px;padding:2px 7px;color:var(--ns-primary);
  border:1px solid var(--ns-primary);border-radius:999px;
}
.ns-btn,.ns-send{
  font:inherit;font-weight:600;font-size:12px;cursor:default;color:#fff;
  background:var(--ns-primary);border:0;
  border-radius:calc(var(--ns-radius) * 0.6);
  padding:7px 13px;
}
.ns-inputbar{
  display:flex;align-items:center;gap:8px;padding:11px 13px;
  border-top:1px solid var(--ns-border);
}
.ns-input{
  flex:1;color:var(--ns-muted);
  background:var(--ns-bg);
  border:1px solid var(--ns-border);
  border-radius:calc(var(--ns-radius) * 0.6);
  padding:8px 11px;
}
.ns-agents{
  width:124px;flex:none;padding:13px 11px;display:flex;flex-direction:column;gap:7px;
  border-left:1px solid var(--ns-border);background:var(--ns-bg);
}
.ns-agents__title{
  color:var(--ns-muted);font-size:10px;font-weight:700;
  letter-spacing:.09em;text-transform:uppercase;
}
.ns-anode{
  display:flex;align-items:center;gap:6px;font-size:11.5px;padding:6px 8px;
  background:var(--ns-panelbg);
  border:1px solid var(--ns-border);
  border-radius:calc(var(--ns-radius) * 0.55);
}
.ns-anode__dot{width:5px;height:5px;border-radius:50%;background:var(--ns-muted);flex:none}
.ns-anode--active{border-color:var(--ns-primary)}
.ns-anode--active .ns-anode__dot{background:var(--ns-primary)}
@media (max-width:460px){.ns-agents{display:none}}`;

/**
 * The draft as a `:root` block, matching what a build emits.
 *
 * Same declarations as `_root_vars` in nsdeploy/generate.py, including
 * `--ns-user-bg` — a gradient derived from two tokens rather than a token of
 * its own, so it has to be recomputed here or the user bubble would not follow
 * the primary colour.
 *
 * `--ns-bg-tint` is the one addition: a real build inlines `bg_tint` straight
 * into the page-background gradient instead of exposing it as a property, and
 * the preview needs it as one to restyle without rebuilding its stylesheet.
 */
export function rootVars(tokens) {
  const c = tokens.colors || {};
  return `:root{
  --ns-font:${tokens.font};
  --ns-bg:${c.bg};--ns-bg-tint:${c.bg_tint};--ns-fg:${c.fg};--ns-muted:${c.muted};
  --ns-border:${c.border};--ns-primary:${c.primary};--ns-accent:${c.accent};
  --ns-msgbg:${c.msgbg};--ns-panelbg:${c.panelbg};
  --ns-user-bg:linear-gradient(135deg,${c.primary},${c.accent});
  --ns-radius:${tokens.radius}px;
}`;
}

/** The iframe's one-time document. Tokens arrive separately, via update(). */
export function frameDoc() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style id="ns-tokens"></style><style>${CSS}</style></head>
<body>${BODY}</body></html>`;
}

/**
 * Push a draft into an already-loaded preview frame.
 *
 * Only the token stylesheet and the three copy slots change, so the frame is
 * never reloaded: a reload would flash, lose scroll, and make dragging a colour
 * slider feel like a network operation.
 */
export function update(frame, tokens) {
  const doc = frame?.contentDocument;
  if (!doc?.getElementById('ns-tokens')) return;
  doc.getElementById('ns-tokens').textContent = rootVars(tokens);
  const slot = (name, value) => {
    const node = doc.querySelector(`[data-slot="${name}"]`);
    if (node) node.textContent = value;
  };
  slot('icon', tokens.icon || '');
  slot('brand', tokens.brand || 'Your network');
  slot('tagline', tokens.tagline || '');
  // The hero is a welcome-form greeting on a real site; standing in as the first
  // agent message is what makes an empty one obvious without faking a form.
  slot('hero', tokens.hero || 'Hello — ask me anything about this network.');
}

/** The frame element itself, ready to be inserted. */
export function frameHtml({ label = 'Preview of the deployed site' } = {}) {
  return `<iframe class="design__frame" id="design-frame" title="${esc(label)}"
                  sandbox="allow-same-origin" srcdoc="${esc(frameDoc())}"></iframe>`;
}
