"""Install the service-owned cross-network BYOK browser behavior.

No nsdeploy source is changed. The generated site's supported ``site.js`` seam is
extended after a build and reconciled at service startup for existing bundles.
The JavaScript adds no visible content; it only shares a caller-entered key across
the same hostname's network ports for 48 hours.
"""
from __future__ import annotations

from pathlib import Path

from nsdeploy_service.config import SERVICE_ROOT


START_MARKER: str = "/* nsdeploy_service shared BYOK cookie: begin */"
END_MARKER: str = "/* nsdeploy_service shared BYOK cookie: end */"
SCRIPT_PATH: Path = SERVICE_ROOT / "site_customization" / "shared-byok.js"


def shared_byok_script() -> str:
    """
    Read the shared BYOK cookie script that is injected into site JavaScript.

    :return: The script source with surrounding whitespace stripped.
    """
    return SCRIPT_PATH.read_text(encoding="utf-8").strip()


def _without_shared_block(source: str) -> str:
    start: int = source.find(START_MARKER)
    while start >= 0:
        end: int = source.find(END_MARKER, start + len(START_MARKER))
        if end < 0:
            source = source[:start]
            break
        source = source[:start] + source[end + len(END_MARKER):]
        start = source.find(START_MARKER)
    return source.rstrip()


def sync_shared_byok(work_dir: Path, *, enabled: bool = True) -> list[Path]:
    """Add/remove the marked behavior in source and built site JavaScript."""
    script: str = shared_byok_script() if enabled else ""
    work: Path = Path(work_dir)
    changed: list[Path] = []
    path: Path
    for path in (work / "site-source" / "site.js", work / "site" / "site.js"):
        try:
            if not path.is_file():
                continue
            current: str = path.read_text(encoding="utf-8")
            base: str = _without_shared_block(current)
            updated: str = base + ("\n\n" + script if script else "") + "\n"
            if updated != current:
                path.write_text(updated, encoding="utf-8")
                changed.append(path)
        except OSError:
            # Browser convenience must never stop the service or fail a build.
            continue
    return changed
