"""
Generate a runnable, serverless site for the neuro-san-web runtime from a
DeploymentPlan: rewrite the resolved network so every hostable tool becomes an MCP
URL (and missing/external tools are dropped), then emit the network JSON, an
agent-manifest.json, and a themed index.html.

The output directory is fully static; the browser runtime loads it with no
neuro-san dependency. (The HOCON's `class`/`toolbox` assumptions about a local
neuro-san server are removed here: tools are reached purely over MCP.)
"""
from __future__ import annotations

import copy
import html
import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from nsdeploy.resolve import DeploymentPlan
from nsdeploy.site_source import DEFAULT_SITE_JS
from nsdeploy.theme import ThemeSpec

# Domain-agnostic CRUSE directive injected into each agent's instructions at deploy
# time so any network produces generative-UI widgets — without editing the source
# HOCON. The shapes match the neuro-san-web runtime's widget renderer. (Widgets are
# emitted by the LLM following this guidance; the deterministic mock won't, so this
# only takes visible effect with a real BYOK model.)
CRUSE_DIRECTIVE = """\
GENERATIVE UI (CRUSE): the app renders interactive widgets from a fenced ```cruse-ui```
block of JSON in your reply and sends the user's interaction back as your next input.
Prefer widgets over plain text when interacting:
- need details from the user before proceeding → emit a FORM widget (don't ask in prose);
- offering a set of options to choose from → emit a CHOICE widget;
- about to finalize/commit an action → offer a CONFIRM widget;
- summarizing key facts → optionally an INFO card.
Rules: keep any prose short and OUTSIDE the block; at most ONE block per reply; valid
JSON; build widgets ONLY from real data you actually have — never invent values.
Shapes:
```cruse-ui
{"title":"…","icon":"📝","schema":{"type":"object","properties":{"field_name":{"type":"string","title":"Label","description":"hint"}},"required":["field_name"]},"submitLabel":"Continue"}
```
(form field types: string; integer/number with optional minimum/maximum; boolean;
string with "format":"date"; "enum":["a","b"] for a dropdown; "x-ui":{"widget":"textarea"}
or {"widget":"radio"}.) Other kinds:
{"kind":"choice","title":"…","options":[{"title":"…","subtitle":"…","meta":"…","value":"…"}]}
{"kind":"confirm","title":"…","confirmLabel":"Yes","cancelLabel":"No","confirmText":"…"}
{"kind":"info","title":"…","fields":{"Label":"Value"}}
"""


def _brandize(network_name: str) -> str:
    return network_name.replace("_", " ").replace("-", " ").title()


def rewrite_config(plan: DeploymentPlan, site_base: str, mcp_host: str = "127.0.0.1",
                   cruse: bool = True) -> Dict[str, Any]:
    """Produce the deployed network config: agents only, with tool references mapped
    to local MCP URLs (hostable tools) or same-origin MCP-proxy URLs (external MCP
    servers), and missing/other-external refs dropped."""
    hostable_url = {
        t.name: f"{site_base.rstrip('/')}/_mcp/{i}/mcp"
        for i, t in enumerate(plan.hostable_tools)
    }
    # External MCP servers are reached through a same-origin proxy (avoids CORS) and
    # given a clean /mcp URL so the runtime classifies them as MCP.
    ext_url = {url: f"{site_base}/ext-mcp/{i}/mcp" for i, url in enumerate(plan.external_mcps)}
    drop = set(plan.missing_tools) | set(plan.omitted_tools) | set(plan.external_other)

    config = copy.deepcopy(plan.config)
    new_tools: List[Dict[str, Any]] = []
    for entry in config.get("tools", []) or []:
        # Keep only LLM agents; the leaf coded/toolbox entries are replaced by inline
        # MCP URLs inside the agents that reference them.
        if not ("instructions" in entry and "class" not in entry and "toolbox" not in entry):
            continue
        if entry.get("name") in plan.replaced_agents:
            continue
        agent = copy.deepcopy(entry)
        mapped: List[str] = []
        for ref in agent.get("tools", []) or []:
            if ref in hostable_url:
                mapped.append(hostable_url[ref])
            elif ref in ext_url:
                mapped.append(ext_url[ref])
            elif ref in plan.links:
                mapped.append(plan.links[ref])
            elif ref in drop:
                continue  # missing tool / non-MCP external URL — dropped (reported separately)
            else:
                mapped.append(ref)  # sub-agent or unresolved link-slot reference
        if "tools" in agent:
            agent["tools"] = mapped
        if cruse:  # augment instructions so the agent emits generative-UI widgets
            agent["instructions"] = (agent.get("instructions", "") or "").rstrip() + "\n\n" + CRUSE_DIRECTIVE
        new_tools.append(agent)
    config["tools"] = new_tools
    config["link_slots"] = {
        ref: {"callers": callers}
        for ref, callers in plan.link_slots.items()
        if ref not in plan.links
    }
    # Preserve the developer-facing reference for pre-consent UI. The peer
    # manifest cannot be fetched until after consent, so the URL alone is not
    # enough to name a linked network at prompt time.
    config["link_labels"] = {
        plan.links[ref]: _brandize(ref)
        for ref in plan.links
    }
    return config


