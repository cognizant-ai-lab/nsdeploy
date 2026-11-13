"""Token-level editing of a deployed site's look — no model call, no rebuild.

`POST /deployments/{id}/theme` is for *design*: it re-asks the LLM for a whole
layout and costs a stop + relaunch (minutes). But most of what an operator wants
to change is not a design question at all — a colour, the corner radius, the
brand word — and every one of those is already a named field on nsdeploy's own
`ThemeSpec` that compiles to a CSS custom property. Asking a language model to
change `#0ea5e9` to navy is the expensive way to do arithmetic.

So this edits the built bundle in place:

    work_dir/site/theme.css           regenerated from the merged spec
    work_dir/site/agent-manifest.json brand/icon, tagline, primary, hero
    work_dir/site/theme.json          the merged spec, so the next read sees it
    work_dir/site-source/theme.json   editable source, so a REBUILD keeps it

**No restart is needed for a live site.** `launcher.make_handler` reads every
file off disk on each request (`data = file_path.read_bytes()`) rather than
caching a built page in memory, so the next page load serves the new look. The
site-source write is what makes the change outlive the next build: nsdeploy
prefers editable source over its own theme cache and over the default look (see
__main__.py's theme resolution), and supervisor.py always passes `--site-dir`,
so there is always a source directory to write into.

**The layout is never touched here.** `body`/`style` — the model's creative
output — live in site-source's layout.html / theme.css and are carried through
every merge untouched, so recolouring a network keeps whatever design it has.
That split is the whole point: tokens are the operator's, layout is the model's.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from typing import Dict
from typing import Tuple

from nsdeploy.site_source import load_site_theme
from nsdeploy.site_source import site_source_exists
from nsdeploy.theme import DEFAULT_COLORS
from nsdeploy.theme import DEFAULT_FONT
from nsdeploy.theme import ThemeSpec

# --- the two nsdeploy internals this module depends on ------------------------
# Private names, imported deliberately and only here, so that editing a theme
# never means keeping a second copy of nsdeploy's own rules:
#
#   _theme_css   assembles the root custom properties AND the layout guards. A
#                restyle has to write byte-identical output to a build, and the
#                guards are ~30 lines that would silently drift in a copy.
#   _COLOR_RE    is the colour syntax ThemeSpec.coerce accepts. Re-declaring it
#                here would mean the service rejecting values a build accepts
#                the moment upstream widens it.
#
# nsdeploy is a vendored library and is left unmodified, so this is the seam
# instead. If either name is renamed upstream the failure is an ImportError at
# start-up — loud, immediate, and cheaper than a merge conflict every upgrade.
from nsdeploy.generate import _theme_css as theme_css  # noqa: PLC2701
from nsdeploy.theme import _COLOR_RE  # noqa: PLC2701


def is_color(value: Any) -> bool:
    """Whether `value` is a colour ThemeSpec.coerce will keep.

    Needed because coerce fails open by substituting the DEFAULT colour, which
    is right for a build (there is no previous value to keep) and wrong for an
    edit, where it would silently reset a hue to stock blue over a typo.
    """
    return isinstance(value, str) and bool(_COLOR_RE.match(value.strip()))


# Everything an operator may edit directly. `welcome` is deliberately absent:
# it is a CRUSE intake form the model proposes, not a visual token, and it is
# preserved rather than edited (see merge below).
TOKEN_FIELDS: Tuple[str, ...] = ("brand", "icon", "tagline", "hero", "font", "radius")
COLOR_KEYS: Tuple[str, ...] = tuple(DEFAULT_COLORS)


def site_paths(work_dir: Path) -> Tuple[Path, Path]:
    """The built bundle and the editable source, as supervisor.py lays them out."""
    work: Path = Path(work_dir)
    return work / "site", work / "site-source"


def read_spec(work_dir: Path) -> Tuple[ThemeSpec, str]:
    """This deployment's current theme, and where it was read from.

    Editable source first — it is what the next build will use, so it is the
    truth about what this network's look *is*, not merely what it was serving
    before someone edited the files by hand. The built bundle is the fallback for
    a network deployed before any source existed; the default look is the floor.
    """
    out_dir: Path
    source_dir: Path
    out_dir, source_dir = site_paths(work_dir)
    if site_source_exists(source_dir):
        try:
            return load_site_theme(source_dir), "site-source"
        except (OSError, ValueError):
            pass  # corrupt or half-written: fall through to the built bundle
    built: ThemeSpec | None = _built_spec(out_dir)
    if built is not None:
        return built, "built"
    return ThemeSpec(), "default"


def _built_spec(out_dir: Path) -> ThemeSpec | None:
    """The spec the built bundle was generated from, or None if it has no build.

    This is what the site is *serving*, which is not always what the editable
    source says: a hand-edited layout.html that ThemeSpec.coerce rejects would
    read back without its layout, and regenerating the stylesheet from that would
    emit the fixed-shell rules for markup that is still composed. The build wrote
    this file from an already-coerced spec, so it round-trips.
    """
    path: Path = out_dir / "theme.json"
    if not path.is_file():
        return None
    try:
        return ThemeSpec.coerce(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def has_custom_layout(work_dir: Path) -> bool:
    """Whether a model-authored layout is in place, by what is on disk rather
    than by what survives coercion — the console uses this only to warn that a
    generic preview will not show the real thing, and an unparseable layout is
    still a layout the operator should be warned about."""
    out_dir: Path
    source_dir: Path
    out_dir, source_dir = site_paths(work_dir)
    if (source_dir / "layout.html").is_file():
        return True
    built: ThemeSpec | None = _built_spec(out_dir)
    return bool(built and built.body)


def apply_tokens(work_dir: Path, tokens: Dict[str, Any]) -> Tuple[ThemeSpec, bool]:
    """Merge `tokens` into this deployment's theme and write it everywhere.

    Returns the merged spec and whether the built bundle was patched — false when
    the network has never been built (nothing on disk to restyle), in which case
    only the editable source is written and the change lands on the first build.
    """
    out_dir: Path
    source_dir: Path
    out_dir, source_dir = site_paths(work_dir)
    current: ThemeSpec
    current, _ = read_spec(work_dir)
    spec: ThemeSpec = _merge(current, tokens)

    # Metadata only, mirroring site_source.seed_site_source: layout.html and
    # theme.css in this directory own `body`/`style`, and rewriting theme.json
    # with them folded in would give the next build two sources for one thing.
    source_dir.mkdir(parents=True, exist_ok=True)
    metadata: Dict[str, Any] = spec.to_dict()
    metadata.pop("body", None)
    metadata.pop("style", None)
    _write_json(source_dir / "theme.json", metadata)

    built: ThemeSpec | None = _built_spec(out_dir)
    if built is None or not (out_dir / "theme.css").is_file():
        return spec, False
    # Regenerated from what the bundle is actually serving, so the stylesheet
    # keeps matching the markup in its index.html — only the tokens move.
    serving: ThemeSpec = _merge(built, tokens)
    (out_dir / "theme.css").write_text(theme_css(serving), encoding="utf-8")
    _write_json(out_dir / "theme.json", serving.to_dict())
    _patch_manifest(out_dir / "agent-manifest.json", serving)
    return spec, True


def _merge(current: ThemeSpec, tokens: Dict[str, Any]) -> ThemeSpec:
    """Fold edited tokens over the current spec and re-validate the whole thing.

    Validation is ThemeSpec.coerce's, not a second ruleset here: out-of-range
    radii clamp, unparseable colours and fonts fall back, and `body`/`style` are
    re-sanitized. Coerce drops a layout whose #app mount it cannot find, which
    would silently flatten a themed site into the fixed shell, so a layout that
    was valid on the way in is restored on the way out — a colour edit is not
    allowed to be a layout edit.
    """
    data: Dict[str, Any] = current.to_dict()
    field: str
    for field in TOKEN_FIELDS:
        if tokens.get(field) is not None:
            data[field] = tokens[field]
    colors: Dict[str, str] = dict(data.get("colors") or DEFAULT_COLORS)
    key: str
    value: Any
    for key, value in (tokens.get("colors") or {}).items():
        # Unparseable values are dropped here rather than passed to coerce, whose
        # fail-open would substitute the *default* colour and quietly undo an
        # edit the operator never made. Invalid means "keep what is there".
        if key in DEFAULT_COLORS and is_color(value):
            colors[key] = value.strip()
    data["colors"] = colors
    spec: ThemeSpec = ThemeSpec.coerce(data)
    if current.body and not spec.body:
        spec.body, spec.style = current.body, current.style
    return spec


def _patch_manifest(path: Path, spec: ThemeSpec) -> None:
    """Carry the copy tokens into the manifest the runtime actually reads.

    The deployed UI takes its header from `brand`, its subtitle from the
    network's `description`, its user-bubble hue from `theme.primary`, and a
    welcome form's greeting from `welcome.message` — see generate.py's manifest
    builder. Empty text is "unset", not "blank it": the build derives a brand
    from the network name and a description from the agent's own when the theme
    has none, and neither of those is knowable from here, so leaving the
    existing value alone is the only non-destructive reading.
    """
    try:
        manifest: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(manifest, dict):
        return
    if spec.brand:
        manifest["brand"] = f"{spec.icon} {spec.brand}".strip() if spec.icon else spec.brand
    networks: Any = manifest.get("networks")
    if spec.tagline and isinstance(networks, list) and networks and isinstance(networks[0], dict):
        networks[0]["description"] = spec.tagline
    theme_block: Any = manifest.get("theme")
    if isinstance(theme_block, dict):
        theme_block["primary"] = spec.colors["primary"]
    else:
        manifest["theme"] = {"primary": spec.colors["primary"]}
    welcome: Any = manifest.get("welcome")
    if spec.hero and isinstance(welcome, dict):
        welcome["message"] = spec.hero
    _write_json(path, manifest)


def _write_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def defaults() -> Dict[str, Any]:
    """The default look, served alongside the current one so the console has a
    baseline to offer as "reset" without hardcoding a second copy of it."""
    return {"colors": dict(DEFAULT_COLORS), "font": DEFAULT_FONT, "radius": 16}
