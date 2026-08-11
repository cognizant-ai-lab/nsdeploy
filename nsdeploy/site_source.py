"""Editable source files for a generated nsdeploy site."""
from __future__ import annotations

import html
import json
from pathlib import Path

from nsdeploy.theme import ThemeSpec


DEFAULT_SITE_JS = """\
export function customize({ root, runtime }) {
  // Add site-specific browser behavior here. This runs after the agent UI boots.
}
"""


def site_source_exists(site_dir: Path) -> bool:
    """Return whether a directory contains any authored site source."""
    return site_dir.is_dir() and any(
        (site_dir / name).is_file()
        for name in ("layout.html", "theme.css", "theme.json", "site.js")
    )


def _theme_metadata(theme: ThemeSpec) -> dict:
    data = theme.to_dict()
    data.pop("body", None)
    data.pop("style", None)
    return data


def seed_site_source(site_dir: Path, theme: ThemeSpec, brand_display: str,
                     *, overwrite_theme: bool = False) -> None:
    """Create editable source files. Refreshes never overwrite custom JavaScript."""
    site_dir.mkdir(parents=True, exist_ok=True)
    layout = (theme.body or
              f'<div id="app" data-ns-layout="fixed">Loading {html.escape(brand_display)}...</div>')
    files = {
        "layout.html": layout.rstrip() + "\n",
        "theme.css": theme.style.rstrip() + ("\n" if theme.style else ""),
        "theme.json": json.dumps(_theme_metadata(theme), indent=2) + "\n",
    }
    for name, content in files.items():
        path = site_dir / name
        if overwrite_theme or not path.exists():
            path.write_text(content, encoding="utf-8")
    site_js = site_dir / "site.js"
    if not site_js.exists():
        site_js.write_text(DEFAULT_SITE_JS, encoding="utf-8")


def load_site_theme(site_dir: Path) -> ThemeSpec:
    """Load and validate editable metadata, layout, and CSS as one ThemeSpec."""
    metadata_path = site_dir / "theme.json"
    data = {}
    if metadata_path.is_file():
        raw = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError(f"site theme metadata must be a JSON object: {metadata_path}")
        data.update(raw)
    layout_path = site_dir / "layout.html"
    style_path = site_dir / "theme.css"
    if layout_path.is_file():
        data["body"] = layout_path.read_text(encoding="utf-8")
    if style_path.is_file():
        data["style"] = style_path.read_text(encoding="utf-8")
    return ThemeSpec.coerce(data)
