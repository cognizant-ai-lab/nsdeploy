"""
Tier-1 LLM-assisted theming (optional, opt-in).

Given a deployment plan's *identity* (name, description, sample queries, agent
roles), an LLM proposes a validated theme: palette tokens, font, radius,
brand/icon/tagline copy, an optional CRUSE welcome form, AND a creative, domain-fit
page layout (CSS + HTML). nsdeploy bakes that into the generated index.html + manifest.

The LLM's CSS/HTML is treated as untrusted: it is strictly sanitized here (allowlist
of presentational tags/attrs; no scripts/handlers/iframes; CSS stripped of
@import/expression/unsafe url()), the #app mount + boot script are injected by
nsdeploy (never the LLM), and on any problem (no key, network/LLM error, invalid or
unsafe output, missing #app) we fall back to the default fixed template — the keyless
experience is unchanged. Results are cached + written to theme.json so builds are
reproducible and hand-overridable (see --theme-file).
"""
from __future__ import annotations

import hashlib
import html as _htmlmod
import json
import re
import urllib.request
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROMPT_VERSION = "7"
CACHE_DIR = Path.home() / ".cache" / "nsdeploy" / "themes"

# ---- HTML/CSS sanitization for LLM-authored creative layouts -----------------
# Strict allowlist: the output can only ever contain these presentational tags +
# attributes. Anything else (scripts, event handlers, iframes, forms, svg, …) is
# dropped. The boot script and #app mount are injected by nsdeploy, never the LLM.
_ALLOWED_TAGS = {
    "div", "section", "header", "footer", "main", "aside", "nav", "article",
    "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "strong", "em", "b", "i", "u", "small", "blockquote",
    "figure", "figcaption", "img", "style",
}
# Tags whose entire contents are discarded (not just the wrapper).
_DROP_CONTENT_TAGS = {
    "script", "iframe", "object", "embed", "template", "noscript", "svg", "canvas",
    "audio", "video", "source", "head", "form", "select", "textarea", "button", "input",
    "link", "meta", "base", "math", "a",
}
_VOID_TAGS = {"br", "hr", "img"}
_GLOBAL_ATTRS = {"class", "id", "title", "role", "width", "height", "alt", "lang", "dir"}
_MAX_HTML = 24000
_MAX_CSS = 24000


def _sanitize_css(css: str) -> str:
    """Strip the only CSS constructs that can do harm: @import, expression(),
    behaviors/bindings, javascript:/vbscript: URLs, and url() to unsafe schemes."""
    if not isinstance(css, str):
        return ""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)            # comments (can hide tricks)
    css = re.sub(r"@import[^;]*;?", "", css, flags=re.I)
    css = re.sub(r"@charset[^;]*;?", "", css, flags=re.I)
    css = re.sub(r"expression\s*\(", "(", css, flags=re.I)
    css = re.sub(r"-moz-binding[^;]*;?", "", css, flags=re.I)
    css = re.sub(r"behavior\s*:[^;]*;?", "", css, flags=re.I)
    css = re.sub(r"(javascript|vbscript)\s*:", "", css, flags=re.I)

    def _url(m):
        inner = m.group(1).strip().strip("\"'")
        ok = inner.startswith("data:image/") or inner.startswith("https://") or inner == "" or inner.lower() == "none"
        return f"url({m.group(1)})" if ok else "none"

    css = re.sub(r"url\(([^)]*)\)", _url, css, flags=re.I)
    return css[:_MAX_CSS]


