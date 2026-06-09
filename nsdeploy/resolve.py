"""
Resolve a neuro-san(-studio) agent-network HOCON into a flat, dependency-checked
deployment plan.

This is the first stage of `nsdeploy`. It:
  * fully resolves the HOCON (includes + ${...} substitutions) with pyhocon, using
    the studio root as the include base — so `include "registries/aaosa.hocon"` and
    `${aaosa_call}` resolve exactly as they would when neuro-san loads it;
  * classifies every entry in `tools` (LLM agent / coded tool / toolbox tool /
    MCP-URL / sub-agent reference);
  * resolves toolbox tools against the studio's toolbox_info.hocon + coded_tools/,
    deciding which can be HOSTED as MCP servers and which are MISSING;
  * flags `demo_mode` agents (fabricate responses — not grounded);
  * flags missing includes and external (non-hostable) MCP URLs.

Nothing here depends on a running neuro-san SERVER; pyhocon is a build-time library
only, and the produced plan/config is plain data the browser runtime consumes.
"""
from __future__ import annotations

import importlib
import io
import logging
import re
import subprocess
import sys
from contextlib import redirect_stderr
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from pyhocon import ConfigFactory

from nsdeploy.studio import StudioSource

# Substring that marks an agent as running in non-grounded "demo mode" (it is told
# to fabricate realistic-looking answers). Matches the studio's demo_mode template.
DEMO_MODE_MARKER = "part of a demo system"

# `include "path"` / `include required("path")` / `include url("path")`
_INCLUDE_RE = re.compile(r'include\s+(?:required\s*\(\s*|url\s*\(\s*)?["\']([^"\']+)["\']')

# Auto-install a coded tool's missing pip dependency on demand (so the end user
# needs no studio install). Toggle off by setting this to False.
AUTO_INSTALL_TOOL_DEPS = True


@dataclass
class HostableTool:
    """A toolbox/coded tool we can run as a local MCP server."""

    name: str
    class_path: str          # e.g. "ddgs_search.DdgsSearch" (from toolbox_info)
    module: str              # importable module, e.g. "coded_tools.ddgs_search"
    class_name: str          # e.g. "DdgsSearch"
    description: str
    parameters: Dict[str, Any]
    port: int = 0            # assigned by the planner


@dataclass
class DeploymentPlan:
    network_name: str
    config: Dict[str, Any]               # fully-resolved network config
    front_man: str
    agents: List[Dict[str, Any]] = field(default_factory=list)
    demo_mode_agents: List[str] = field(default_factory=list)
    hostable_tools: List[HostableTool] = field(default_factory=list)
    missing_tools: List[str] = field(default_factory=list)      # referenced, unresolvable
    external_mcps: List[str] = field(default_factory=list)      # http(s) MCP URLs we don't host
    missing_includes: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


def _prefetch_includes(text: str, source: StudioSource, missing: List[str], seen: set) -> None:
    """Recursively materialize every `include`d file (from the source) into the
    source root so pyhocon can resolve them locally."""
    for rel in _INCLUDE_RE.findall(text):
        if rel in seen or rel.startswith(("http://", "https://")):
            continue
        seen.add(rel)
        path = source.ensure(rel)
        if path is None:
            missing.append(f"Cannot include file {rel} (not found in {getattr(source, 'repo', source.root)}).")
            continue
        _prefetch_includes(path.read_text(encoding="utf-8"), source, missing, seen)


