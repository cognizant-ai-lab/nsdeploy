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
import json
from pathlib import Path
from typing import Any, Dict, List

from nsdeploy.resolve import DeploymentPlan


def _brandize(network_name: str) -> str:
    return network_name.replace("_", " ").replace("-", " ").title()


def rewrite_config(plan: DeploymentPlan, mcp_host: str = "127.0.0.1") -> Dict[str, Any]:
    """Produce the deployed network config: agents only, with tool references mapped
    to local MCP URLs (hostable) or dropped (missing tools / external MCPs)."""
    hostable_url = {t.name: f"http://{mcp_host}:{t.port}/mcp" for t in plan.hostable_tools}
    drop = set(plan.missing_tools) | set(plan.external_mcps)

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
            elif ref in drop:
                continue  # missing tool / external MCP — dropped (reported separately)
            else:
                mapped.append(ref)  # sub-agent reference (or already-kept URL)
        if "tools" in agent:
            agent["tools"] = mapped
        new_tools.append(agent)
    config["tools"] = new_tools
    return config


def build_manifest(plan: DeploymentPlan, network_config: Dict[str, Any],
                   mock_router: str, byok_router: str, mcp_host: str = "127.0.0.1") -> Dict[str, Any]:
    meta = plan.config.get("metadata", {}) or {}
    front_fn = next((a.get("function", {}) for a in plan.agents if a.get("name") == plan.front_man), {})
    description = (front_fn.get("description") or meta.get("description") or plan.network_name).strip()
    allowed_peers = [f"http://{mcp_host}:{t.port}" for t in plan.hostable_tools]
    return {
        "brand": _brandize(plan.network_name),
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
        "theme": {"primary": "#0ea5e9"},
    }


def _index_html(brand: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{brand}</title>
  <style>
    :root {{
      --ns-font: "Segoe UI", system-ui, sans-serif;
      --ns-bg: #eef7ff; --ns-fg: #0f2a43; --ns-muted: #5b7a97;
      --ns-border: #cfe6fb; --ns-primary: #0ea5e9; --ns-accent: #14b8a6;
      --ns-msgbg: #e0f2fe; --ns-panelbg: #f7fcff;
      --ns-user-bg: linear-gradient(135deg, #0ea5e9, #14b8a6); --ns-radius: 16px;
    }}
    html, body {{ margin: 0; height: 100%; overflow: hidden; }}
    body {{ background: radial-gradient(1200px 500px at 20% -10%, #d8f1ff 0%, #eef7ff 60%); }}
    #app {{ height: 100vh; overflow: hidden; }}
  </style>
</head>
<body>
  <div id="app">Loading {brand}…</div>
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
                  mcp_host: str = "127.0.0.1") -> Dict[str, Any]:
    """Write index.html, agent-manifest.json, and <network>.network.json into out_dir.
    Returns the manifest dict."""
    out_dir.mkdir(parents=True, exist_ok=True)
    network_config = rewrite_config(plan, mcp_host=mcp_host)
    manifest = build_manifest(plan, network_config, mock_router, byok_router, mcp_host=mcp_host)

    (out_dir / f"{plan.network_name}.network.json").write_text(
        json.dumps(network_config, indent=2), encoding="utf-8")
    (out_dir / "agent-manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")
    (out_dir / "index.html").write_text(_index_html(manifest["brand"]), encoding="utf-8")
    return manifest