class _HtmlSanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: List[str] = []
        self.skip = 0          # >0 while inside a drop-content tag
        self.skip_tag = ""
        self.in_style = 0
        self.app_seen = False  # emit the #app mount only once, empty

    def _attrs(self, attrs: List[Tuple[str, Optional[str]]]) -> str:
        parts = []
        for name, val in attrs:
            name = (name or "").lower()
            val = val or ""
            if name.startswith("on"):
                continue
            if name == "style":
                css = _sanitize_css(val)
                if css.strip():
                    parts.append(f' style="{_htmlmod.escape(css, quote=True)}"')
            elif name == "src":  # img only; allow inline data images or https
                v = _htmlmod.unescape(val).strip().lower()
                if v.startswith("data:image/") or v.startswith("https://"):
                    parts.append(f' src="{_htmlmod.escape(val, quote=True)}"')
            elif name in _GLOBAL_ATTRS or name.startswith("aria-") or name.startswith("data-"):
                parts.append(f' {name}="{_htmlmod.escape(val, quote=True)}"')
        return "".join(parts)

    def _is_app(self, attrs) -> bool:
        return not self.app_seen and any((n or "").lower() == "id" and (v or "") == "app" for n, v in attrs)

    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag == self.skip_tag:
                self.skip += 1
            return
        if tag in _DROP_CONTENT_TAGS:
            self.skip, self.skip_tag = 1, tag
        elif tag == "style":
            self.in_style += 1
            self.out.append("<style>")
        elif tag in _ALLOWED_TAGS:
            # The #app mount is emitted EMPTY and its content skipped — the runtime
            # fills it, so any nesting the LLM put inside is dropped (and #app stays
            # a clean mount point regardless of model mistakes).
            if self._is_app(attrs):
                self.out.append('<div id="app"></div>')
                self.app_seen = True
                self.skip, self.skip_tag = 1, tag
                return
            self.out.append("<" + tag + self._attrs(attrs) + (" />" if tag in _VOID_TAGS else ">"))

    def handle_startendtag(self, tag, attrs):
        if self.skip:
            return
        if self._is_app(attrs):
            self.out.append('<div id="app"></div>')
            self.app_seen = True
        elif tag in _ALLOWED_TAGS and tag != "style":
            self.out.append("<" + tag + self._attrs(attrs) + " />")

    def handle_endtag(self, tag):
        if self.skip:
            if tag == self.skip_tag:
                self.skip -= 1
                if self.skip == 0:
                    self.skip_tag = ""
            return
        if tag == "style" and self.in_style:
            self.in_style -= 1
            self.out.append("</style>")
        elif tag in _ALLOWED_TAGS and tag not in _VOID_TAGS:
            self.out.append("</" + tag + ">")

    def handle_data(self, data):
        if self.in_style:
            self.out.append(_sanitize_css(data))
        elif not self.skip:
            self.out.append(_htmlmod.escape(data, quote=False))


def _sanitize_html(s: str) -> str:
    if not isinstance(s, str):
        return ""
    p = _HtmlSanitizer()
    p.feed(s[:_MAX_HTML * 2])
    p.close()
    return "".join(p.out)[:_MAX_HTML]


# A validated color: #hex, rgb()/hsl(), or a bare CSS keyword. Nothing else.
_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([0-9.,%\s/]+\)|[a-zA-Z]+)$")

# The default look (== today's generated page). Used keyless and as the fail-open.
DEFAULT_COLORS: Dict[str, str] = {
    "primary": "#0ea5e9", "accent": "#14b8a6", "bg": "#eef7ff", "bg_tint": "#d8f1ff",
    "fg": "#0f2a43", "muted": "#5b7a97", "border": "#cfe6fb", "msgbg": "#e0f2fe",
    "panelbg": "#f7fcff",
}
DEFAULT_FONT = '"Segoe UI", system-ui, sans-serif'


@dataclass
class ThemeSpec:
    brand: str = ""
    icon: str = ""
    tagline: str = ""
    hero: str = ""
    font: str = DEFAULT_FONT
    radius: int = 16
    colors: Dict[str, str] = field(default_factory=lambda: dict(DEFAULT_COLORS))
    welcome: Optional[Dict[str, Any]] = None
    # Optional LLM-authored creative layout (sanitized). When `body` is set (and
    # contains the #app mount), the generator uses it instead of the fixed template.
    style: str = ""
    body: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def coerce(cls, data: Dict[str, Any]) -> "ThemeSpec":
        """Build a ThemeSpec from untrusted data, validating/sanitizing every field
        and falling back to defaults for anything missing or invalid."""
        spec = cls()
        if not isinstance(data, dict):
            return spec
        spec.brand = _clean_text(data.get("brand"), 60)
        spec.icon = _clean_text(data.get("icon"), 8)
        spec.tagline = _clean_text(data.get("tagline"), 120)
        spec.hero = _clean_text(data.get("hero"), 280)
        spec.font = _clean_font(data.get("font"))
        spec.radius = _clean_radius(data.get("radius"))
        colors = dict(DEFAULT_COLORS)
        for key, val in (data.get("colors") or {}).items():
            if key in DEFAULT_COLORS and isinstance(val, str) and _COLOR_RE.match(val.strip()):
                colors[key] = val.strip()
        spec.colors = colors
        spec.welcome = _clean_welcome(data.get("welcome"))
        # Creative layout (sanitized). Keep it only if the body still has the #app
        # mount after sanitizing — otherwise the layout would be unusable, so we drop
        # it and fall back to the fixed template.
        body = _sanitize_html(data.get("body") or "")
        if 'id="app"' in body or "id='app'" in body:
            spec.body = body
            spec.style = _sanitize_css(data.get("style") or "")
        return spec


