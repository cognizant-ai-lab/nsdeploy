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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urljoin, urlparse

from nsdeploy.resolve import (
    BROWSER_OMITTED_TOOLS,
    DEMO_MODE_MARKER,
    expand_embedded_network_refs,
    resolve_hocon,
)
from nsdeploy.studio import DEFAULT_REF, DEFAULT_REPO, GithubStudio, LocalStudio, StudioSource


@dataclass
class NetworkDescription:
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
    for ref, value in (config.get("links", {}) or {}).items():
        url = value if isinstance(value, str) else (value or {}).get("url")
        if isinstance(ref, str) and _is_url(url):
            result[ref] = url.rstrip("/")
    return result


def describe_config(config: Dict[str, Any], network: str, path: Optional[Path] = None) -> NetworkDescription:
    tools = config.get("tools", []) or []
    names = {item.get("name") for item in tools if isinstance(item, dict) and item.get("name")}
    agents = [
        item for item in tools
        if isinstance(item, dict) and "instructions" in item and "class" not in item and "toolbox" not in item
    ]
    front_man = agents[0].get("name", "") if agents else ""
    linked = _configured_links(config)
    demo_leaves = {
        item.get("name") for item in agents
        if item.get("name")
        and DEMO_MODE_MARKER in (item.get("instructions") or "")
        and not (item.get("tools") or [])
    }
    imports: Dict[str, set[str]] = {}
    for agent in agents:
        for ref in agent.get("tools", []) or []:
            if not isinstance(ref, str) or _is_url(ref) or ref in BROWSER_OMITTED_TOOLS:
                continue
            if ref in names and ref not in demo_leaves:
                continue
            if ref not in linked:
                imports.setdefault(ref, set()).add(agent.get("name", ""))

    meta = config.get("metadata", {}) or {}
    configured_aliases = meta.get("link_aliases", []) or config.get("link_exports", []) or []
    if isinstance(configured_aliases, str):
        configured_aliases = [configured_aliases]
    aliases = [network, front_man]
    for item in configured_aliases:
        alias = item if isinstance(item, str) else (item or {}).get("alias") or (item or {}).get("name")
        if alias:
            aliases.append(alias)
    return NetworkDescription(
        network=network,
        front_man=front_man,
        aliases=list(dict.fromkeys(a for a in aliases if a)),
        imports={ref: sorted(c for c in callers if c) for ref, callers in sorted(imports.items())},
        path=path,
    )


def _fetch_json(url: str) -> Dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "nsdeploy-linker/0.1"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def describe_peer(site_url: str) -> List[NetworkDescription]:
    """Read a peer's decentralized manifest, with legacy manifest fallback."""
    parsed = urlparse(site_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"invalid peer URL: {site_url}")
    base = f"{parsed.scheme}://{parsed.netloc}/"
    try:
        linking = _fetch_json(urljoin(base, ".well-known/nsdeploy.json"))
    except (OSError, ValueError, urllib.error.HTTPError):
        manifest = _fetch_json(urljoin(base, "agent-manifest.json"))
        linking = manifest.get("linking") or {}
        if not linking:
            descriptions: List[NetworkDescription] = []
            for entry in manifest.get("networks", []) or []:
                name = entry.get("name", "")
                if name:
                    descriptions.append(NetworkDescription(name, name, [name], url=urljoin(base, name)))
            return descriptions

    pending_by_network: Dict[str, Dict[str, List[str]]] = {}
    for item in linking.get("imports", []) or []:
        if item.get("status", "pending") != "pending":
            continue
        source_network = item.get("network", "")
        reference = item.get("reference", "")
        if source_network and reference:
            pending_by_network.setdefault(source_network, {})[reference] = item.get("callers", []) or []

    descriptions = []
    for export in linking.get("exports", []) or []:
        network = export.get("network", "")
        if not network:
            continue
        target = export.get("url") or urljoin(base, network)
        if not _is_url(target):
            target = urljoin(base, str(target))
        descriptions.append(NetworkDescription(
            network=network,
            front_man=export.get("front_man", ""),
            aliases=list(dict.fromkeys(export.get("aliases", []) or [network])),
            url=target.rstrip("/"),
            imports=pending_by_network.get(network, {}),
            site=(linking.get("site") or base).rstrip("/"),
            links_endpoint=linking.get("links_endpoint", "/_nsdeploy/links"),
        ))
    return descriptions


def update_peer_link(source: NetworkDescription, reference: str, target: str) -> None:
    endpoint = urljoin(source.site.rstrip("/") + "/", source.links_endpoint.lstrip("/"))
    body = json.dumps({
        "network": source.network,
        "reference": reference,
        "target": target,
    }).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": "nsdeploy-linker/0.1"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status < 200 or response.status >= 300:
            raise OSError(f"peer link update returned HTTP {response.status}")


