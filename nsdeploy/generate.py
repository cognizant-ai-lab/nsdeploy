"""
Generate a runnable, serverless site for the neuro-san-web runtime from a
DeploymentPlan: rewrite the resolved network so every hostable tool becomes an MCP
URL (while public agent-network URLs are preserved), then emit the network JSON, an
agent-manifest.json, and a themed index.html.

The normal output directory contains site data consumed by nsDeploy's launcher.
Static-bundle mode also copies the browser runtime and emits hosting-header files,
so the directory can be published without Python. (The HOCON's `class`/`toolbox`
assumptions about a local neuro-san server are removed in that mode.)
"""
from __future__ import annotations

import copy
import html
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Set
from typing import TextIO
from urllib.parse import ParseResult
from urllib.parse import urlparse
from urllib.parse import urlsplit

from nsdeploy.byok import BYOK_AUTH_HEADER
from nsdeploy.byok import BYOK_MODEL_HEADER
from nsdeploy.commerce.steward import add_to_private_network
from nsdeploy.form_actions import action_discovery_config
from nsdeploy.resolve import DeploymentPlan
from nsdeploy.site_source import DEFAULT_SITE_JS
from nsdeploy.theme import ThemeSpec

# fcntl exists only on POSIX. It locks the shared steward manifest across concurrent deployments in
# write_private_steward_manifest(); without it, as on Windows, the manifest is written unlocked.
try:
    import fcntl  # POSIX-only module
except ImportError:  # pragma: no cover - Windows has no fcntl.
    fcntl = None


DEFAULT_PRIVATE_STEWARD_MAX_EXECUTION_SECONDS: int = 3600
DEFAULT_RUNTIME_DIR: Path = Path(__file__).resolve().parent / "runtime"
WORKER_CSP: str = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'"

# Every agent proposes a presentation to its parent; only the final root
# composition is rendered. Keep this protocol aligned with runtime/cruse.js.
CRUSE_DIRECTIVE: str = """\
GENERATIVE UI (CRUSE): intelligently choose how to communicate the answer: readable
chat, a visual/report, an interactive input, or a useful combination. CRUSE is NOT
limited to forms. For an informational request, answer it before collecting details
for later actions. Use Markdown headings, lists, emphasis and links for readable chat.
Use tables for comparisons, charts for meaningful numeric relationships, reports for
structured explanations, and presentational HTML for other contextual layouts.
Use a small form only when multiple structured inputs help the current task; a simple
question may be better in chat. Use choices for real alternatives and confirmation
for a specific proposed action. A chart must contain actual data, never invented values.

HIERARCHICAL CONSOLIDATION: a child returns {cruse:1,text,presentation,protocol,source}.
Read both the answer and its presentation proposal. At EVERY level of the hierarchy,
consider all relevant children together and synthesize your own consolidated result.
Deduplicate questions by meaning (e.g. dates vs pickup/return), account for answers
already given, combine overlapping information, and remove irrelevant or premature
inputs. Preserve distinct requirements, source distinctions and disagreements; never
merge unrelated people's details or approvals. Child UI is a suggestion: you may
redesign, combine, replace or omit it. Do not concatenate child forms. Keep essential
facts and unresolved requirements in your answer if any proposal cannot be displayed.
Only the final top-level composition is displayed. Usually use one focused input
step, with complementary tables/charts/reports where useful; avoid a large questionnaire.

Forms are optional ways to answer. Users may skip them, answer in chat, or supplement
or correct previously submitted values in chat. Carry known facts forward. Unsubmitted
form drafts have not been sent to you. CRUSE interaction metadata identifies the
originating turn, component, selected value or submitted field values; interpret it
with the conversation history and ask only for what is still needed.

Return your answer text OUTSIDE at most ONE fenced cruse-ui block of valid JSON.
If using AAOSA, keep its protocol envelope and place the block after it, not inside a
quoted Response. Omit the block when chat alone is best. A composition can include
several complementary components; do not repeat the same content in every channel.
Keep stable, meaningful component IDs and form property keys across revisions.
```cruse-ui
{"version":1,"components":[{"id":"availability","kind":"table","title":"Available options",\
"columns":["Option","Availability"],"rows":[["Known option","Known availability"]]}]}
```
Supported component shapes (examples of structure, not factual data):
{"id":"details","kind":"form","title":"…",\
"schema":{"type":"object","properties":{"start_date":{"type":"string","format":"date","title":"Start date"}},\
"required":["start_date"]},"submitLabel":"Continue"}
Field types: string, integer/number (minimum/maximum), boolean, string format date,
enum dropdown, x-ui:{widget:textarea} or {widget:radio}, array with items.enum for
multiple selections. Use default only for known values. Mark only essential fields required.
{"id":"options","kind":"choice","title":"…","options":[{"title":"…","subtitle":"…","meta":"…","value":"stable-option-id"}]}
{"id":"approval","kind":"confirm","title":"…","confirmLabel":"Yes","cancelLabel":"No",\
"confirmText":"Explicit action being approved"}
{"id":"facts","kind":"info","title":"…","fields":{"Label":"Value"}}
{"id":"report","kind":"report","title":"…",\
"markdown":"## Findings\\n\\nStructured explanation with **emphasis**, lists and links."}
{"id":"comparison","kind":"table","title":"…","columns":["Label","Value"],"rows":[["A","Known value"]]}
{"id":"trend","kind":"chart","title":"…","chartType":"bar","unit":"Units","labels":["A","B"],\
"series":[{"name":"Series","values":[10,20]}],"summary":"Text explanation of the actual data."}
Charts support bar or line, up to 8 series and 120 labels. Values must be finite numbers;
each series must match labels. Include a useful summary. Chart data is also accessible as a table.
{"id":"visual","kind":"html","title":"…","html":"<article><h2>Findings</h2><p>Context</p></article>"}
HTML supports semantic sections, headings, lists, tables, details/summary and safe links.
No scripts, CSS, event handlers, embedded resources, SVG, iframes or HTML form controls;
use chart/form components for those functions. The runtime supplies theme and layout.
"""