def resolve_hocon(hocon_path: Path, source: StudioSource) -> tuple[Dict[str, Any], List[str]]:
    """Parse + fully resolve a HOCON, with includes resolved from `source` (a local
    checkout or the GitHub repo) into source.root.

    Returns (config_dict, missing_includes). Missing includes are non-fatal (e.g. an
    absent llm_config.hocon just means the runtime falls back to its default model).
    """
    content = hocon_path.read_text(encoding="utf-8")
    missing: List[str] = []
    _prefetch_includes(content, source, missing, set())

    captured: List[str] = []

    class _IncludeCapture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            msg = record.getMessage()
            if "Cannot include file" in msg or "does not exist" in msg.lower():
                captured.append(msg)

    handler = _IncludeCapture()
    pyhocon_logger = logging.getLogger("pyhocon.config_parser")
    pyhocon_logger.addHandler(handler)
    try:
        # Includes were pre-fetched into source.root above; basedir makes pyhocon
        # resolve them there, regardless of where the input HOCON physically lives.
        with redirect_stderr(io.StringIO()):
            cfg = ConfigFactory.parse_string(content, basedir=str(source.root))
    finally:
        pyhocon_logger.removeHandler(handler)
    missing.extend(m for m in captured if m not in missing)

    config = cfg.as_plain_ordered_dict() if hasattr(cfg, "as_plain_ordered_dict") else dict(cfg)
    return config, missing


def load_toolbox_info(source: StudioSource) -> Dict[str, Any]:
    """Load toolbox_info.hocon from the source (name -> {class, description, parameters})."""
    path = source.ensure("toolbox/toolbox_info.hocon")
    if not path:
        return {}
    cfg = ConfigFactory.parse_file(str(path))
    return cfg.as_plain_ordered_dict() if hasattr(cfg, "as_plain_ordered_dict") else dict(cfg)


def _is_demo_mode(agent: Dict[str, Any]) -> bool:
    return DEMO_MODE_MARKER in (agent.get("instructions") or "")


def _is_url(ref: Any) -> bool:
    return isinstance(ref, str) and (ref.startswith("http://") or ref.startswith("https://"))


def _import_with_autoinstall(module: str):
    """Import `module`, pip-installing a missing third-party dependency once and
    retrying (so the user needs no studio install). Returns the module or None."""
    try:
        return importlib.import_module(module)
    except ModuleNotFoundError as e:
        missing = e.name
        # Don't try to install the tool module itself, only its deps.
        if not AUTO_INSTALL_TOOL_DEPS or not missing or missing.startswith("coded_tools"):
            return None
        print(f"   …installing dependency '{missing}' for a coded tool", flush=True)
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", missing],
                           check=True)
        except subprocess.CalledProcessError:
            return None
        try:
            return importlib.import_module(module)
        except Exception:
            return None
    except Exception:
        return None


def _resolve_class(class_path: str, source: StudioSource) -> Optional[tuple[str, str]]:
    """Resolve a toolbox `class` ("[pkg.]module.Class") to an importable
    (module, Class), fetching the coded-tool source from `source` if needed.

    The module's file name (its last dotted segment) is mirrored into the source's
    `coded_tools` package and imported from there — so the repo's own package layout
    doesn't matter.
    """
    if "." not in class_path:
        return None
    module_part, class_name = class_path.rsplit(".", 1)
    module_leaf = module_part.split(".")[-1]
    if not source.ensure_coded_tool(f"{module_leaf}.py"):
        return None
    if str(source.root) not in sys.path:
        sys.path.insert(0, str(source.root))
    mod = _import_with_autoinstall(f"coded_tools.{module_leaf}")
    if mod and hasattr(mod, class_name):
        return f"coded_tools.{module_leaf}", class_name
    return None