def _clean_text(val: Any, limit: int) -> str:
    if not isinstance(val, str):
        return ""
    # strip control chars; collapse whitespace; cap length (escaped later at render)
    out = re.sub(r"[\x00-\x1f\x7f]", " ", val).strip()
    return re.sub(r"\s+", " ", out)[:limit]


def _clean_font(val: Any) -> str:
    if not isinstance(val, str):
        return DEFAULT_FONT
    out = re.sub(r"[^A-Za-z0-9 ,\"'\-]", "", val).strip()[:120]
    if not out:
        return DEFAULT_FONT
    if not re.search(r"(serif|sans-serif|monospace|system-ui)\s*$", out):
        out += ", system-ui, sans-serif"
    return out


def _clean_radius(val: Any) -> int:
    try:
        return max(0, min(28, int(float(val))))
    except (TypeError, ValueError):
        return 16


def _clean_welcome(val: Any) -> Optional[Dict[str, Any]]:
    """Keep a welcome block only if it carries a renderable widget (the runtime
    renders/escapes it safely; here we just gate the shape)."""
    if not isinstance(val, dict):
        return None
    widget = val.get("widget")
    if not isinstance(widget, dict) or not (widget.get("schema") or widget.get("kind")):
        return None
    out: Dict[str, Any] = {"widget": widget}
    if isinstance(val.get("message"), str):
        out["message"] = _clean_text(val["message"], 280)
    return out


def _identity(plan) -> Dict[str, Any]:
    """The design-relevant facts we send to the LLM (no secrets / sly_data)."""
    meta = plan.config.get("metadata", {}) or {}
    front_fn = next((a.get("function", {}) for a in plan.agents if a.get("name") == plan.front_man), {})
    return {
        "network": plan.network_name,
        "description": (front_fn.get("description") or meta.get("description") or "").strip()[:600],
        "sample_queries": (meta.get("sample_queries") or [])[:4],
        "agents": [{"name": a.get("name"), "role": (a.get("function", {}).get("description") or "").strip()[:160],
                    "tags": (a.get("metadata", {}) or {}).get("tags")} for a in plan.agents][:12],
    }


_WELCOME_SHAPE = ('{"message":"...","widget":{"title":"...","icon":"📝","schema":{"type":"object",'
                  '"properties":{"field":{"type":"string","title":"...","description":"..."}},'
                  '"required":["field"]},"submitLabel":"..."}}')