def _brandize(network_name: str) -> str:
    return network_name.replace("_", " ").replace("-", " ").title()


def _seed_default_model(config: Dict[str, Any]) -> None:
    """Give the deployed network a top-level `llm_config.model_name` when the studio
    config only lists `fallbacks`. neuro-san tries fallbacks in order; the browser
    runtime and the MCP facade read a single `model_name` and otherwise default to
    the mock model, which a real BYOK upstream rejects."""
    llm: Any = config.get("llm_config")
    if not isinstance(llm, dict) or llm.get("model_name"):
        return
    fallback: Any
    for fallback in llm.get("fallbacks") or []:
        if isinstance(fallback, dict) and fallback.get("model_name"):
            llm["model_name"] = fallback["model_name"]
            return


# pylint: disable-next=too-many-branches,unused-argument  # mcp_host kept for caller compatibility
def rewrite_config(plan: DeploymentPlan, site_base: str, mcp_host: str = "127.0.0.1",
                   cruse: bool = True, static_bundle: bool = False) -> Dict[str, Any]:
    """Produce the deployed network config: agents only, with tool references mapped
    to local MCP URLs (hostable tools) or same-origin MCP-proxy URLs (external MCP
    servers), with public agent-network URLs preserved and missing refs dropped."""
    hostable_url: Dict[str, str] = {} if static_bundle else {
        t.name: f"{site_base.rstrip('/')}/_mcp/{i}/mcp"
        for i, t in enumerate(plan.hostable_tools)
    }
    # External MCP servers are reached through a same-origin proxy (avoids CORS) and
    # given a clean /mcp URL so the runtime classifies them as MCP.
    ext_url: Dict[str, str] = {
        url: (url if static_bundle else f"{site_base}/ext-mcp/{i}/mcp")
        for i, url in enumerate(plan.external_mcps)
    }
    drop: Set[str] = set(plan.missing_tools) | set(plan.omitted_tools)
    if static_bundle:
        drop.update(tool.name for tool in plan.hostable_tools)

    config: Dict[str, Any] = copy.deepcopy(plan.config)
    _seed_default_model(config)
    if cruse:
        config["cruse"] = {"version": 1}
    new_tools: List[Dict[str, Any]] = []
    entry: Dict[str, Any]
    for entry in config.get("tools", []) or []:
        # Keep only LLM agents; the leaf coded/toolbox entries are replaced by inline
        # MCP URLs inside the agents that reference them.
        if not ("instructions" in entry and "class" not in entry and "toolbox" not in entry):
            continue
        if entry.get("name") in plan.replaced_agents:
            continue
        agent: Dict[str, Any] = copy.deepcopy(entry)
        mapped: List[str] = []
        ref: str
        for ref in agent.get("tools", []) or []:
            if ref in hostable_url:
                mapped.append(hostable_url[ref])
            elif ref in ext_url:
                mapped.append(ext_url[ref])
            elif ref in plan.links:
                mapped.append(plan.links[ref])
            elif ref in drop:
                continue  # missing or intentionally omitted tool
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
    if static_bundle:
        omitted_tools: List[str] = sorted({tool.name for tool in plan.hostable_tools} | set(plan.omitted_tools))
        config["deployment"] = {
            "mode": "static",
            "omitted_python_tools": omitted_tools,
            "external_mcp_transport": "direct-cors",
            "link_persistence": "browser-local",
        }
    return config


