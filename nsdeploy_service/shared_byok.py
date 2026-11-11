"""Install the service-owned cross-network BYOK browser behavior.

No nsdeploy source is changed. The generated site's supported ``site.js`` seam is
extended after a build and reconciled at service startup for existing bundles.
The JavaScript adds no visible content; it only shares a caller-entered key across
the service's sites for 48 hours: the same hostname's ports, or every subdomain of
the public host when sites are served on subdomains.
"""
from __future__ import annotations

import json
from pathlib import Path

from nsdeploy_service.config import SERVICE_ROOT
from nsdeploy_service.config import Settings


START_MARKER = "/* nsdeploy_service shared BYOK cookie: begin */"
END_MARKER = "/* nsdeploy_service shared BYOK cookie: end */"
SCRIPT_PATH = SERVICE_ROOT / "site_customization" / "shared-byok.js"
DOMAIN_LINE = 'const cookieDomain = "";'


def shared_cookie_domain(settings: Settings) -> str:
    """
    The domain to set the shared cookie on.

    Sites on subdomains share one cookie on the public host. Sites on one hostname
    with different ports need no domain, because cookies ignore ports.

    :param settings: Service settings
    :return: The public host when sites are on subdomains, otherwise an empty string
    """
    return settings.public_host if settings.subdomain_template else ""


def shared_byok_script(cookie_domain: str = "") -> str:
    """
    Read the shared BYOK cookie script that is injected into site JavaScript.

    :param cookie_domain: Domain to share the cookie across, from shared_cookie_domain
    :return: The script source with surrounding whitespace stripped.
    """
    script = SCRIPT_PATH.read_text(encoding="utf-8").strip()
    if cookie_domain:
        script = script.replace(DOMAIN_LINE, f"const cookieDomain = {json.dumps(cookie_domain)};")
    return script


def _without_shared_block(source: str) -> str:
    start = source.find(START_MARKER)
    while start >= 0:
        end = source.find(END_MARKER, start + len(START_MARKER))
        if end < 0:
            source = source[:start]
            break
        source = source[:start] + source[end + len(END_MARKER):]
        start = source.find(START_MARKER)
    return source.rstrip()


def sync_shared_byok(work_dir: Path, *, enabled: bool = True, cookie_domain: str = "") -> list[Path]:
    """
    Add/remove the marked behavior in source and built site JavaScript.

    :param work_dir: Deployment work directory
    :param enabled: False removes the behavior
    :param cookie_domain: Domain to share the cookie across, from shared_cookie_domain
    :return: The files that changed
    """
    script = shared_byok_script(cookie_domain) if enabled else ""
    work = Path(work_dir)
    changed: list[Path] = []
    for path in (work / "site-source" / "site.js", work / "site" / "site.js"):
        try:
            if not path.is_file():
                continue
            current = path.read_text(encoding="utf-8")
            base = _without_shared_block(current)
            updated = base + ("\n\n" + script if script else "") + "\n"
            if updated != current:
                path.write_text(updated, encoding="utf-8")
                changed.append(path)
        except OSError:
            # Browser convenience must never stop the service or fail a build.
            continue
    return changed