_SYSTEM_PROMPT = (
    "You are a world-class web/brand designer. Design a STRIKING, one-of-a-kind landing "
    "page for this agent network — its layout, typography, color and mood must feel "
    "unmistakably of its domain (a sports assistant electric and bold; a recipe app warm "
    "and editorial; a banking tool precise fintech; a travel app expansive and scenic).\n"
    "Commit to ONE confident layout ARCHETYPE and execute it fully. Do NOT default to the "
    "safe shell of 'a brand/logo bar on top, a tagline under it, then a panel' — that "
    "predictable, recolored-template look is exactly what to avoid. Choose an archetype "
    "that fits the domain and build it for real, e.g.: a SPLIT-SCREEN (bold art/type on "
    "one half, the assistant on the other); a FULL-BLEED hero or photo-gradient with the "
    "assistant as a floating console card; an EDITORIAL/magazine spread with columns, "
    "rules and pull-quotes; a BENTO/dashboard of feature tiles around the assistant; a "
    "left- or right-RAIL identity strip; or a domain motif (boarding pass, menu card, "
    "scoreboard, dossier, receipt). Use asymmetry, layered gradients, large display type, "
    "CSS-only decorative shapes/patterns, section dividers and a footer so it feels truly "
    "DESIGNED, not merely themed — and visibly different from any other network.\n\n"
    "Reply in EXACTLY this format, with these three markers and nothing else "
    "(no prose, no code fences):\n"
    "===META=== (STRICT, valid JSON on ONE line — inside every text value avoid the \" "
    "character and never use a raw line break; use plain words or single quotes instead)\n"
    "{a JSON object: \"brand\"(<=5 words), \"icon\"(one emoji), \"tagline\"(<=10 words), "
    "\"hero\"(one sentence), \"font\"(a web-safe CSS font stack), \"radius\"(int 6-28), "
    "\"colors\":{\"primary\",\"accent\",\"bg\",\"bg_tint\",\"fg\",\"muted\",\"border\",\"msgbg\",\"panelbg\"} as #hex, "
    f"and optionally \"welcome\":{_WELCOME_SHAPE} collecting the USER'S OWN intake details}}\n"
    "===STYLE===\n"
    "a COMPLETE CSS stylesheet for the page — backgrounds/gradients, layout (grid/flex), "
    "the hero, typography, decorative effects, responsiveness. BOLDLY restyle the "
    "assistant itself so it reads as part of your design (style these, don't redefine "
    "their structure): .ns-header, .ns-title, .ns-chat, .ns-msgs, .ns-msg, .ns-msg.user, "
    ".ns-inputbar, .ns-agents, .ns-dev, .ns-widget, .ns-w-btn — give the panels your "
    "borders/shadows/fills, the bubbles your shape, the buttons your accent. NOTE: the "
    "assistant renders its OWN compact brand bar (with a Developer toggle) at the top of "
    "#app, so do NOT open the page with a second logo+name nav bar — lead with domain "
    "ATMOSPHERE (hero, imagery, motif, bold type) instead, and let that inner bar blend "
    "via .ns-header. CSS ONLY — gradients/shapes/shadows/emoji; NO @import, NO "
    "url() except data: or https: images.\n"
    "===BODY===\n"
    "the HTML body contents: compose your chosen archetype AROUND a single EMPTY "
    "<div id=\"app\"></div>. That div is where the live assistant mounts (it draws its "
    "own header plus two side-by-side, user-resizable panels inside), so it is the "
    "PRIMARY surface: make it prominent and comfortably wide — at least ~620px of usable "
    "width — as a large card, a full-bleed stage, or one whole side of a split. Place it "
    "inventively (centered, offset left/right, floating over a hero) but NEVER cram it "
    "into a narrow sidebar/column. Leave it EMPTY: do NOT put anything inside #app and do "
    "NOT build your own chat/messages/input — that's the assistant's job. Your decorative "
    "elements must be SIBLINGS of #app, not children. Use your OWN class names (do NOT "
    "reuse names starting with 'ns-', which belong to the assistant). "
    "Plain presentational HTML only: NO <script>, NO on* handlers, NO <iframe>/<form>/<svg>.\n\n"
    "AESTHETICS — honor these so the result is tasteful and READABLE, never garish:\n"
    "- Harmony: choose ONE coherent palette (analogous or a single complementary pair) "
    "plus neutrals. Pick colors that genuinely look good TOGETHER; avoid clashing, "
    "vibrating combos (e.g. saturated red beside saturated green/blue).\n"
    "- Restraint: keep page \"bg\" and the chat surfaces \"msgbg\"/\"panelbg\" calm and "
    "low-saturation (near-white or a deep neutral) — use your vivid \"primary\"/\"accent\" "
    "as ACCENTS (buttons, hero, borders, the user-bubble gradient), NOT as large fills "
    "behind reading text. Do NOT flood the conversation/message area with a saturated "
    "color; the chat must read like a calm document, with the brand color as trim.\n"
    "- Contrast/readability: body text must hit WCAG AA (~4.5:1) against whatever sits "
    "behind it. Ensure \"fg\" on \"bg\", on \"msgbg\" and on \"panelbg\" are all clearly "
    "legible; \"muted\" stays readable too; any text you place on \"primary\"/\"accent\" "
    "must contrast with it. If unsure, make backgrounds lighter/darker until text is "
    "comfortable to read.\n"
    "Rules: self-contained (no external fonts/scripts/images); the body MUST contain "
    "exactly one empty <div id=\"app\"></div> with your design around it."
)


def _extract_json(content: str) -> Dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise


def _salvage_meta(text: str) -> Dict[str, Any]:
    """Best-effort recovery of the META fields when it isn't valid JSON (e.g. the LLM
    left an unescaped quote in a string). Pulls out the palette and identity by regex
    so a malformed META still yields a usable theme instead of dropping to the default
    template — the STYLE/BODY sections (raw text) are unaffected. The optional welcome
    form is skipped (it's the most likely thing to be malformed)."""
    data: Dict[str, Any] = {}
    cm = re.search(r'"colors"\s*:\s*\{([^{}]*)\}', text, re.S)
    if cm:
        cols = {k: v for k, v in re.findall(r'"([a-z_]+)"\s*:\s*"(#[0-9a-fA-F]{3,8})"', cm.group(1))}
        if cols:
            data["colors"] = cols
    for key in ("brand", "icon", "tagline", "hero", "font"):
        m = re.search(r'"%s"\s*:\s*"((?:[^"\\]|\\.)*)"' % key, text)
        if m:
            try:
                data[key] = json.loads('"%s"' % m.group(1))
            except json.JSONDecodeError:
                data[key] = m.group(1)
    rm = re.search(r'"radius"\s*:\s*(\d+)', text)
    if rm:
        data["radius"] = int(rm.group(1))
    return data


def _lenient_meta(text: str) -> Dict[str, Any]:
    """Parse the META JSON, tolerating the usual LLM slips: code fences, trailing
    commas, and finally an unescaped quote/line break — in which case we salvage the
    known fields by regex rather than failing the whole theme."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    candidate = text[start:end + 1] if (start >= 0 and end > start) else text
    for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
        try:
            d = json.loads(attempt)
            if isinstance(d, dict):
                return d
        except json.JSONDecodeError:
            pass
    salvaged = _salvage_meta(candidate)
    print(f"   …theme: META JSON was malformed; salvaged {len(salvaged)} field(s) by regex "
          f"(palette/identity kept, design preserved)", flush=True)
    return salvaged


def _parse_sections(content: str) -> Dict[str, Any]:
    """Parse the marker-delimited reply (===META===/===STYLE===/===BODY===). The big
    CSS/HTML blobs are raw text — no JSON escaping needed, so even small models stay
    valid. Falls back to plain-JSON parsing when no markers are present."""
    if "===META===" not in content:
        return _extract_json(content)
    parts = re.split(r"===\s*(META|STYLE|BODY)\s*===", content)
    sections: Dict[str, str] = {}
    for i in range(1, len(parts) - 1, 2):
        sections[parts[i].upper()] = parts[i + 1]
    data = _lenient_meta(sections.get("META", "{}"))
    if not isinstance(data, dict):
        data = {}
    if sections.get("STYLE", "").strip():
        data["style"] = sections["STYLE"].strip()
    if sections.get("BODY", "").strip():
        data["body"] = sections["BODY"].strip()
    return data


def _chat(upstream: str, api_key: str, model: str, system: str, user: str) -> str:
    body = json.dumps({
        "model": model, "temperature": 0.2, "stream": False,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{upstream.rstrip('/')}/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def load_theme_file(path: Path) -> ThemeSpec:
    """Load + validate a pinned theme.json (no LLM, no key)."""
    return ThemeSpec.coerce(json.loads(Path(path).read_text(encoding="utf-8")))


def propose_theme(plan, *, model: str, api_key: str, upstream: str, refresh: bool = False) -> ThemeSpec:
    """Ask the LLM for a theme (cached). Falls back to the default on any failure."""
    ident = _identity(plan)
    digest = hashlib.sha256(json.dumps([ident, model, PROMPT_VERSION], sort_keys=True).encode()).hexdigest()[:16]
    cache_path = CACHE_DIR / f"{digest}.json"
    if not refresh and cache_path.exists():
        try:
            return ThemeSpec.coerce(json.loads(cache_path.read_text(encoding="utf-8")))
        except Exception:
            pass
    try:
        spec = ThemeSpec.coerce(_parse_sections(_chat(upstream, api_key, model, _SYSTEM_PROMPT, json.dumps(ident))))
    except Exception as exc:
        print(f"   …theme: LLM step failed ({str(exc)[:80]}); using the default look", flush=True)
        return ThemeSpec()
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(spec.to_dict(), indent=2), encoding="utf-8")
    except OSError:
        pass
    return spec