def _brand_display(plan: DeploymentPlan, theme: ThemeSpec) -> str:
    brand: str = theme.brand or _brandize(plan.network_name)
    return f"{theme.icon} {brand}".strip() if theme.icon else brand


def _origin(url: str) -> str:
    parsed: ParseResult = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""


def build_linking_metadata(plan: DeploymentPlan, site_base: str,
                           static_bundle: bool = False) -> Dict[str, Any]:
    """Public, decentralized import/export description for peer linkers."""
    meta: Dict[str, Any] = plan.config.get("metadata", {}) or {}
    aliases: List[str] = [plan.network_name, plan.front_man]
    configured_aliases: Any = meta.get("link_aliases", []) or plan.config.get("link_exports", []) or []
    if isinstance(configured_aliases, str):
        configured_aliases = [configured_aliases]
    item: Any
    for item in configured_aliases:
        alias: Any = item if isinstance(item, str) else (item or {}).get("alias") or (item or {}).get("name")
        if alias:
            aliases.append(alias)
    aliases = list(dict.fromkeys(a for a in aliases if a))
    base: str = site_base.rstrip("/")
    result: Dict[str, Any] = {
        "protocol": "nsdeploy-link/v1",
        "exports": [{
            "network": plan.network_name,
            "front_man": plan.front_man,
            "aliases": aliases,
            "url": f"{base}/{plan.network_name}" if base else plan.network_name,
        }],
        "imports": [{
            "network": plan.network_name,
            "reference": ref,
            "callers": callers,
            "status": "linked" if ref in plan.links else "pending",
            **({"target": plan.links[ref]} if ref in plan.links else {}),
        } for ref, callers in plan.link_slots.items()],
    }
    if base:
        result["site"] = base
    if static_bundle:
        result["link_updates"] = {"mode": "browser-local"}
    else:
        result["links_endpoint"] = "/_nsdeploy/links"
    return result


def build_agent_mcp_metadata(plan: DeploymentPlan, site_base: str,
                             available: bool = True) -> Dict[str, Any]:
    """Describe the machine-facing facade published by every deployed site."""
    if not available:
        return {
            "protocol": "nsdeploy-agent-mcp/v1",
            "network": plan.network_name,
            "front_man": plan.front_man,
            "available": False,
            "reason": "This is a static bundle; a public MCP facade requires an application host.",
        }
    return {
        "protocol": "nsdeploy-agent-mcp/v1",
        "network": plan.network_name,
        "front_man": plan.front_man,
        "transport": "streamable-http",
        "endpoint": f"{site_base.rstrip('/')}/mcp",
        "tool": "invoke_network",
        "reachability": "open-web",
        "trust": "caller-controlled",
        "llm_credentials": {
            "mode": "caller-byok",
            "required": True,
            "transport": "http-headers",
            "authorization_header": BYOK_AUTH_HEADER,
            "model_header": BYOK_MODEL_HEADER,
            "propagation": "public-mcp-hops",
        },
        "deny_list": [],
    }


