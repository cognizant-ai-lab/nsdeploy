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
  * classifies URL tools as external MCP servers or public agent networks;
  * flags missing includes.

Nothing here depends on a running neuro-san SERVER; pyhocon is a build-time library
only, and the produced plan/config is plain data the browser runtime consumes.
"""
from __future__ import annotations

import copy
import importlib
import inspect
import io
import logging
import posixpath
import re
import subprocess
import sys
from contextlib import redirect_stderr
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from urllib.parse import urlparse

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

# Server-side Neuro-SAN adapters that are intentionally unnecessary in the
# browser runtime. Peer agents are exposed directly as tools by name.
BROWSER_OMITTED_TOOLS = {"call_agent"}


@dataclass
class HostableTool:
    """A toolbox/coded tool we can run as a local MCP server."""

    name: str
    class_path: str          # e.g. "ddgs_search.DdgsSearch" (from toolbox_info)
    module: str              # importable module, e.g. "coded_tools.ddgs_search"
    class_name: str          # e.g. "DdgsSearch"
    description: str
    parameters: Dict[str, Any]
    port: int = 0            # private runtime port; assigned by the launcher


@dataclass
class DeploymentPlan:  # pylint: disable=too-many-instance-attributes
    """
    The flat, dependency-checked deployment plan for one agent network.
    """
    network_name: str
    config: Dict[str, Any]               # fully-resolved network config
    front_man: str
    agents: List[Dict[str, Any]] = field(default_factory=list)
    demo_mode_agents: List[str] = field(default_factory=list)
    hostable_tools: List[HostableTool] = field(default_factory=list)
    missing_tools: List[str] = field(default_factory=list)       # referenced, unresolvable
    external_mcps: List[str] = field(default_factory=list)       # http(s) MCP URLs — proxied & callable
    external_networks: List[str] = field(default_factory=list)   # public agent-network URLs
    missing_includes: List[str] = field(default_factory=list)
    omitted_tools: List[str] = field(default_factory=list)      # recognized but not needed/hostable here
    link_slots: Dict[str, List[str]] = field(default_factory=dict)  # dangling agent ref -> callers
    links: Dict[str, str] = field(default_factory=dict)         # dangling ref -> remote network URL
    demo_link_fallbacks: List[str] = field(default_factory=list)  # local demo leaves usable until linked
    replaced_agents: List[str] = field(default_factory=list)    # demo leaves removed in favor of links
    notes: List[str] = field(default_factory=list)


def _prefetch_includes(text: str, source: StudioSource, missing: List[str], seen: set,
                       parent_dir: str = "") -> None:
    """Recursively materialize every `include`d file (from the source) into the
    source root so pyhocon can resolve them locally.

    Top-level includes are root-relative (neuro-san resolves them against the repo
    root). pyhocon, however, resolves an include *nested* inside an included file
    against that file's own directory: `include "developer_llm_config.hocon"` inside
    `config/llm_config.hocon` is looked up as `config/developer_llm_config.hocon`.
    So nested includes are materialized at the parent-relative path pyhocon will
    look for first, falling back to the root-relative path.
    """
    for rel in _INCLUDE_RE.findall(text):
        if rel.startswith(("http://", "https://")):
            continue
        candidates: List[str] = []
        if parent_dir and not rel.startswith("/"):
            candidates.append(posixpath.normpath(posixpath.join(parent_dir, rel)))
        if rel not in candidates:
            candidates.append(rel)
        found = False
        for logical in candidates:
            if logical in seen:
                found = True  # already attempted (and reported, if missing)
                break
            seen.add(logical)
            path = source.ensure(logical)
            if path is None:
                continue
            found = True
            _prefetch_includes(path.read_text(encoding="utf-8"), source, missing, seen,
                               parent_dir=posixpath.dirname(logical))
            break
        if not found:
            missing.append(f"Cannot include file {rel} (not found in {getattr(source, 'repo', source.root)}).")


def resolve_hocon(hocon_path: Path, source: StudioSource) -> tuple[Dict[str, Any], List[str]]:
    """Parse + fully resolve a HOCON, with includes resolved from `source` (a local
    checkout or the GitHub repo) into source.root.

    Returns (config_dict, missing_includes). Missing includes are non-fatal (e.g. an
    absent llm_config.hocon just means the runtime falls back to its default model).
    """
    return _parse_hocon_content(hocon_path.read_text(encoding="utf-8"), source)


def _parse_hocon_content(content: str, source: StudioSource) -> tuple[Dict[str, Any], List[str]]:
    """Parse HOCON text using source.root as the include base."""
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
        with redirect_stderr(io.StringIO()):
            cfg = ConfigFactory.parse_string(content, basedir=str(source.root))
    finally:
        pyhocon_logger.removeHandler(handler)
    missing.extend(m for m in captured if m not in missing)
    config = cfg.as_plain_ordered_dict() if hasattr(cfg, "as_plain_ordered_dict") else dict(cfg)
    return config, missing


def _network_ref_to_rel_path(ref: Any) -> Optional[str]:
    """Map /industry/foo to registries/industry/foo.hocon."""
    if not isinstance(ref, str) or not ref.startswith("/"):
        return None
    logical = ref.strip("/")
    if not logical:
        return None
    if not logical.endswith(".hocon"):
        logical += ".hocon"
    if not logical.startswith("registries/"):
        logical = f"registries/{logical}"
    return logical


def _agent_prefix(ref: str) -> str:
    stem = ref.strip("/")
    if stem.endswith(".hocon"):
        stem = stem[:-6]
    return re.sub(r"[^A-Za-z0-9_]+", "_", stem).strip("_") or "embedded"


def _is_llm_agent(entry: Dict[str, Any]) -> bool:
    return "instructions" in entry and "class" not in entry and "toolbox" not in entry


def _find_front_man(config: Dict[str, Any]) -> str:
    for entry in config.get("tools", []) or []:
        if _is_llm_agent(entry):
            return entry.get("name", "")
    return ""


def expand_embedded_network_refs(config: Dict[str, Any], source: StudioSource,
                                 missing_includes: List[str]) -> Dict[str, str]:
    """Fetch slash-referenced registry HOCONs and inline their agents.

    Returns a mapping from the original slash ref to the generated embedded front-man
    agent name. All imported agent names are prefixed to avoid collisions.
    """
    aliases: Dict[str, str] = {}
    expanded: set[str] = set()

    def expand_ref(ref: str) -> Optional[str]:  # pylint: disable=too-many-return-statements
        if ref in aliases:
            return aliases[ref]
        rel_path = _network_ref_to_rel_path(ref)
        if not rel_path:
            return None
        path = source.ensure(rel_path)
        if not path:
            return None
        if ref in expanded:
            return aliases.get(ref)
        expanded.add(ref)

        child_config, child_missing = _parse_hocon_content(path.read_text(encoding="utf-8"), source)
        missing_includes.extend(m for m in child_missing if m not in missing_includes)
        child_aliases = expand_embedded_network_refs(child_config, source, missing_includes)

        child_tools = child_config.get("tools", []) or []
        child_agents = [copy.deepcopy(t) for t in child_tools if _is_llm_agent(t)]
        if not child_agents:
            return None

        prefix = _agent_prefix(ref)
        name_map = {a.get("name", ""): f"{prefix}__{a.get('name', '')}" for a in child_agents if a.get("name")}
        front_man = _find_front_man(child_config)
        if front_man not in name_map:
            return None

        for agent in child_agents:
            original_name = agent.get("name", "")
            agent["name"] = name_map.get(original_name, original_name)
            mapped_refs: List[Any] = []
            for tool_ref in agent.get("tools", []) or []:
                if tool_ref in name_map:
                    mapped_refs.append(name_map[tool_ref])
                elif tool_ref in child_aliases:
                    mapped_refs.append(child_aliases[tool_ref])
                else:
                    mapped_refs.append(tool_ref)
            if "tools" in agent:
                agent["tools"] = mapped_refs
            config.setdefault("tools", []).append(agent)

        aliases[ref] = name_map[front_man]
        return aliases[ref]

    for entry in list(config.get("tools", []) or []):
        if not _is_llm_agent(entry):
            continue
        mapped_refs: List[Any] = []
        for ref in entry.get("tools", []) or []:
            alias = expand_ref(ref) if isinstance(ref, str) and ref.startswith("/") else None
            mapped_refs.append(alias or ref)
        if "tools" in entry:
            entry["tools"] = mapped_refs
    return aliases


def load_toolbox_info(source: StudioSource) -> Dict[str, Any]:
    """Load toolbox_info.hocon from the source (name -> {class, description, parameters})."""
    path = source.ensure("toolbox/toolbox_info.hocon")
    if not path:
        return {}
    cfg = ConfigFactory.parse_file(str(path))
    return cfg.as_plain_ordered_dict() if hasattr(cfg, "as_plain_ordered_dict") else dict(cfg)


def _is_demo_mode(agent: Dict[str, Any]) -> bool:
    return DEMO_MODE_MARKER in (agent.get("instructions") or "")


def _is_demo_leaf(agent: Dict[str, Any]) -> bool:
    """A local fake-data agent that can be replaced by a same-named network."""
    return _is_llm_agent(agent) and _is_demo_mode(agent) and not (agent.get("tools") or [])


def _is_url(ref: Any) -> bool:
    return isinstance(ref, str) and (ref.startswith("http://") or ref.startswith("https://"))


def _looks_like_mcp(url: str) -> bool:
    """A URL pointing at an MCP server — by path (ignoring any query string)."""
    path = urlparse(url).path.lower()
    return path.endswith("/mcp") or "/mcp/" in path or path.endswith("/sse")


def _configured_links(config: Dict[str, Any]) -> Dict[str, str]:
    """Normalize optional HOCON `links` entries into ref -> remote URL."""
    links: Dict[str, str] = {}
    for ref, value in (config.get("links", {}) or {}).items():
        url = value if isinstance(value, str) else (value or {}).get("url")
        if isinstance(ref, str) and isinstance(url, str) and _is_url(url):
            links[ref] = url.rstrip("/")
    return links


def _import_with_autoinstall(module: str):
    """Import `module`, pip-installing missing third-party dependencies (chained —
    a tool may need several) and retrying, so the user needs no studio install.
    Returns the module or None."""
    tried: set[str] = set()
    for _ in range(8):
        try:
            importlib.invalidate_caches()  # see packages installed during this loop
            return importlib.import_module(module)
        except ModuleNotFoundError as e:
            missing = e.name
            # Only install the tool's deps, and only once each; never the tool itself.
            if (not AUTO_INSTALL_TOOL_DEPS or not missing
                    # pylint: disable-next=no-member  # false positive: ModuleNotFoundError.name is a str here
                    or missing.startswith(("coded_tools", "neuro_san_studio")) or missing in tried):
                return None
            tried.add(missing)
            print(f"   …installing dependency '{missing}' for a coded tool", flush=True)
            try:
                subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", missing],
                               check=True)
            except subprocess.CalledProcessError:
                return None
        except Exception:  # pylint: disable=broad-exception-caught; any tool import failure means not hostable
            return None
    return None


def _can_construct_with_no_args(cls: Any) -> bool:
    """Standalone MCP hosts can only wrap plain coded tools with zero-arg constructors."""
    try:
        sig = inspect.signature(cls)
    except (TypeError, ValueError):
        return True
    return all(
        param.default is not inspect.Parameter.empty
        or param.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
        for param in sig.parameters.values()
    )


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
    module = f"coded_tools.{module_leaf}"
    mod = _import_with_autoinstall(module)
    if mod and hasattr(mod, class_name) and _can_construct_with_no_args(getattr(mod, class_name)):
        return module, class_name
    return None


# pylint: disable-next=too-many-arguments,too-many-positional-arguments,too-many-locals,too-many-branches
def build_plan(config: Dict[str, Any], toolbox_info: Dict[str, Any],  # pylint: disable=too-many-statements
               network_name: str, missing_includes: List[str], source: StudioSource,
               include_python_tools: bool = True) -> DeploymentPlan:
    """Classify the resolved config into a DeploymentPlan."""
    config = copy.deepcopy(config)
    all_missing_includes = list(missing_includes)
    expand_embedded_network_refs(config, source, all_missing_includes)
    tools = config.get("tools", []) or []
    agent_names = {t["name"] for t in tools if "name" in t and "instructions" in t}

    plan = DeploymentPlan(
        network_name=network_name,
        config=config,
        front_man="",
        missing_includes=all_missing_includes,
    )

    # First agent with instructions and no class/toolbox is the front-man.
    for t in tools:
        if "instructions" in t and "class" not in t and "toolbox" not in t:
            plan.front_man = t.get("name", "")
            break

    seen_hostable: Dict[str, HostableTool] = {}
    referenced_missing: set[str] = set()
    referenced_omitted: set[str] = set()
    referenced_links: Dict[str, set[str]] = {}
    external_mcp: set[str] = set()
    external_networks: set[str] = set()
    configured_links = _configured_links(config)
    demo_leaf_names = {
        t.get("name", "") for t in tools
        if t.get("name") and _is_demo_leaf(t)
    }
    referenced_demo_leaves: Dict[str, set[str]] = {}
    for owner in tools:
        if not _is_llm_agent(owner):
            continue
        for ref in owner.get("tools", []) or []:
            if ref in demo_leaf_names and ref != owner.get("name"):
                referenced_demo_leaves.setdefault(ref, set()).add(owner.get("name", ""))
    replaced_demo_leaves = set(configured_links) & set(referenced_demo_leaves)

    def resolve_leaf(name: str, spec: Dict[str, Any]) -> None:
        """Classify a non-agent tool entry (toolbox/class) as hostable or missing."""
        if name in seen_hostable or name in referenced_missing or name in referenced_omitted:
            return
        if name in BROWSER_OMITTED_TOOLS or not include_python_tools:
            referenced_omitted.add(name)
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
            if name in replaced_demo_leaves:
                continue
            plan.agents.append(t)
            if _is_demo_mode(t):
                plan.demo_mode_agents.append(name)
        elif "toolbox" in t or "class" in t:
            resolve_leaf(name, t)

    # Walk agent tool references to catch URL/MCP refs and references to leaves.
    for agent in plan.agents:
        for ref in agent.get("tools", []) or []:
            if _is_url(ref):
                (external_mcp if _looks_like_mcp(ref) else external_networks).add(ref)
            elif ref in referenced_demo_leaves:
                referenced_links.setdefault(ref, set()).add(agent.get("name", ""))
            elif ref in agent_names:
                continue  # sub-agent
            elif ref in specs_by_name:
                resolve_leaf(ref, specs_by_name[ref])
            else:
                # Undefined names are intentional, linkable agent-network slots.
                # Broken declared coded/toolbox entries remain missing tools above.
                if isinstance(ref, str):
                    referenced_links.setdefault(ref, set()).add(agent.get("name", ""))
                else:
                    referenced_missing.add(str(ref))

    # Runtime ports are deliberately not part of the deployment plan. The launcher
    # assigns an available private port and exposes each tool at a stable same-origin
    # /_mcp/<index>/mcp URL, so independently launched sites cannot collide.
    plan.hostable_tools.extend(seen_hostable.values())
    plan.missing_tools = sorted(referenced_missing)
    plan.omitted_tools = sorted(referenced_omitted)
    plan.external_mcps = sorted(external_mcp)
    plan.external_networks = sorted(external_networks)
    plan.link_slots = {
        ref: sorted(name for name in callers if name)
        for ref, callers in sorted(referenced_links.items())
    }
    plan.links = {ref: configured_links[ref] for ref in plan.link_slots if ref in configured_links}
    plan.demo_link_fallbacks = sorted(set(referenced_demo_leaves) - set(plan.links))
    plan.replaced_agents = sorted(set(referenced_demo_leaves) & set(plan.links))
    return plan


# pylint: disable-next=too-many-branches,too-many-statements  # one section per plan field
def format_report(plan: DeploymentPlan, static_bundle: bool = False) -> str:
    """Human-readable dependency + grounding report."""
    out: List[str] = []
    out.append(f"Network:   {plan.network_name}")
    out.append(f"Front-man: {plan.front_man}")
    out.append(f"Agents:    {len(plan.agents)}")
    out.append("")
    out.append(f"✅ Hostable tools (will run as local MCP servers): {len(plan.hostable_tools)}")
    for index, tool in enumerate(plan.hostable_tools):
        out.append(f"   • {tool.name}  →  {tool.class_path}  (MCP /_mcp/{index}/mcp)")
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
    if plan.link_slots:
        linked = set(plan.links)
        out.append("")
        out.append(f"🔗 Agent-network link slots ({len(plan.link_slots)}):")
        out.append("    demo leaf fallbacks remain local until linked; undefined references remain callable.")
        for ref, callers in plan.link_slots.items():
            if ref in linked:
                status = f"linked → {plan.links[ref]} (demo leaf replaced)"
            elif ref in plan.demo_link_fallbacks:
                status = "demo fallback active (replaceable at link time)"
            else:
                status = "pending (link at deploy time or on first call)"
            owner = f"; called by {', '.join(callers)}" if callers else ""
            out.append(f"   • {ref}: {status}{owner}")
    if plan.omitted_tools:
        out.append("")
        if static_bundle:
            out.append(f"ℹ️  Omitted Python/server tools ({len(plan.omitted_tools)}):")
            out.append("    static bundles do not install or execute Python tools.")
        else:
            out.append(f"ℹ️  Omitted browser-native adapters ({len(plan.omitted_tools)}):")
            out.append("    these server-side Neuro-SAN adapters are not hosted as MCP tools because")
            out.append("    the browser runtime calls peer agents directly.")
        for name in plan.omitted_tools:
            out.append(f"   • {name}")
    if plan.external_mcps:
        out.append("")
        if static_bundle:
            out.append(f"🔌 External MCP servers — DIRECT & callable with CORS ({len(plan.external_mcps)}):")
            out.append("    the remote server must allow browser CORS; each call still requires consent.")
        else:
            out.append(f"🔌 External MCP servers — PROXIED & callable ({len(plan.external_mcps)}): reached")
            out.append("    via a same-origin proxy (so browser CORS is a non-issue); the call still")
            out.append("    requires the remote server to be reachable + the user to consent at run time.")
        for url in plan.external_mcps:
            out.append(f"   • {url}")
    if plan.external_networks:
        out.append("")
        out.append(f"🌐 Public agent networks — callable ({len(plan.external_networks)}): loaded")
        out.append("    into the browser and run locally after the user consents to contact the site.")
        for url in plan.external_networks:
            out.append(f"   • {url}")
    if plan.missing_includes:
        out.append("")
        out.append(f"ℹ️  Missing includes (non-fatal, {len(plan.missing_includes)}):")
        for msg in plan.missing_includes:
            out.append(f"   • {msg}")
    return "\n".join(out)
