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
from pathlib import Path
from typing import Any, Dict, List, Optional

from nsdeploy.resolve import DeploymentPlan
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
    hostable_url = {t.name: f"http://{mcp_host}:{t.port}/mcp" for t in plan.hostable_tools}
    # External MCP servers are reached through a same-origin proxy (avoids CORS) and
    # given a clean /mcp URL so the runtime classifies them as MCP.
    ext_url = {url: f"{site_base}/ext-mcp/{i}/mcp" for i, url in enumerate(plan.external_mcps)}
    drop = set(plan.missing_tools) | set(plan.external_other)

    config = copy.deepcopy(plan.config)
    new_tools: List[Dict[str, Any]] = []
    for entry in config.get("tools", []) or []:
        # Keep only LLM agents; the leaf coded/toolbox entries are replaced by inline
        # MCP URLs inside the agents that reference them.
        if not ("instructions" in entry and "class" not in entry and "toolbox" not in entry):
            continue
        agent = copy.deepcopy(entry)
        mapped: List[str] = []
        for ref in agent.get("tools", []) or []:
            if ref in hostable_url:
                mapped.append(hostable_url[ref])
            elif ref in ext_url:
                mapped.append(ext_url[ref])
            elif ref in drop:
                continue  # missing tool / non-MCP external URL — dropped (reported separately)
            else:
                mapped.append(ref)  # sub-agent reference
        if "tools" in agent:
            agent["tools"] = mapped
        if cruse:  # augment instructions so the agent emits generative-UI widgets
            agent["instructions"] = (agent.get("instructions", "") or "").rstrip() + "\n\n" + CRUSE_DIRECTIVE
        new_tools.append(agent)
    config["tools"] = new_tools
    return config


def _brand_display(plan: DeploymentPlan, theme: ThemeSpec) -> str:
    brand = theme.brand or _brandize(plan.network_name)
    return f"{theme.icon} {brand}".strip() if theme.icon else brand


def build_manifest(plan: DeploymentPlan, network_config: Dict[str, Any],
                   mock_router: str, byok_router: str, site_base: str, theme: ThemeSpec,
                   mcp_host: str = "127.0.0.1") -> Dict[str, Any]:
    meta = plan.config.get("metadata", {}) or {}
    front_fn = next((a.get("function", {}) for a in plan.agents if a.get("name") == plan.front_man), {})
    description = theme.tagline or (front_fn.get("description") or meta.get("description") or plan.network_name).strip()
    allowed_peers = [f"http://{mcp_host}:{t.port}" for t in plan.hostable_tools]
    if plan.external_mcps:  # the site itself hosts the external-MCP proxy
        allowed_peers.append(site_base)
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
        "theme": {"primary": theme.colors["primary"]},
    }
    if theme.welcome:  # LLM-proposed branded landing form (greeting + intake widget)
        welcome = dict(theme.welcome)
        welcome.setdefault("message", theme.hero or "")
        manifest["welcome"] = welcome
    return manifest


def _index_html(theme: ThemeSpec, brand_display: str) -> str:
    c = theme.colors
    title = html.escape(brand_display)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    :root {{
      --ns-font: {theme.font};
      --ns-bg: {c['bg']}; --ns-fg: {c['fg']}; --ns-muted: {c['muted']};
      --ns-border: {c['border']}; --ns-primary: {c['primary']}; --ns-accent: {c['accent']};
      --ns-msgbg: {c['msgbg']}; --ns-panelbg: {c['panelbg']};
      --ns-user-bg: linear-gradient(135deg, {c['primary']}, {c['accent']}); --ns-radius: {theme.radius}px;
    }}
    html, body {{ margin: 0; height: 100%; overflow: hidden; }}
    body {{
      font-family: var(--ns-font);
      background: radial-gradient(1200px 500px at 20% -10%, {c['bg_tint']} 0%, {c['bg']} 60%);
    }}
    #app {{ height: 100vh; overflow: hidden; }}
  </style>
</head>
<body>
  <div id="app">Loading {title}…</div>
  <script type="module">
    import {{ boot }} from "/runtime/index.js";
    boot("#app").catch((e) => {{
      document.querySelector("#app").textContent = "Boot error: " + e.message;
      console.error(e);
    }});
  </script>
</body>
</html>
"""


def generate_site(plan: DeploymentPlan, out_dir: Path, mock_router: str, byok_router: str,
                  site_base: str, mcp_host: str = "127.0.0.1", cruse: bool = True,
                  theme: Optional[ThemeSpec] = None) -> Dict[str, Any]:
    """Write index.html, agent-manifest.json, <network>.network.json, and theme.json
    into out_dir. Returns the manifest dict."""
    theme = theme or ThemeSpec()
    out_dir.mkdir(parents=True, exist_ok=True)
    network_config = rewrite_config(plan, site_base, mcp_host=mcp_host, cruse=cruse)
    manifest = build_manifest(plan, network_config, mock_router, byok_router, site_base, theme, mcp_host=mcp_host)

    (out_dir / f"{plan.network_name}.network.json").write_text(
        json.dumps(network_config, indent=2), encoding="utf-8")
    (out_dir / "agent-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(_index_html(theme, _brand_display(plan, theme)), encoding="utf-8")
    (out_dir / "theme.json").write_text(json.dumps(theme.to_dict(), indent=2), encoding="utf-8")
    return manifest