def build_private_steward_hocon(
    plan: DeploymentPlan,
    site_base: str,
    known_public_sites: Optional[Dict[str, str]] = None,
) -> str:
    """Create the standard Neuro-SAN network used by the site's operator.

    The gateway accepts a public site URL at run time.  This deliberately avoids
    turning the steward into a generated allow-list: public sites are web
    destinations, while the operator's environment owns the deny policy.
    """
    description: str = (plan.config.get("metadata", {}) or {}).get("description") or plan.network_name
    public_sites: Dict[str, str] = {
        name: str(url).rstrip("/")
        for name, url in sorted((known_public_sites or {}).items())
        if name and str(url).strip()
    }
    if site_base:
        public_sites[plan.network_name] = f"{site_base.rstrip('/')}/{plan.network_name}"
    public_sites.update({name: url.rstrip("/") for name, url in sorted(plan.links.items())})
    public_site_lines: str = "\n".join(f"- {name}: {url}" for name, url in public_sites.items())
    gateway_parameters: Dict[str, Any] = {
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
    metadata: Dict[str, Any] = {
        "description": f"Private steward for {plan.network_name}. {description}",
        "steward_kind": "private",
        "public_network": plan.network_name,
        "public_site": site_base.rstrip("/"),
        "public_execution": {
            "mode": "fetch-and-run",
            "manifest": f"{site_base.rstrip('/')}/agent-manifest.json" if site_base else "agent-manifest.json",
            "mcp_fallback": f"{site_base.rstrip('/')}/mcp" if site_base else None,
        },
        "public_sites": public_sites,
        "private_web_policy": {
            "mode": "open",
            "denied_origins": [],
            "denied_networks": [],
            "note": "Open web reachability. Set NSDEPLOY_STEWARD_DENY_ORIGINS for local policy.",
        },
    }
    result: str = """{
  "llm_config": {"model_name": "gpt-4o"},
  "max_execution_seconds": %d,
  "metadata": %s,
  "tools": [
    {
      "name": "private_steward",
      "function": {
        "description": "Represent the site operator in the public agent web. \
Delegate public-site work through the MCP gateway."
      },
      "instructions": %s,
      "tools": ["public_agent_mcp_gateway"]
    },
    {
      "name": "public_agent_mcp_gateway",
      "function": {
        "description": "Fetch and run any trusted public nsDeploy agent network locally. \
The site URL is checked against the local deny policy; MCP is a legacy fallback.",
        "parameters": %s
      },
      "class": "nsdeploy.steward.PublicAgentNetworkGateway"
    }
  ]
}
""" % (
        DEFAULT_PRIVATE_STEWARD_MAX_EXECUTION_SECONDS,
        json.dumps(metadata, indent=2),
        json.dumps(
            "You are the private steward for the operator of the public network. "
            "You may fetch and run any public agent network by URL through public_agent_mcp_gateway. "
            "For known sites, use the exact URL in this directory:\n"
            + public_site_lines
            + "\nNever invent example domains or hostnames. If the needed site is not in the directory, "
            "ask the operator for its public URL before calling it. "
            "After the operator confirms an action, call the relevant known public sites rather than "
            "returning a generic plan. "
            "Do not claim an action was completed unless the remote site returned a result. "
            "Ask for confirmation before irreversible actions.",
        ),
        json.dumps(gateway_parameters, indent=8),
    )
    if (plan.config.get("private_commerce") or {}).get("steward") == "butterpink_family":
        result = json.dumps(add_to_private_network(json.loads(result)), indent=2) + "\n"
    return result


def write_private_steward_manifest(
    manifest_dir: Path,
    active_networks: Optional[List[str]] = None,
) -> Path:
    """Write a Neuro-SAN manifest for every generated steward below ``manifest_dir``.

    Cailville launches several deployments concurrently, so the update is locked
    across processes. Manifest entries are relative to the manifest directory,
    which keeps the generated studio registry portable and readable.
    """
    manifest_dir = manifest_dir.resolve()
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path: Path = manifest_dir / "manifest.hocon"
    active: Optional[Set[str]] = set(active_networks) if active_networks is not None else None
    handle: TextIO
    with manifest_path.open("a+", encoding="utf-8") as handle:
        if fcntl:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            steward_files: List[Path] = sorted(
                path.resolve()
                for bundle_dir in manifest_dir.iterdir()
                if bundle_dir.is_dir() and (active is None or bundle_dir.name in active)
                for path in bundle_dir.glob("*_private_steward.hocon")
                if path.is_file()
            )
            lines: List[str] = ["{"]
            lines.extend(
                f"  {json.dumps(path.relative_to(manifest_dir).as_posix())}: true,"
                for path in steward_files
            )
            lines.append("}")
            content: str = "\n".join(lines) + "\n"
            handle.seek(0)
            handle.truncate()
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            if fcntl:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    return manifest_path


# pylint: disable-next=too-many-arguments,too-many-positional-arguments,unused-argument  # stable caller signature
def build_manifest(plan: DeploymentPlan, network_config: Dict[str, Any],
                   mock_router: str, byok_router: str, site_base: str, theme: ThemeSpec,
                   mcp_host: str = "127.0.0.1", static_bundle: bool = False,  # pylint: disable=unused-argument
                   mock_llm: bool = False) -> Dict[str, Any]:
    """
    Build the agent-manifest.json document that the browser runtime and peer sites read.

    :param plan: The resolved deployment plan.
    :param network_config: The rewritten network config (unused; kept for caller compatibility).
    :param mock_router: URL of the mock LLM router.
    :param byok_router: URL of the BYOK LLM proxy.
    :param site_base: Public base URL of the site.
    :param theme: The site theme.
    :param mcp_host: Host for local MCP servers (unused; kept for caller compatibility).
    :param static_bundle: Whether the output is a static bundle without Python services.
    :param mock_llm: Whether the site defaults to the mock LLM router.
    :return: The manifest document.
    """
    meta: Dict[str, Any] = plan.config.get("metadata", {}) or {}
    front_fn: Dict[str, Any] = next((a.get("function", {}) for a in plan.agents if a.get("name") == plan.front_man), {})
    description: str
    description = theme.tagline or (front_fn.get("description") or meta.get("description") or plan.network_name).strip()
    allowed_peers: List[str] = []
    if site_base and (plan.hostable_tools or plan.external_mcps):  # legacy compatibility for older runtimes
        allowed_peers.append(site_base)
    allowed_peers.extend(origin for origin in (_origin(url) for url in plan.links.values()) if origin)
    # Modern runtimes use peer_policy.mode=open, but publish direct URL-tool origins
    # for compatibility with older allow-list runtimes.
    allowed_peers.extend(origin for origin in (_origin(url) for url in plan.external_networks) if origin)
    allowed_peers = list(dict.fromkeys(allowed_peers))
    manifest: Dict[str, Any] = {
        "brand": _brand_display(plan, theme),
        "networks": [
            {
                "name": plan.network_name,
                "front_man": plan.front_man,
                "hocon": (f"./{plan.network_name}.network.json" if static_bundle
                          else f"/{plan.network_name}.network.json"),
                "description": description,
                "tags": ["deployed", "nsdeploy"],
                "sample_queries": meta.get("sample_queries", []) or [],
            }
        ],
        # Real BYOK is the safe production default. The deterministic mock remains
        # available only when the developer explicitly enables it for this build.
        "llm_router": {
            "base_url": mock_router if mock_llm else byok_router,
            "mock": mock_llm,
            "byok_router": byok_router,
            **({"mock_router": mock_router} if mock_llm else {}),
        },
        "allowed_peers": allowed_peers,
        "peer_policy": {
            "mode": "open",
            "deny_origins": [],
            "note": "Public agent sites are reachable like web pages; credentials and capabilities do not transfer.",
        },
        "agent_mcp": build_agent_mcp_metadata(plan, site_base, available=not static_bundle),
        "theme": {"primary": theme.colors["primary"]},
        "linking": build_linking_metadata(plan, site_base, static_bundle=static_bundle),
    }
    if static_bundle:
        manifest["deployment"] = {
            "mode": "static",
            "self_contained_runtime": True,
            "browser_mock": mock_llm,
            "direct_byok": True,
            "direct_mcp_requires_cors": True,
            "public_mcp_facade": False,
        }
    if theme.welcome:  # LLM-proposed branded landing form (greeting + intake widget)
        welcome: Dict[str, Any] = dict(theme.welcome)
        welcome.setdefault("message", theme.hero or "")
        manifest["welcome"] = welcome
    return manifest


def _root_vars(theme: ThemeSpec) -> str:
    c: Dict[str, str] = theme.colors
    return (f":root{{--ns-font:{theme.font};--ns-bg:{c['bg']};--ns-fg:{c['fg']};--ns-muted:{c['muted']};"
            f"--ns-border:{c['border']};--ns-primary:{c['primary']};--ns-accent:{c['accent']};"
            f"--ns-msgbg:{c['msgbg']};--ns-panelbg:{c['panelbg']};"
            f"--ns-user-bg:linear-gradient(135deg,{c['primary']},{c['accent']});--ns-radius:{theme.radius}px;}}")


_BOOT: str = """<script type="module">
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
_STATIC_BOOT: str = """<script type="module">
    import { boot } from "./runtime/index.js";
    const siteBase = new URL("./", window.location.href).href;
    boot("#app", {
      originUrl: siteBase,
      sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
    }).then(async (runtime) => {
      try {
        const site = await import("./site.js");
        await site.customize?.({ root: document.querySelector("#app"), runtime });
      } catch (e) {
        console.error("Site customization error", e);
      }
    }).catch((e) => {
      const a = document.querySelector("#app"); if (a) a.textContent = "Boot error: " + e.message;
      console.error(e);
    });
  </script>"""
_META: str = ('<meta charset="utf-8" />\n'
              '  <meta name="viewport" content="width=device-width, initial-scale=1" />')


def _doc(title: str, body: str, static_bundle: bool = False) -> str:
    boot: str = _STATIC_BOOT if static_bundle else _BOOT
    theme_href: str = "./theme.css" if static_bundle else "/theme.css"
    return (f"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  {_META}\n  <title>{title}</title>\n"
            f"  <link rel=\"stylesheet\" href=\"{theme_href}\" />\n"
            f"</head>\n<body>\n{body}\n  {boot}\n</body>\n</html>\n")


def _index_html(theme: ThemeSpec, brand_display: str, static_bundle: bool = False) -> str:
    title: str = html.escape(brand_display)
    if theme.body:
        return _doc(title, theme.body, static_bundle=static_bundle)
    # Default fixed template (keyless / no creative layout).
    return _doc(title, f'<div id="app">Loading {title}...</div>', static_bundle=static_bundle)


def _theme_css(theme: ThemeSpec) -> str:
    """Assemble editable theme CSS with the runtime's non-editable safety guards."""
    c: Dict[str, str] = theme.colors
    if theme.body and 'data-ns-layout="fixed"' not in theme.body:
        # New themes compose the runtime's surfaces in mount slots; older themes still
        # get the fixed shell. Keep the app and CRUSE forms reachable in either case.
        guard: str = (
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


# Single build entry point that writes every output file in one pass.
# pylint: disable=too-many-arguments,too-many-positional-arguments,too-many-locals,too-many-branches
# pylint: disable=too-many-statements
def generate_site(plan: DeploymentPlan, out_dir: Path, mock_router: str, byok_router: str,
                  site_base: str, mcp_host: str = "127.0.0.1", cruse: bool = True,
                  theme: Optional[ThemeSpec] = None,
                  site_source_dir: Optional[Path] = None,
                  private_steward_sites: Optional[Dict[str, str]] = None,
                  static_bundle: bool = False,
                  runtime_dir: Optional[Path] = None,
                  actions_file: Optional[Path] = None,
                  action_pages: Optional[List[str]] = None, action_modules: Optional[List[str]] = None,
                  action_caller_origins: Optional[List[str]] = None, action_host_page: bool = False,
                  discovered_actions: Optional[Dict[str, Any]] = None,
                  mock_llm: bool = False) -> Dict[str, Any]:
    """Build the disposable static output from network data and editable site source."""
    theme = theme or ThemeSpec()
    out_dir.mkdir(parents=True, exist_ok=True)
    if site_source_dir:
        assets: Path = site_source_dir / "assets"
        if assets.is_dir():
            shutil.copytree(assets, out_dir / "assets", dirs_exist_ok=True)
    network_config: Dict[str, Any] = rewrite_config(
        plan, site_base, mcp_host=mcp_host, cruse=cruse, static_bundle=static_bundle,
    )
    manifest: Dict[str, Any] = build_manifest(
        plan, network_config, mock_router, byok_router, site_base, theme,
        mcp_host=mcp_host, static_bundle=static_bundle, mock_llm=mock_llm,
    )
    # Site-owned JavaScript is loaded only on its own origin. Peer callers learn
    # schemas through the bridge, never by importing foreign executable code.
    action_source: Optional[Path] = actions_file or (site_source_dir / "actions.js" if site_source_dir else None)
    discovery: Dict[str, Any] = action_discovery_config(action_pages, action_modules, action_caller_origins,
                                                        action_host_page, bool(discovered_actions))
    if discovery:
        manifest["actions"] = {"version": 1, "bridge": "./action-bridge.html", **discovery}
    if discovered_actions:
        manifest["actions"]["catalog"] = "./discovered-actions.json"
        (out_dir / "discovered-actions.json").write_text(json.dumps(discovered_actions, indent=2),
                                                         encoding="utf-8")
    if action_source and action_source.is_file():
        manifest.setdefault("actions", {"version": 1, "bridge": "./action-bridge.html"})["module"] = "./actions.js"
        if action_source.resolve() != (out_dir / "actions.js").resolve():
            shutil.copyfile(action_source, out_dir / "actions.js")
    if "actions" in manifest:
        enabled_count: int = 0
        action: Dict[str, Any]
        # Count the discovered operations that are explicitly enabled.
        for action in (discovered_actions or {}).get("actions", []):
            if action.get("enabled") is True:
                enabled_count += 1
        print("   browser actions: " + ("adapter; " if action_source and action_source.is_file() else "")
              + (f"{enabled_count} discovered operation(s); " if discovered_actions else "")
              + f"{len(action_pages or [])} form page(s), {len(action_modules or [])} existing module(s); "
              + "capabilities checked on the owning origin at runtime")
        if action_host_page:
            print("   host-page forms: local only; embed the widget beside existing native forms. "
                  "Remote callers need --action-page routes or a registered module.")
        if (action_pages or discovered_actions) and not action_caller_origins:
            print("   form actions: remote access disabled; use --action-caller-origin to allow a caller.")
        (out_dir / "action-bridge.html").write_text(
            '<!doctype html><html><head><meta charset="utf-8"><title>Review site action</title>'
            '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
            '<body><p>Site action connection. You may sign in on this site in another tab, then return here.</p>'
            '<script type="module" src="./runtime/action-bridge.js"></script></body></html>', encoding="utf-8")
    else:
        print("   browser actions: NONE configured. Chat/forms collect information only. "
              "Use --action-site for public external forms/APIs, --action-page for existing routes, "
              "--action-host-page for an embedded widget, "
              "or --actions/--action-module for JavaScript. --site-url does not identify an action source.")

    (out_dir / f"{plan.network_name}.network.json").write_text(
        json.dumps(network_config, indent=2), encoding="utf-8")
    (out_dir / "agent-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    agent_mcp: Dict[str, Any] = build_agent_mcp_metadata(plan, site_base, available=not static_bundle)
    (out_dir / "agent-mcp.json").write_text(json.dumps(agent_mcp, indent=2), encoding="utf-8")
    well_known: Path = out_dir / ".well-known"
    well_known.mkdir(parents=True, exist_ok=True)
    (well_known / "nsdeploy.json").write_text(
        json.dumps(manifest["linking"], indent=2), encoding="utf-8")
    (well_known / "nsdeploy-agent.json").write_text(json.dumps(agent_mcp, indent=2), encoding="utf-8")
    steward_path: Path = out_dir / f"{plan.network_name}_private_steward.hocon"
    legacy_steward_path: Path = out_dir / "private-steward.hocon"
    if static_bundle:
        # A private steward is an operator-side Neuro-SAN configuration, not a
        # browser asset. Keep static webroots limited to files the browser or
        # static host actually consumes, and clean up outputs regenerated from
        # older nsDeploy releases.
        obsolete_steward: Path
        for obsolete_steward in (steward_path, legacy_steward_path):
            if obsolete_steward.is_file():
                obsolete_steward.unlink()
        # Do not create an empty operator manifest as a side effect of a fresh
        # static build. If one already exists, refresh it to drop stale entries.
        if (out_dir.parent / "manifest.hocon").is_file():
            write_private_steward_manifest(out_dir.parent)
    else:
        if legacy_steward_path.is_file() and not steward_path.is_file():
            legacy_steward_path.replace(steward_path)
        elif legacy_steward_path.is_file():
            legacy_steward_path.unlink()
        steward_path.write_text(
            build_private_steward_hocon(plan, site_base, private_steward_sites), encoding="utf-8")
        write_private_steward_manifest(out_dir.parent)

    # Preserve valid runtime-created bindings across regeneration. Each site owns
    # only its own outbound map; this file is not a registry or discovery service.
    links_path: Path = out_dir / "links.json"
    existing: Dict[str, Any] = {}
    if links_path.is_file():
        try:
            existing = json.loads(links_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            existing = {}
    old: Dict[str, Any] = ((existing.get("networks") or {}).get(plan.network_name) or {})
    bindings: Dict[str, str] = {ref: url for ref, url in old.items() if ref in plan.link_slots and isinstance(url, str)}
    bindings.update(plan.links)
    links_doc: Dict[str, Any] = {"version": 1, "networks": {plan.network_name: bindings}}
    links_path.write_text(json.dumps(links_doc, indent=2), encoding="utf-8")
    index_html: str = _index_html(theme, _brand_display(plan, theme), static_bundle=static_bundle)
    if action_pages:
        generated_path: str = urlsplit(site_base).path.rstrip("/")
        page: str
        for page in action_pages:
            path: str = urlsplit(page).path.rstrip("/")
            if path in (generated_path, generated_path + "/index.html") and not re.search(r"<form\b", index_html, re.I):
                print(f"   WARNING: --action-page {page} targets the generated agent page, which has no native forms. "
                      "Point discovery at an existing application route on this origin.")
    (out_dir / "index.html").write_text(index_html, encoding="utf-8")
    (out_dir / "theme.css").write_text(_theme_css(theme), encoding="utf-8")
    site_js: str = DEFAULT_SITE_JS
    if site_source_dir and (site_source_dir / "site.js").is_file():
        site_js = (site_source_dir / "site.js").read_text(encoding="utf-8")
    (out_dir / "site.js").write_text(site_js, encoding="utf-8")
    (out_dir / "theme.json").write_text(json.dumps(theme.to_dict(), indent=2), encoding="utf-8")
    if static_bundle:
        source_runtime: Path = (runtime_dir or DEFAULT_RUNTIME_DIR).resolve()
        shutil.copytree(source_runtime, out_dir / "runtime", dirs_exist_ok=True)
        _write_static_hosting_files(out_dir, plan.network_name, site_base)
    return manifest
# pylint: enable=too-many-arguments,too-many-positional-arguments,too-many-locals,too-many-branches
# pylint: enable=too-many-statements


def _write_static_hosting_files(out_dir: Path, network_name: str, site_base: str = "") -> None:
    """Emit optional header files for common static hosts.

    The bundle still loads on a plain server. These headers are needed when another
    domain fetches the published agent files and to retain the coded-tool worker's
    hard CSP boundary.
    """
    prefix: str = urlsplit(site_base).path.rstrip("/")
    public_files: List[str] = ["agent-manifest.json", f"{network_name}.network.json", "links.json",
                               "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json"]
    cors_headers: str = "".join(f"{prefix}/{path}\n  Access-Control-Allow-Origin: *\n" for path in public_files)
    (out_dir / "_headers").write_text(
        cors_headers + f"{prefix}/runtime/sandbox-worker.js\n"
        f"  Content-Security-Policy: {WORKER_CSP}\n",
        encoding="utf-8",
    )
    (out_dir / ".htaccess").write_text(
        "<IfModule mod_headers.c>\n"
        '  <FilesMatch "^(' + '|'.join(re.escape(Path(path).name) for path in public_files) + ')$">\n'
        '    Header always set Access-Control-Allow-Origin "*"\n'
        "  </FilesMatch>\n"
        "  <Files \"sandbox-worker.js\">\n"
        f"    Header always set Content-Security-Policy \"{WORKER_CSP}\"\n"
        "  </Files>\n"
        "</IfModule>\n",
        encoding="utf-8",
    )
    (out_dir / "STATIC_HOSTING.md").write_text(
        "# Static nsDeploy bundle\n\n"
        f"Publish this directory at `{prefix or '/'}` on the application's origin. The site, browser runtime, and "
        "browser-local links require no application server.\n\n"
        "For cross-domain agent loading, configure only these public data files with "
        "`Access-Control-Allow-Origin: *`:\n\n" + "".join(f"- `{prefix}/{path}`\n" for path in public_files) + "\n"
        "Action JavaScript and bridge pages do not need CORS: they load on their owning "
        "origin and exchange validated messages with callers. Do not apply these CORS "
        "headers to business endpoints. The included `_headers` file is used by "
        "Netlify and compatible hosts; Apache can use the included `.htaccess` when "
        "`mod_headers` and overrides are enabled. `_headers` paths are host-root-relative: "
        "merge them into the host's root configuration when deploying under a subpath; "
        "adjust the prefix if relocating the bundle. `.htaccess` stays beside the bundle.\n\n"
        "For same-origin actions, this origin must also serve the real application and its backend. "
        "Use explicit --action-page routes, --action-host-page when embedding the widget, "
        "or registered JavaScript modules. Build-time --action-site discovery can instead call "
        "existing public external forms/APIs that already allow CORS from this agent origin. "
        "Review discovered-actions.json; OPTIONS checks do not verify execution. External "
        "requests omit credentials. A themed agent page does not create business "
        "capabilities. The host must allow approved callers to frame action-bridge.html "
        "(CSP frame-ancestors / X-Frame-Options); a user-opened popup is the fallback. "
        "Writes require the owning-site popup confirmation. Authenticated iframe reads "
        "may be restricted by browser cookie policy; use top-level actions when needed.\n\n"
        "Serve `runtime/sandbox-worker.js` with:\n\n"
        f"    Content-Security-Policy: {WORKER_CSP}\n\n"
        "Real BYOK calls go directly from the browser to the router selected in settings, "
        "so that router must allow browser CORS. External MCP servers are also contacted "
        "directly and must allow browser CORS. Python tools and the public MCP facade are "
        "not included. Unresolved links are stored in this browser's local storage.\n",
        encoding="utf-8",
    )
