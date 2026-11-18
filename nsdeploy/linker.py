"""Decentralized agent-network linker.

The linker has no catalog or shared state. It compares imports in local HOCONs with
exports from other local HOCONs or explicitly supplied peer-site manifests, then
writes an outbound-link sidecar owned by the calling network.
"""
from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from dataclasses import field
from http.client import HTTPResponse
from pathlib import Path
from typing import Any
from typing import Dict
from typing import Iterable
from typing import List
from typing import Optional
from typing import Set
from urllib.parse import ParseResult
from urllib.parse import urljoin
from urllib.parse import urlparse

from nsdeploy.resolve import BROWSER_OMITTED_TOOLS
from nsdeploy.resolve import DEMO_MODE_MARKER
from nsdeploy.resolve import expand_embedded_network_refs
from nsdeploy.resolve import resolve_hocon
from nsdeploy.studio import DEFAULT_REF
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio
from nsdeploy.studio import StudioSource


@dataclass
class NetworkDescription:  # pylint: disable=too-many-instance-attributes; plain record
    """
    Description of one agent network: its front man, aliases, dangling imports and where it is served.
    """

    network: str
    front_man: str
    aliases: List[str]
    imports: Dict[str, List[str]] = field(default_factory=dict)
    url: str = ""
    path: Optional[Path] = None
    site: str = ""
    links_endpoint: str = ""