def sidecar_path(hocon_path: Path) -> Path:
    return hocon_path.with_suffix(".links.json")


def load_link_file(path: Path, network: str) -> Dict[str, str]:
    if not path.is_file():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"invalid link file {path}: {exc}") from exc
    values = ((doc.get("networks") or {}).get(network) or {}) if "networks" in doc else (doc.get("links") or doc)
    return {
        ref: url.rstrip("/") for ref, url in values.items()
        if isinstance(ref, str) and _is_url(url)
    }


def write_link_file(path: Path, network: str, links: Dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": 1, "networks": {network: dict(sorted(links.items()))}}
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def load_deploy_links(hocon_path: Path, network: str, explicit_path: Optional[Path] = None,
                      inline: Optional[Iterable[str]] = None) -> Dict[str, str]:
    path = explicit_path or sidecar_path(hocon_path)
    links = load_link_file(path, network) if path.is_file() else {}
    for binding in inline or []:
        ref, url = parse_assignment(binding, "link")
        links[ref] = url.rstrip("/")
    return links


def parse_assignment(value: str, label: str) -> tuple[str, str]:
    if "=" not in value:
        raise ValueError(f"--{label} must be NAME=URL, got: {value}")
    name, url = value.split("=", 1)
    name, url = name.strip(), url.strip()
    if not name or not _is_url(url):
        raise ValueError(f"--{label} must be NAME=http(s)://..., got: {value}")
    return name, url


def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _matches(reference: str, export: NetworkDescription) -> bool:
    wanted = _norm(reference)
    return any(_norm(alias) == wanted for alias in export.aliases)


def run_link_command(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
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
    args = parser.parse_args(argv)

    paths = [Path(value).resolve() for value in args.hocons]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        parser.error("HOCON not found: " + ", ".join(missing))
    source: StudioSource = LocalStudio(args.studio) if args.studio else GithubStudio(args.repo, args.ref)

    local: List[NetworkDescription] = []
    for path in paths:
        config, missing_includes = resolve_hocon(path, source)
        expand_embedded_network_refs(config, source, missing_includes)
        local.append(describe_config(config, path.stem, path))

    site_map: Dict[str, str] = {}
    try:
        for value in args.site:
            name, url = parse_assignment(value, "site")
            site_map[name] = url.rstrip("/")
    except ValueError as exc:
        parser.error(str(exc))
    for desc in local:
        if desc.network in site_map:
            desc.site = site_map[desc.network]
            desc.url = f"{desc.site}/{desc.network}"

    exports = list(local)
    peer_descriptions: List[NetworkDescription] = []
    for peer in args.peer:
        try:
            found = describe_peer(peer)
            peer_descriptions.extend(found)
            exports.extend(found)
        except Exception as exc:
            print(f"error: cannot inspect peer {peer}: {exc}")
            return 2

    explicit: Dict[str, Dict[str, str]] = {desc.network: {} for desc in local}
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

    changed = 0
    for desc in local:
        output = sidecar_path(desc.path)
        links = load_link_file(output, desc.network) if output.is_file() else {}
        links.update(explicit[desc.network])
        print(f"\n{desc.network}: {len(desc.imports)} pending reference(s)")
        for ref, callers in desc.imports.items():
            if ref in links:
                print(f"  linked  {ref} -> {links[ref]}")
                continue
            candidates = [item for item in exports if item.network != desc.network and item.url and _matches(ref, item)]
            if len(candidates) == 1:
                links[ref] = candidates[0].url
                changed += 1
                print(f"  linked  {ref} -> {candidates[0].url}")
            elif len(candidates) > 1:
                print(f"  pending {ref} (ambiguous: {', '.join(c.url for c in candidates)})")
            else:
                owners = f"; called by {', '.join(callers)}" if callers else ""
                print(f"  pending {ref}{owners}")
        should_write = bool(desc.imports or links or explicit[desc.network])
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
            candidates = [
                item for item in exports
                if item is not desc and item.url and item.site != desc.site and _matches(ref, item)
            ]
            if len(candidates) == 1:
                if args.dry_run:
                    print(f"  would link {ref} -> {candidates[0].url}")
                else:
                    try:
                        update_peer_link(desc, ref, candidates[0].url)
                    except Exception as exc:
                        print(f"  error   {ref}: cannot update {desc.site}: {exc}")
                        continue
                    print(f"  linked  {ref} -> {candidates[0].url}")
                changed += 1
            elif len(candidates) > 1:
                print(f"  pending {ref} (ambiguous: {', '.join(c.url for c in candidates)})")
            else:
                print(f"  pending {ref}")

    print(f"\nLinking complete: {changed} new binding(s); no registry used.")
    return 0