def build_plan(config: Dict[str, Any], toolbox_info: Dict[str, Any],
               network_name: str, missing_includes: List[str], source: StudioSource) -> DeploymentPlan:
    """Classify the resolved config into a DeploymentPlan."""
    tools = config.get("tools", []) or []
    agent_names = {t["name"] for t in tools if "name" in t and "instructions" in t}

    plan = DeploymentPlan(
        network_name=network_name,
        config=config,
        front_man="",
        missing_includes=list(missing_includes),
    )

    # First agent with instructions and no class/toolbox is the front-man.
    for t in tools:
        if "instructions" in t and "class" not in t and "toolbox" not in t:
            plan.front_man = t.get("name", "")
            break

    seen_hostable: Dict[str, HostableTool] = {}
    referenced_missing: set[str] = set()
    external: set[str] = set()

    def resolve_leaf(name: str, spec: Dict[str, Any]) -> None:
        """Classify a non-agent tool entry (toolbox/class) as hostable or missing."""
        if name in seen_hostable or name in referenced_missing:
            return
        class_path = None
        description = (spec.get("function") or {}).get("description") or spec.get("description") or name
        parameters: Dict[str, Any] = (spec.get("function") or {}).get("parameters") or {}
        if "toolbox" in spec:
            info = toolbox_info.get(spec["toolbox"])
            if not info:
                referenced_missing.add(name)
                return
            class_path = info.get("class")
            description = info.get("description", description)
            parameters = info.get("parameters", parameters) or {}
        elif "class" in spec:
            class_path = spec["class"]
        if not class_path:
            referenced_missing.add(name)
            return
        resolved = _resolve_class(class_path, source)
        if not resolved:
            referenced_missing.add(name)
            return
        module, class_name = resolved
        seen_hostable[name] = HostableTool(
            name=name, class_path=class_path, module=module, class_name=class_name,
            description=description, parameters=parameters,
        )

    specs_by_name = {t["name"]: t for t in tools if "name" in t}

    for t in tools:
        name = t.get("name", "")
        if "instructions" in t and "class" not in t and "toolbox" not in t:
            plan.agents.append(t)
            if _is_demo_mode(t):
                plan.demo_mode_agents.append(name)
        elif "toolbox" in t or "class" in t:
            resolve_leaf(name, t)

    # Walk agent tool references to catch URL/MCP refs and references to leaves.
    for agent in plan.agents:
        for ref in agent.get("tools", []) or []:
            if _is_url(ref):
                external.add(ref)
            elif ref in agent_names:
                continue  # sub-agent
            elif ref in specs_by_name:
                resolve_leaf(ref, specs_by_name[ref])
            else:
                referenced_missing.add(ref)

    # Assign ports to hostable tools (one MCP server each, for tool-scoping).
    port = 9101
    for name, tool in seen_hostable.items():
        tool.port = port
        port += 1
        plan.hostable_tools.append(tool)
    plan.missing_tools = sorted(referenced_missing)
    plan.external_mcps = sorted(external)
    return plan


def format_report(plan: DeploymentPlan) -> str:
    """Human-readable dependency + grounding report."""
    out: List[str] = []
    out.append(f"Network:   {plan.network_name}")
    out.append(f"Front-man: {plan.front_man}")
    out.append(f"Agents:    {len(plan.agents)}")
    out.append("")
    out.append(f"✅ Hostable tools (will run as local MCP servers): {len(plan.hostable_tools)}")
    for tool in plan.hostable_tools:
        out.append(f"   • {tool.name}  →  {tool.class_path}  (MCP :{tool.port}/mcp)")
    if plan.demo_mode_agents:
        out.append("")
        out.append(f"⚠️  DEMO-MODE agents — NOT GROUNDED ({len(plan.demo_mode_agents)}): these fabricate")
        out.append("    realistic-looking answers instead of using real data/tools. Ground them later")
        out.append("    by giving each a real tool/data source and removing demo_mode from its instructions.")
        for name in plan.demo_mode_agents:
            out.append(f"   • {name}")
    if plan.missing_tools:
        out.append("")
        out.append(f"⚠️  Missing tools — NOT available in this studio checkout ({len(plan.missing_tools)}):")
        out.append("    these references are dropped from the deployed network; the agents using them")
        out.append("    will run without them. Add them to neuro-san-studio to ground these paths.")
        for name in plan.missing_tools:
            out.append(f"   • {name}")
    if plan.external_mcps:
        out.append("")
        out.append(f"⚠️  External MCP URLs — NOT hosted by nsdeploy ({len(plan.external_mcps)}):")
        out.append("    dropped from the deployed network (a browser call would also need the remote")
        out.append("    server to allow CORS). Re-add explicitly if the endpoint is browser-reachable.")
        for url in plan.external_mcps:
            out.append(f"   • {url}")
    if plan.missing_includes:
        out.append("")
        out.append(f"ℹ️  Missing includes (non-fatal, {len(plan.missing_includes)}):")
        for msg in plan.missing_includes:
            out.append(f"   • {msg}")
    return "\n".join(out)