def _is_url(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(("http://", "https://"))


def _configured_links(config: Dict[str, Any]) -> Dict[str, str]:
    result: Dict[str, str] = {}
    ref: Any
    value: Any
    for ref, value in (config.get("links", {}) or {}).items():
        url: Any = value if isinstance(value, str) else (value or {}).get("url")
        if isinstance(ref, str) and _is_url(url):
            result[ref] = url.rstrip("/")
    return result


def _named_tools(tools: List[Any]) -> Set[Any]:
    """
    Collect the names of the named tool entries.

    :param tools: The tool entries of a network configuration.
    :return: The set of tool names.
    """
    names: Set[Any] = set()
    tool: Any
    # Collect the name of every dict entry that has one.
    for tool in tools:
        if isinstance(tool, dict) and tool.get("name"):
            names.add(tool.get("name"))
    return names


def _llm_agents(tools: List[Any]) -> List[Dict[str, Any]]:
    """
    Collect the LLM agents: entries with instructions that are neither coded tools nor toolbox entries.

    :param tools: The tool entries of a network configuration.
    :return: The LLM agent entries, in configuration order.
    """
    agents: List[Dict[str, Any]] = []
    tool: Any
    # Keep the dict entries that have instructions and no class or toolbox.
    for tool in tools:
        if isinstance(tool, dict) and "instructions" in tool and "class" not in tool and "toolbox" not in tool:
            agents.append(tool)
    return agents


def _sorted_imports(imports: Dict[str, Set[str]]) -> Dict[str, List[str]]:
    """
    Sort the imports by reference and each caller list, dropping empty caller names.

    :param imports: The caller names by imported reference.
    :return: The sorted caller lists by reference, in reference order.
    """
    sorted_imports: Dict[str, List[str]] = {}
    import_ref: str
    import_callers: Set[str]
    # Build a sorted caller list for each reference, in reference order.
    for import_ref, import_callers in sorted(imports.items()):
        named_callers: List[str] = []
        caller: str
        # Keep only non-empty caller names.
        for caller in import_callers:
            if caller:
                named_callers.append(caller)
        sorted_imports[import_ref] = sorted(named_callers)
    return sorted_imports


# pylint: disable-next=too-many-locals
def describe_config(config: Dict[str, Any], network: str, path: Optional[Path] = None) -> NetworkDescription:
    """
    Describe a network from its parsed HOCON configuration.

    :param config: The parsed network configuration.
    :param network: The network name.
    :param path: The HOCON file the configuration came from, if local.
    :return: The network description.
    """
    tools: List[Any] = config.get("tools", []) or []
    names: Set[Any] = _named_tools(tools)
    agents: List[Dict[str, Any]] = _llm_agents(tools)
    front_man: str = agents[0].get("name", "") if agents else ""
    linked: Dict[str, str] = _configured_links(config)
    demo_leaves: Set[Any] = set()
    demo_agent: Dict[str, Any]
    # Collect the named demo-mode agents that call no tools.
    for demo_agent in agents:
        if (demo_agent.get("name")
                and DEMO_MODE_MARKER in (demo_agent.get("instructions") or "")
                and not (demo_agent.get("tools") or [])):
            demo_leaves.add(demo_agent.get("name"))
    imports: Dict[str, set[str]] = {}
    agent: Dict[str, Any]
    ref: Any
    for agent in agents:
        for ref in agent.get("tools", []) or []:
            if not isinstance(ref, str) or _is_url(ref) or ref in BROWSER_OMITTED_TOOLS:
                continue
            if ref in names and ref not in demo_leaves:
                continue
            if ref not in linked:
                imports.setdefault(ref, set()).add(agent.get("name", ""))

    meta: Dict[str, Any] = config.get("metadata", {}) or {}
    configured_aliases: Any = meta.get("link_aliases", []) or config.get("link_exports", []) or []
    if isinstance(configured_aliases, str):
        configured_aliases = [configured_aliases]
    aliases: List[str] = [network, front_man]
    item: Any
    for item in configured_aliases:
        alias: Any = item if isinstance(item, str) else (item or {}).get("alias") or (item or {}).get("name")
        if alias:
            aliases.append(alias)
    unique_aliases: Dict[str, None] = {}
    alias_name: str
    # Drop empty aliases and duplicates while keeping first-seen order.
    for alias_name in aliases:
        if alias_name:
            unique_aliases.setdefault(alias_name, None)
    return NetworkDescription(
        network=network,
        front_man=front_man,
        aliases=list(unique_aliases),
        imports=_sorted_imports(imports),
        path=path,
    )


def _fetch_json(url: str) -> Dict[str, Any]:
    request: urllib.request.Request = urllib.request.Request(url, headers={"Accept": "application/json",
                                                                           "User-Agent": "nsdeploy-linker/0.1"})
    response: HTTPResponse
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def describe_peer(site_url: str) -> List[NetworkDescription]:
    """Read a peer's decentralized manifest, with legacy manifest fallback."""
    parsed: ParseResult = urlparse(site_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"invalid peer URL: {site_url}")
    base: str = f"{parsed.scheme}://{parsed.netloc}/"
    try:
        linking: Dict[str, Any] = _fetch_json(urljoin(base, ".well-known/nsdeploy.json"))
    except (OSError, ValueError, urllib.error.HTTPError):
        manifest: Dict[str, Any] = _fetch_json(urljoin(base, "agent-manifest.json"))
        linking = manifest.get("linking") or {}
        if not linking:
            descriptions: List[NetworkDescription] = []
            entry: Dict[str, Any]
            for entry in manifest.get("networks", []) or []:
                name: str = entry.get("name", "")
                if name:
                    descriptions.append(NetworkDescription(name, name, [name], url=urljoin(base, name)))
            return descriptions

    pending_by_network: Dict[str, Dict[str, List[str]]] = {}
    item: Dict[str, Any]
    for item in linking.get("imports", []) or []:
        if item.get("status", "pending") != "pending":
            continue
        source_network: str = item.get("network", "")
        reference: str = item.get("reference", "")
        if source_network and reference:
            pending_by_network.setdefault(source_network, {})[reference] = item.get("callers", []) or []

    descriptions = []
    export: Dict[str, Any]
    for export in linking.get("exports", []) or []:
        network: str = export.get("network", "")
        if not network:
            continue
        target: Any = export.get("url") or urljoin(base, network)
        if not _is_url(target):
            target = urljoin(base, str(target))
        descriptions.append(NetworkDescription(
            network=network,
            front_man=export.get("front_man", ""),
            aliases=list(dict.fromkeys(export.get("aliases", []) or [network])),
            url=target.rstrip("/"),
            imports=pending_by_network.get(network, {}),
            site=(linking.get("site") or base).rstrip("/"),
            links_endpoint=("" if (linking.get("link_updates") or {}).get("mode") == "browser-local"
                            else linking.get("links_endpoint", "/_nsdeploy/links")),
        ))
    return descriptions


def update_peer_link(source: NetworkDescription, reference: str, target: str) -> None:
    """
    Ask a peer site to link one of its dangling references to a target URL.

    :param source: The peer network whose reference is linked.
    :param reference: The dangling reference name.
    :param target: The URL the reference links to.
    :raises OSError: If the peer is static or the update fails.
    """
    if not source.links_endpoint:
        raise OSError(
            f"peer site {source.site or source.network} is static; its links are "
            "browser-local and cannot be updated remotely"
        )
    endpoint: str = urljoin(source.site.rstrip("/") + "/", source.links_endpoint.lstrip("/"))
    body: bytes = json.dumps({
        "network": source.network,
        "reference": reference,
        "target": target,
    }).encode("utf-8")
    request: urllib.request.Request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "nsdeploy-linker/0.1"},
    )
    response: HTTPResponse
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status < 200 or response.status >= 300:
            raise OSError(f"peer link update returned HTTP {response.status}")


