"""
Tier-1 LLM-assisted theming (optional, opt-in).

Given a deployment plan's *identity* (name, description, sample queries, agent
roles), an LLM proposes a small, validated **theme spec** — palette tokens, font,
radius, brand/icon/tagline/hero copy, and an optional CRUSE welcome form. nsdeploy
bakes that into the generated index.html + manifest.

The LLM never emits HTML/CSS: it fills a bounded JSON schema and every value is
validated/sanitized here. On any problem (no key, network/LLM error, invalid or
unsafe output) we fall back to the default theme — the keyless experience is
unchanged. Results are cached + written to theme.json so builds are reproducible and
hand-overridable (see --theme-file).
"""
from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

PROMPT_VERSION = "1"
CACHE_DIR = Path.home() / ".cache" / "nsdeploy" / "themes"

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


_SYSTEM_PROMPT = """\
You are a senior brand and UI designer. Given an agent network's identity, design a \
cohesive visual theme for its web app. Respond with ONLY a JSON object (no prose, no \
code fence) with these fields:
  "brand": short product name (<= 5 words),
  "icon": a single emoji that fits the domain,
  "tagline": <= 10 words,
  "hero": one friendly sentence shown as the opening message,
  "font": a CSS font-family stack of widely-available/web-safe fonts,
  "radius": integer corner radius in px (8-24),
  "colors": { "primary","accent","bg","bg_tint","fg","muted","border","msgbg","panelbg" } as #hex,
  "welcome": optional { "message": string, "widget": a CRUSE form that collects the \
USER'S OWN intake details } where widget is \
{"title","icon","schema":{"type":"object","properties":{"field":{"type":"string","title":"...","description":"..."}},"required":[...]},"submitLabel":"..."}.
Rules: ensure strong contrast between fg (text) and bg (page); bg/bg_tint/msgbg/panelbg \
light, fg dark (or vice-versa) — never low-contrast; the welcome form may ONLY collect \
the user's own details, never invented options/prices. Output valid JSON only."""


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
        spec = ThemeSpec.coerce(_extract_json(_chat(upstream, api_key, model, _SYSTEM_PROMPT, json.dumps(ident))))
    except Exception as exc:
        print(f"   …theme: LLM step failed ({str(exc)[:80]}); using the default look", flush=True)
        return ThemeSpec()
    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(spec.to_dict(), indent=2), encoding="utf-8")
    except OSError:
        pass
    return spec