def _brand_display(plan: DeploymentPlan, theme: ThemeSpec) -> str:
    brand = theme.brand or _brandize(plan.network_name)
    return f"{theme.icon} {brand}".strip() if theme.icon else brand


def _origin(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""


def build_linking_metadata(plan: DeploymentPlan, site_base: str) -> Dict[str, Any]:
    """Public, decentralized import/export description for peer linkers."""
    meta = plan.config.get("metadata", {}) or {}
    aliases: List[str] = [plan.network_name, plan.front_man]
    configured_aliases = meta.get("link_aliases", []) or plan.config.get("link_exports", []) or []
    if isinstance(configured_aliases, str):
        configured_aliases = [configured_aliases]
    for item in configured_aliases:
        alias = item if isinstance(item, str) else (item or {}).get("alias") or (item or {}).get("name")
        if alias:
            aliases.append(alias)
    aliases = list(dict.fromkeys(a for a in aliases if a))
    return {
        "protocol": "nsdeploy-link/v1",
        "site": site_base.rstrip("/"),
        "exports": [{
            "network": plan.network_name,
            "front_man": plan.front_man,
            "aliases": aliases,
            "url": f"{site_base.rstrip('/')}/{plan.network_name}",
        }],
        "imports": [{
            "network": plan.network_name,
            "reference": ref,
            "callers": callers,
            "status": "linked" if ref in plan.links else "pending",
            **({"target": plan.links[ref]} if ref in plan.links else {}),
        } for ref, callers in plan.link_slots.items()],
        "links_endpoint": "/_nsdeploy/links",
    }


def build_agent_mcp_metadata(plan: DeploymentPlan, site_base: str) -> Dict[str, Any]:
    """Describe the machine-facing facade published by every deployed site."""
    return {
        "protocol": "nsdeploy-agent-mcp/v1",
        "network": plan.network_name,
        "front_man": plan.front_man,
        "transport": "streamable-http",
        "endpoint": f"{site_base.rstrip('/')}/mcp",
        "tool": "invoke_network",
        "reachability": "open-web",
        "trust": "caller-controlled",
        "deny_list": [],
    }


def build_private_steward_hocon(plan: DeploymentPlan, site_base: str) -> str:
    """Create the standard Neuro-SAN network used by the site's operator.

    The gateway accepts a public site URL at run time.  This deliberately avoids
    turning the steward into a generated allow-list: public sites are web
    destinations, while the operator's environment owns the deny policy.
    """
    import json as _json

    description = (plan.config.get("metadata", {}) or {}).get("description") or plan.network_name
    public_sites = {plan.network_name: site_base.rstrip("/")}
    public_sites.update({name: url.rstrip("/") for name, url in sorted(plan.links.items())})
    public_site_lines = "\n".join(f"- {name}: {url}" for name, url in public_sites.items())
    gateway_parameters = {
        "type": "object",
        "properties": {
            "site_url": {
                "type": "string",
                "description": (
                    "Public nsDeploy site URL or its /mcp endpoint. Known public sites:\n"
                    + public_site_lines
                    + "\nUse an exact URL from this directory; never invent a hostname."
                ),
                "examples": list(public_sites.values()),
            },
            "request": {"type": "string", "description": "The request to make on behalf of the site operator."},
        },
        "required": ["site_url", "request"],
    }
    metadata = {
        "description": f"Private steward for {plan.network_name}. {description}",
        "steward_kind": "private",
        "public_network": plan.network_name,
        "public_site": site_base.rstrip("/"),
        "public_mcp_endpoint": f"{site_base.rstrip('/')}/mcp",
        "public_sites": public_sites,
        "private_web_policy": {
            "mode": "open",
            "denied_origins": [],
            "denied_networks": [],
            "note": "Open web reachability. Set NSDEPLOY_STEWARD_DENY_ORIGINS for local policy.",
        },
    }
    return """{
  "llm_config": {"model_name": "gpt-4o"},
  "metadata": %s,
  "tools": [
    {
      "name": "private_steward",
      "function": {
        "description": "Represent the site operator in the public agent web. Delegate public-site work through the MCP gateway."
      },
      "instructions": %s,
      "tools": ["public_agent_mcp_gateway"]
    },
    {
      "name": "public_agent_mcp_gateway",
      "function": {
        "description": "Call any trusted public nsDeploy agent site over its MCP facade. The site URL is checked against the local deny policy.",
        "parameters": %s
      },
      "class": "nsdeploy.steward.PublicAgentMcpGateway"
    }
  ]
}
""" % (
        _json.dumps(metadata, indent=2),
        _json.dumps(
            "You are the private steward for the operator of the public network. "
            "You may reach any public agent site by URL through public_agent_mcp_gateway. "
            "For known sites, use the exact URL in this directory:\n"
            + public_site_lines
            + "\nNever invent example domains or hostnames. If the needed site is not in the directory, "
            "ask the operator for its public URL before calling it. "
            "After the operator confirms an action, call the relevant known public sites rather than "
            "returning a generic plan. "
            "Do not claim an action was completed unless the remote site returned a result. "
            "Ask for confirmation before irreversible actions.",
        ),
        _json.dumps(gateway_parameters, indent=8),
    )


def write_private_steward_manifest(manifest_dir: Path) -> Path:
    """Write a Neuro-SAN manifest for every generated steward below ``manifest_dir``.

    Cailville launches several deployments concurrently, so the update is locked
    across processes. Manifest entries are relative to the manifest directory,
    which keeps the generated studio registry portable and readable.
    """
    manifest_dir = manifest_dir.resolve()
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / "manifest.hocon"
    try:
        import fcntl
    except ImportError:  # pragma: no cover - Windows has no fcntl.
        fcntl = None
    with manifest_path.open("a+", encoding="utf-8") as handle:
        if fcntl:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            steward_files = sorted(
                path.resolve()
                for bundle_dir in manifest_dir.iterdir()
                if bundle_dir.is_dir()
                for path in bundle_dir.glob("*_private_steward.hocon")
                if path.is_file()
            )
            lines = ["{"]
            lines.extend(
                f"  {json.dumps(path.relative_to(manifest_dir).as_posix())}: true,"
                for path in steward_files
            )
            lines.append("}")
            content = "\n".join(lines) + "\n"
            handle.seek(0)
            handle.truncate()
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return manifest_path


def build_manifest(plan: DeploymentPlan, network_config: Dict[str, Any],
                   mock_router: str, byok_router: str, site_base: str, theme: ThemeSpec,
                   mcp_host: str = "127.0.0.1") -> Dict[str, Any]:
    meta = plan.config.get("metadata", {}) or {}
    front_fn = next((a.get("function", {}) for a in plan.agents if a.get("name") == plan.front_man), {})
    description = theme.tagline or (front_fn.get("description") or meta.get("description") or plan.network_name).strip()
    allowed_peers: List[str] = []
    if plan.hostable_tools or plan.external_mcps:  # legacy compatibility for older runtimes
        allowed_peers.append(site_base)
    allowed_peers.extend(origin for origin in (_origin(url) for url in plan.links.values()) if origin)
    allowed_peers = list(dict.fromkeys(allowed_peers))
    manifest: Dict[str, Any] = {
        "brand": _brand_display(plan, theme),
        "networks": [
            {
                "name": plan.network_name,
                "hocon": f"/{plan.network_name}.network.json",
                "description": description,
                "tags": ["deployed", "nsdeploy"],
                "sample_queries": meta.get("sample_queries", []) or [],
            }
        ],
        "llm_router": {
            "base_url": mock_router,
            "mock": True,
            "byok_router": byok_router,
        },
        "allowed_peers": allowed_peers,
        "peer_policy": {
            "mode": "open",
            "deny_origins": [],
            "note": "Public agent sites are reachable like web pages; credentials and capabilities do not transfer.",
        },
        "agent_mcp": build_agent_mcp_metadata(plan, site_base),
        "theme": {"primary": theme.colors["primary"]},
        "linking": build_linking_metadata(plan, site_base),
    }
    if theme.welcome:  # LLM-proposed branded landing form (greeting + intake widget)
        welcome = dict(theme.welcome)
        welcome.setdefault("message", theme.hero or "")
        manifest["welcome"] = welcome
    return manifest


def _root_vars(theme: ThemeSpec) -> str:
    c = theme.colors
    return (f":root{{--ns-font:{theme.font};--ns-bg:{c['bg']};--ns-fg:{c['fg']};--ns-muted:{c['muted']};"
            f"--ns-border:{c['border']};--ns-primary:{c['primary']};--ns-accent:{c['accent']};"
            f"--ns-msgbg:{c['msgbg']};--ns-panelbg:{c['panelbg']};"
            f"--ns-user-bg:linear-gradient(135deg,{c['primary']},{c['accent']});--ns-radius:{theme.radius}px;}}")


_BOOT = """<script type="module">
    import { boot } from "/runtime/index.js";
    boot("#app").then(async (runtime) => {
      try {
        const site = await import("/site.js");
        await site.customize?.({ root: document.querySelector("#app"), runtime });
      } catch (e) {
        console.error("Site customization error", e);
      }
    }).catch((e) => {
      const a = document.querySelector("#app"); if (a) a.textContent = "Boot error: " + e.message;
      console.error(e);
    });
  </script>"""
_META = ('<meta charset="utf-8" />\n'
         '  <meta name="viewport" content="width=device-width, initial-scale=1" />')


def _doc(title: str, body: str) -> str:
    return (f"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  {_META}\n  <title>{title}</title>\n"
            f"  <link rel=\"stylesheet\" href=\"/theme.css\" />\n"
            f"</head>\n<body>\n{body}\n  {_BOOT}\n</body>\n</html>\n")


def _index_html(theme: ThemeSpec, brand_display: str) -> str:
    title = html.escape(brand_display)
    if theme.body:
        return _doc(title, theme.body)
    # Default fixed template (keyless / no creative layout).
    return _doc(title, f'<div id="app">Loading {title}...</div>')


def _theme_css(theme: ThemeSpec) -> str:
    """Assemble editable theme CSS with the runtime's non-editable safety guards."""
    c = theme.colors
    if theme.body and 'data-ns-layout="fixed"' not in theme.body:
        # New themes compose the runtime's surfaces in mount slots; older themes still
        # get the fixed shell. Keep the app and CRUSE forms reachable in either case.
        guard = (
            "html,body{margin:0;min-width:0}"
            "body{min-height:100vh;overflow-y:auto!important;overflow-x:hidden}"
            "#app{box-sizing:border-box;max-width:100%}"
            "#app:not([data-ns-layout=\"composed\"]){min-width:min(620px,94vw)!important;"
            "height:clamp(560px,80vh,900px);min-height:560px!important;overflow:visible}"
            "#app[data-ns-layout=\"composed\"]{min-width:0!important;min-height:0!important;"
            "height:auto!important;overflow:visible!important}"
            "#app[data-ns-layout=\"composed\"] [data-ns-slot]{box-sizing:border-box;min-width:0}"
            "#app[data-ns-layout=\"composed\"] [data-ns-slot=\"chat\"]{min-height:480px}"
            ".ns-chat,.ns-agents,.ns-dev{min-width:0!important;min-height:0!important}"
            ".ns-chat{overflow:hidden!important}.ns-agents,.ns-dev{overflow:auto!important}"
            ".ns-msgs{min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important}"
            ".ns-widget{box-sizing:border-box!important;max-width:100%!important}"
            ".ns-widget *{box-sizing:border-box}"
            ".ns-widget input,.ns-widget textarea,.ns-widget select{max-width:100%!important}"
            "@media(max-width:820px){#app:not([data-ns-layout=\"composed\"]){height:88vh!important}"
            "#app[data-ns-layout=\"composed\"] [data-ns-slot=\"chat\"]{min-height:68vh}}"
        )
        return f"{_root_vars(theme)}\n{theme.style}\n{guard}\n"
    return (f"{_root_vars(theme)}\n{theme.style}\n"
            "html,body{margin:0;height:100%;overflow:hidden}\n"
            f"body{{font-family:var(--ns-font);background:radial-gradient(1200px 500px at 20% -10%,"
            f"{c['bg_tint']} 0%,{c['bg']} 60%)}}\n"
            "#app{height:100vh;overflow:hidden}\n")


def generate_site(plan: DeploymentPlan, out_dir: Path, mock_router: str, byok_router: str,
                  site_base: str, mcp_host: str = "127.0.0.1", cruse: bool = True,
                  theme: Optional[ThemeSpec] = None,
                  site_source_dir: Optional[Path] = None) -> Dict[str, Any]:
    """Build the disposable static output from network data and editable site source."""
    theme = theme or ThemeSpec()
    out_dir.mkdir(parents=True, exist_ok=True)
    if site_source_dir:
        assets = site_source_dir / "assets"
        if assets.is_dir():
            shutil.copytree(assets, out_dir / "assets", dirs_exist_ok=True)
    network_config = rewrite_config(plan, site_base, mcp_host=mcp_host, cruse=cruse)
    manifest = build_manifest(plan, network_config, mock_router, byok_router, site_base, theme, mcp_host=mcp_host)

    (out_dir / f"{plan.network_name}.network.json").write_text(
        json.dumps(network_config, indent=2), encoding="utf-8")
    (out_dir / "agent-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    agent_mcp = build_agent_mcp_metadata(plan, site_base)
    (out_dir / "agent-mcp.json").write_text(json.dumps(agent_mcp, indent=2), encoding="utf-8")
    well_known = out_dir / ".well-known"
    well_known.mkdir(parents=True, exist_ok=True)
    (well_known / "nsdeploy.json").write_text(
        json.dumps(manifest["linking"], indent=2), encoding="utf-8")
    (well_known / "nsdeploy-agent.json").write_text(json.dumps(agent_mcp, indent=2), encoding="utf-8")
    steward_path = out_dir / f"{plan.network_name}_private_steward.hocon"
    legacy_steward_path = out_dir / "private-steward.hocon"
    if legacy_steward_path.is_file() and not steward_path.is_file():
        legacy_steward_path.replace(steward_path)
    elif legacy_steward_path.is_file():
        legacy_steward_path.unlink()
    steward_path.write_text(
        build_private_steward_hocon(plan, site_base), encoding="utf-8")
    write_private_steward_manifest(out_dir.parent)

    # Preserve valid runtime-created bindings across regeneration. Each site owns
    # only its own outbound map; this file is not a registry or discovery service.
    links_path = out_dir / "links.json"
    existing: Dict[str, Any] = {}
    if links_path.is_file():
        try:
            existing = json.loads(links_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing = {}
    old = ((existing.get("networks") or {}).get(plan.network_name) or {})
    bindings = {ref: url for ref, url in old.items() if ref in plan.link_slots and isinstance(url, str)}
    bindings.update(plan.links)
    links_doc = {"version": 1, "networks": {plan.network_name: bindings}}
    links_path.write_text(json.dumps(links_doc, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(_index_html(theme, _brand_display(plan, theme)), encoding="utf-8")
    (out_dir / "theme.css").write_text(_theme_css(theme), encoding="utf-8")
    site_js = DEFAULT_SITE_JS
    if site_source_dir and (site_source_dir / "site.js").is_file():
        site_js = (site_source_dir / "site.js").read_text(encoding="utf-8")
    (out_dir / "site.js").write_text(site_js, encoding="utf-8")
    (out_dir / "theme.json").write_text(json.dumps(theme.to_dict(), indent=2), encoding="utf-8")
    return manifest