def sidecar_path(hocon_path: Path) -> Path:
    """
    Return the link sidecar file path for a HOCON file.

    :param hocon_path: The network HOCON path.
    :return: The sidecar path, with a ".links.json" suffix.
    """
    return hocon_path.with_suffix(".links.json")


def load_link_file(path: Path, network: str) -> Dict[str, str]:
    """
    Load a network's links from a link file.

    :param path: The link file path.
    :param network: The network whose links are read.
    :return: The links by reference name, or an empty dict when the file is missing.
    :raises ValueError: If the file cannot be read or parsed.
    """
    if not path.is_file():
        return {}
    try:
        doc: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"invalid link file {path}: {exc}") from exc
    values: Dict[str, Any]
    values = ((doc.get("networks") or {}).get(network) or {}) if "networks" in doc else (doc.get("links") or doc)
    links: Dict[str, str] = {}
    ref: Any
    url: Any
    # Keep string references bound to HTTP(S) URLs, without trailing slashes.
    for ref, url in values.items():
        if isinstance(ref, str) and _is_url(url):
            links[ref] = url.rstrip("/")
    return links


def write_link_file(path: Path, network: str, links: Dict[str, str]) -> None:
    """
    Write a network's links to a link file.

    :param path: The link file path.
    :param network: The network whose links are written.
    :param links: The links by reference name.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    doc: Dict[str, Any] = {"version": 1, "networks": {network: dict(sorted(links.items()))}}
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def load_deploy_links(hocon_path: Path, network: str, explicit_path: Optional[Path] = None,
                      inline: Optional[Iterable[str]] = None) -> Dict[str, str]:
    """
    Load a network's deploy-time links from its link file plus inline NAME=URL bindings.

    :param hocon_path: The network HOCON path, used to find the sidecar link file.
    :param network: The network name.
    :param explicit_path: An explicit link file path overriding the sidecar.
    :param inline: Inline NAME=URL bindings that override file links.
    :return: The links by reference name.
    :raises ValueError: If the link file or an inline binding is invalid.
    """
    path: Path = explicit_path or sidecar_path(hocon_path)
    links: Dict[str, str] = load_link_file(path, network) if path.is_file() else {}
    binding: str
    for binding in inline or []:
        ref: str
        url: str
        ref, url = parse_assignment(binding, "link")
        links[ref] = url.rstrip("/")
    return links


def parse_assignment(value: str, label: str) -> tuple[str, str]:
    """
    Parse a NAME=URL command-line assignment.

    :param value: The assignment text.
    :param label: The option name used in error messages.
    :return: The name and URL.
    :raises ValueError: If the assignment is not NAME=http(s)://...
    """
    if "=" not in value:
        raise ValueError(f"--{label} must be NAME=URL, got: {value}")
    name: str
    url: str
    name, url = value.split("=", 1)
    name, url = name.strip(), url.strip()
    if not name or not _is_url(url):
        raise ValueError(f"--{label} must be NAME=http(s)://..., got: {value}")
    return name, url


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _matches(reference: str, export: NetworkDescription) -> bool:
    wanted: str = _norm(reference)
    alias: str
    # Report whether any alias normalizes to the wanted reference.
    for alias in export.aliases:
        if _norm(alias) == wanted:
            return True
    return False


# pylint: disable-next=too-many-locals,too-many-branches,too-many-statements  # single CLI flow
def run_link_command(argv: Optional[List[str]] = None) -> int:
    """
    Run the "nsdeploy link" command.

    :param argv: The command-line arguments; defaults to sys.argv.
    :return: The process exit code.
    """
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        prog="nsdeploy link",
        description="Link dangling agent references to explicitly supplied HOCONs or peer sites.",
    )
    parser.add_argument("hocons", nargs="+", help="local network HOCONs to inspect")
    parser.add_argument("--peer", action="append", default=[], help="existing nsDeploy site URL (repeatable)")
    parser.add_argument("--site", action="append", default=[], metavar="NETWORK=URL",
                        help="deployment URL for a local HOCON network (repeatable)")
    parser.add_argument("--bind", action="append", default=[], metavar="[NETWORK.]REF=URL",
                        help="explicit outbound binding; NETWORK prefix is required with multiple HOCONs")
    parser.add_argument("--studio", default=None, help="local neuro-san-studio checkout")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub studio repo (default {DEFAULT_REPO})")
    parser.add_argument("--ref", default=DEFAULT_REF, help=f"Git ref (default {DEFAULT_REF})")
    parser.add_argument("--dry-run", action="store_true", help="show matches without writing sidecars")
    args: argparse.Namespace = parser.parse_args(argv)

    paths: List[Path] = []
    hocon: str
    # Resolve each HOCON argument to an absolute path.
    for hocon in args.hocons:
        paths.append(Path(hocon).resolve())
    missing: List[str] = []
    hocon_path: Path
    # Collect the HOCON paths that are not files.
    for hocon_path in paths:
        if not hocon_path.is_file():
            missing.append(str(hocon_path))
    if missing:
        parser.error("HOCON not found: " + ", ".join(missing))
    source: StudioSource = LocalStudio(args.studio) if args.studio else GithubStudio(args.repo, args.ref)

    local: List[NetworkDescription] = []
    path: Path
    for path in paths:
        config: Dict[str, Any]
        missing_includes: List[str]
        config, missing_includes = resolve_hocon(path, source)
        expand_embedded_network_refs(config, source, missing_includes)
        local.append(describe_config(config, path.stem, path))

    site_map: Dict[str, str] = {}
    value: str
    name: str
    url: str
    try:
        for value in args.site:
            name, url = parse_assignment(value, "site")
            site_map[name] = url.rstrip("/")
    except ValueError as exc:
        parser.error(str(exc))
    desc: NetworkDescription
    for desc in local:
        if desc.network in site_map:
            desc.site = site_map[desc.network]
            desc.url = f"{desc.site}/{desc.network}"

    exports: List[NetworkDescription] = list(local)
    peer_descriptions: List[NetworkDescription] = []
    peer: str
    for peer in args.peer:
        try:
            found: List[NetworkDescription] = describe_peer(peer)
            peer_descriptions.extend(found)
            exports.extend(found)
        # Any peer failure is reported and stops the command.
        except Exception as exc:  # pylint: disable=broad-exception-caught
            print(f"error: cannot inspect peer {peer}: {exc}")
            return 2

    explicit: Dict[str, Dict[str, str]] = {}
    local_desc: NetworkDescription
    # Start an empty explicit-binding map for each local network.
    for local_desc in local:
        explicit[local_desc.network] = {}
    key: str
    network: str
    ref: str
    dot: str
    try:
        for value in args.bind:
            key, url = parse_assignment(value, "bind")
            if len(local) == 1:
                network, ref = local[0].network, key
            else:
                network, dot, ref = key.partition(".")
                if not dot or network not in explicit:
                    raise ValueError("with multiple HOCONs, --bind must be NETWORK.REF=URL")
            explicit[network][ref] = url.rstrip("/")
    except ValueError as exc:
        parser.error(str(exc))

    changed: int = 0
    for desc in local:
        output: Path = sidecar_path(desc.path)
        links: Dict[str, str] = load_link_file(output, desc.network) if output.is_file() else {}
        links.update(explicit[desc.network])
        print(f"\n{desc.network}: {len(desc.imports)} pending reference(s)")
        callers: List[str]
        for ref, callers in desc.imports.items():
            if ref in links:
                print(f"  linked  {ref} -> {links[ref]}")
                continue
            candidates: List[NetworkDescription] = []
            local_export: NetworkDescription
            # Collect the other served networks whose aliases match the reference.
            for local_export in exports:
                if local_export.network != desc.network and local_export.url and _matches(ref, local_export):
                    candidates.append(local_export)
            if len(candidates) == 1:
                links[ref] = candidates[0].url
                changed += 1
                print(f"  linked  {ref} -> {candidates[0].url}")
            elif len(candidates) > 1:
                candidate_urls: List[str] = []
                candidate: NetworkDescription
                # Collect the URLs of the ambiguous candidates.
                for candidate in candidates:
                    candidate_urls.append(candidate.url)
                print(f"  pending {ref} (ambiguous: {', '.join(candidate_urls)})")
            else:
                owners: str = f"; called by {', '.join(callers)}" if callers else ""
                print(f"  pending {ref}{owners}")
        should_write: bool = bool(desc.imports or links or explicit[desc.network])
        if not should_write:
            print("  no outbound sidecar needed")
        elif args.dry_run:
            print(f"  would write {output}")
        else:
            write_link_file(output, desc.network, links)
            print(f"  wrote {output}")

    # Reconcile the opposite deployment order: an existing caller can advertise a
    # pending import while the newly supplied local HOCON provides the export.
    for desc in peer_descriptions:
        if not desc.imports:
            continue
        print(f"\n{desc.network} at {desc.site}: {len(desc.imports)} remote pending reference(s)")
        for ref in desc.imports:
            candidates = []
            peer_export: NetworkDescription
            # Collect the served networks on other sites whose aliases match the reference.
            for peer_export in exports:
                if (peer_export is not desc and peer_export.url and peer_export.site != desc.site
                        and _matches(ref, peer_export)):
                    candidates.append(peer_export)
            if len(candidates) == 1:
                if args.dry_run:
                    print(f"  would link {ref} -> {candidates[0].url}")
                else:
                    try:
                        update_peer_link(desc, ref, candidates[0].url)
                    # Any peer update failure is reported and the remaining references continue.
                    except Exception as exc:  # pylint: disable=broad-exception-caught
                        print(f"  error   {ref}: cannot update {desc.site}: {exc}")
                        continue
                    print(f"  linked  {ref} -> {candidates[0].url}")
                changed += 1
            elif len(candidates) > 1:
                peer_candidate_urls: List[str] = []
                peer_candidate: NetworkDescription
                # Collect the URLs of the ambiguous candidates.
                for peer_candidate in candidates:
                    peer_candidate_urls.append(peer_candidate.url)
                print(f"  pending {ref} (ambiguous: {', '.join(peer_candidate_urls)})")
            else:
                print(f"  pending {ref}")

    print(f"\nLinking complete: {changed} new binding(s); no registry used.")
    return 0
