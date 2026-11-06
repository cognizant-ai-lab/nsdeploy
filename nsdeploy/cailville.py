"""Cailville community integration and one-command demo workflow."""
from __future__ import annotations

import argparse
import copy
import http.client
import json
import math
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Dict
from typing import Iterable
from typing import List
from typing import Optional
from typing import Set
from typing import Tuple
from urllib.parse import ParseResult
from urllib.parse import urlparse

from nsdeploy.gateway import network_slug
from nsdeploy.gateway import public_origin
from nsdeploy.generate import write_private_steward_manifest
from nsdeploy.linker import write_link_file
from nsdeploy.resolve import resolve_hocon
from nsdeploy.studio import DEFAULT_REF
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio
from nsdeploy.studio import StudioSource


PROJECT_ROOT: Path = Path(__file__).resolve().parents[1]
DEFAULT_CAILVILLE_DIR: Path = PROJECT_ROOT / "cailville"
DATA_START: str = "<!-- CAILVILLE_DATA_START -->"
DATA_END: str = "<!-- CAILVILLE_DATA_END -->"
SITE_TYPES: Set[str] = {"citizen", "broker", "business", "civic"}
ICONS: Set[str] = {
    "badge-dollar-sign", "banknote", "briefcase-business", "building-2", "bus",
    "church", "compass", "factory", "fish", "handshake", "heart-handshake",
    "hospital", "hotel", "house", "landmark", "library", "school", "ship",
    "sprout", "store", "utensils", "warehouse", "wrench",
}


@dataclass
class CommunityDraft:
    """
    Proposed Cailville community update for one new or refreshed site, pending commit.
    """
    community: Dict[str, Any]
    augmented_config: Dict[str, Any]
    site: Dict[str, Any]
    connect_to: List[str]
    connect_from: List[str]
    cailville_dir: Path


def load_community(path: Path) -> Dict[str, Any]:
    """
    Load and minimally validate a Cailville community file.

    :param path: Path of the community JSON file.
    :return: The parsed community document.
    :raises ValueError: If the file is unreadable or lacks a "sites" list.
    """
    try:
        data: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read Cailville community file {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("sites"), list):
        raise ValueError(f"invalid Cailville community file: {path}")
    return data


def site_origin(site: Dict[str, Any], *, base_domain: Optional[str] = None,
                public_scheme: str = "http", public_port: Optional[int] = None) -> str:
    """
    Return the public origin of one Cailville site.

    :param site: The community site entry.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :return: The site origin URL.
    """
    if base_domain:
        return public_origin(site["id"], base_domain, scheme=public_scheme, port=public_port)
    return f"http://127.0.0.1:{site['port']}"


def public_site_directory(community: Dict[str, Any], *, base_domain: Optional[str] = None,
                          public_scheme: str = "http",
                          public_port: Optional[int] = None) -> Dict[str, str]:
    """Return every active Cailville public-site origin for private stewards."""
    return {
        site["id"]: site_origin(site, base_domain=base_domain,
                                public_scheme=public_scheme, public_port=public_port)
        for site in community.get("sites", [])
    }


def cailville_ports(cailville_dir: Path, project_dir: Optional[Path] = None) -> List[int]:
    """Return active ports plus ports from prior generated Cailville bundles."""
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    ports: List[int] = [int(site["port"]) for site in community["sites"]]
    if project_dir is not None:
        bundle_root: Path = project_dir / ".nsdeploy" / "cailville"
        manifest_path: Path
        for manifest_path in bundle_root.glob("*/agent-manifest.json"):
            try:
                manifest: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
                endpoint: str = (manifest.get("agent_mcp") or {}).get("endpoint", "")
                parsed: ParseResult = urlparse(endpoint)
                if parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port:
                    ports.append(parsed.port)
            except (OSError, ValueError, TypeError):
                continue
    return list(dict.fromkeys(ports))


def latest_download_hocon(downloads: Optional[Path] = None) -> Path:
    """
    Return the most recently modified .hocon file in the downloads directory.

    :param downloads: Directory to search; defaults to ~/Downloads.
    :return: Resolved path of the newest .hocon file.
    :raises ValueError: If the directory holds no .hocon files.
    """
    root: Path = (downloads or (Path.home() / "Downloads")).expanduser()
    candidates: List[Path] = [path for path in root.glob("*.hocon") if path.is_file()]
    if not candidates:
        raise ValueError(f"no .hocon files found in {root}")
    return max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name)).resolve()


def allocate_port(community: Dict[str, Any], preferred: Optional[int] = None) -> int:
    """
    Pick a demo port that no Cailville site uses yet.

    :param community: The community document.
    :param preferred: Port to use if it is free.
    :return: The selected port.
    :raises ValueError: If the preferred port is taken or no port in 8088-8999 is free.
    """
    used: Set[int] = {int(site["port"]) for site in community.get("sites", []) if site.get("port")}
    if preferred is not None:
        if preferred in used:
            raise ValueError(f"port {preferred} is already assigned in Cailville")
        return preferred
    port: int
    for port in range(8088, 9000):
        if port not in used:
            return port
    raise ValueError("no free Cailville demo port is available")


def _clean(value: Any, limit: int) -> str:
    text: str = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    shortened: str = text[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return shortened or text[:limit]


def _brandize(value: str) -> str:
    return re.sub(r"[_-]+", " ", value).strip().title()


def _identity(config: Dict[str, Any], network: str) -> Dict[str, Any]:
    agents: List[Dict[str, Any]] = [
        item for item in (config.get("tools", []) or [])
        if isinstance(item, dict) and "instructions" in item
        and "class" not in item and "toolbox" not in item
    ]
    front: Dict[str, Any] = agents[0] if agents else {}
    meta: Dict[str, Any] = config.get("metadata", {}) or {}
    description: Any = ((front.get("function") or {}).get("description")
                        or meta.get("description") or front.get("instructions") or network)
    return {
        "network": network,
        "description": _clean(description, 900),
        "sample_queries": [_clean(item, 240) for item in (meta.get("sample_queries") or [])[:4]],
        "agents": [
            {
                "name": item.get("name", ""),
                "role": _clean((item.get("function") or {}).get("description") or item.get("instructions"), 180),
            }
            for item in agents[:12]
        ],
    }


def _tokens(value: str) -> set[str]:
    stop: Set[str] = {
        "about", "agent", "and", "assistant", "cailville", "for", "from", "into",
        "local", "network", "of", "or", "site", "the", "their", "this", "to", "with",
    }
    return {word for word in re.findall(r"[a-z0-9]+", value.lower()) if len(word) > 2 and word not in stop}


# pylint: disable-next=too-many-branches  # flat keyword rule table
def heuristic_profile(identity: Dict[str, Any], peers: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Infer a site profile and its connections from keywords, without a model.

    :param identity: Network identity from _identity().
    :param peers: Existing community sites.
    :return: Profile with name, description, kind, type, icon, connect_to and connect_from.
    """
    text: str = " ".join([
        identity["network"], identity["description"],
        " ".join(item.get("name", "") + " " + item.get("role", "") for item in identity["agents"]),
        " ".join(identity["sample_queries"]),
    ]).lower()
    words: Set[str] = _tokens(text)

    site_type: str
    icon: str
    kind: str
    if any(term in text for term in ("family", "household", "personal presence", "individual")):
        site_type, icon, kind = "citizen", "house", "Citizen site"
    elif any(term in text for term in ("government", "municipal", "public agency", "permit", "civic")):
        site_type, icon, kind = "civic", "landmark", "Civic service"
    elif any(term in text for term in ("marketplace", "exchange", "broker", "directory", "concierge")):
        site_type, icon, kind = "broker", "handshake", "Community broker"
    elif any(term in text for term in ("bank", "banking", "credit union", "finance", "loan")):
        site_type, icon, kind = "business", "landmark", "Community banking"
    elif any(term in text for term in ("restaurant", "catering", "food", "dining")):
        site_type, icon, kind = "business", "utensils", "Food & dining"
    elif any(term in text for term in ("hotel", "lodging", "inn", "hospitality")):
        site_type, icon, kind = "business", "hotel", "Hospitality"
    elif any(term in text for term in ("transport", "delivery", "shuttle", "vehicle")):
        site_type, icon, kind = "business", "bus", "Transportation"
    else:
        site_type, icon, kind = "business", "building-2", "Local organization"

    scored: List[tuple[int, str, Dict[str, Any]]] = []
    peer: Dict[str, Any]
    for peer in peers:
        peer_text: str = " ".join((peer.get("id", ""), peer.get("name", ""),
                                   peer.get("description", ""), peer.get("kind", ""))).lower()
        score: int = len(words & _tokens(peer_text)) * 4
        peer_id: str = peer["id"]
        if peer_id == "main_street_exchange" and site_type in {"business", "broker"}:
            score += 10
        if peer_id == "neighbor_exchange" and any(
                term in text for term in ("community", "family", "household", "bank", "resident", "citizen")):
            score += 9
        if peer_id == "harbor_town_hall":
            score += 5
        if peer_id == "harbor_guide" and any(
                term in text for term in ("visitor", "travel", "event", "hotel", "restaurant", "tour")):
            score += 9
        if peer_id == "fix_and_found" and any(
                term in text for term in ("repair", "reuse", "equipment", "maintenance")):
            score += 8
        if peer_id == "harbor_wheels_cooperative" and any(
                term in text for term in ("transport", "delivery", "event", "travel")):
            score += 7
        scored.append((score, peer_id, peer))
    scored.sort(key=lambda item: (-item[0], item[1]))
    useful: List[str] = [peer_id for score, peer_id, _ in scored if score > 0][:4]
    if len(useful) < 2:
        useful.extend(peer_id for _, peer_id, _ in scored if peer_id not in useful)
        useful = useful[:3]
    peer_by_id: Dict[str, Dict[str, Any]] = {peer["id"]: peer for _, _, peer in scored}
    inbound: List[str] = [
        peer_id for peer_id in useful
        if peer_by_id[peer_id].get("type") in {"broker", "civic"}
    ][:3]
    return {
        "name": _brandize(identity["network"]),
        "description": _clean(identity["description"], 160),
        "kind": kind,
        "type": site_type,
        "icon": icon,
        "connect_to": useful,
        "connect_from": inbound,
    }


def _extract_json(text: str) -> Dict[str, Any]:
    cleaned: str = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
    start: int
    end: int
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if 0 <= start < end:
        cleaned = cleaned[start:end + 1]
    value: Any = json.loads(cleaned)
    if not isinstance(value, dict):
        raise ValueError("connection model did not return an object")
    return value


def _model_profile(identity: Dict[str, Any], peers: List[Dict[str, Any]], *,
                   model: str, api_key: str, upstream: str) -> Dict[str, Any]:
    peer_facts: List[Dict[str, Any]] = [
        {key: peer.get(key) for key in ("id", "name", "description", "kind", "type")}
        for peer in peers
    ]
    system: str = (
        "You place a newly deployed public agent-network site into the fictional coastal town Cailville. "
        "Return only JSON. Choose real collaboration edges that are useful for the new organization; do not connect "
        "everything. connect_to means the new public network may call an existing public network. connect_from means "
        "an existing public network may call the new one. Choose 2-5 connect_to IDs and 0-3 connect_from IDs. "
        "Only use supplied IDs. Return: name, description (<=160 chars), kind (<=24 chars), type "
        "(citizen|broker|business|civic), icon, connect_to, connect_from. Icon must be one of: "
        + ", ".join(sorted(ICONS)) + "."
    )
    payload: Dict[str, Any] = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps({"new_site": identity, "existing_sites": peer_facts})},
        ],
    }
    if not re.match(r"^gpt-5(?:[.-]|$)", model, flags=re.I):
        payload["temperature"] = 0.2
    request: urllib.request.Request = urllib.request.Request(
        f"{upstream.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    response: http.client.HTTPResponse
    with urllib.request.urlopen(request, timeout=180) as response:
        body: Dict[str, Any] = json.loads(response.read().decode("utf-8"))
    return _extract_json(body["choices"][0]["message"]["content"])


# pylint: disable-next=too-many-arguments,too-many-locals  # keyword-only model settings
def infer_profile(identity: Dict[str, Any], peers: List[Dict[str, Any]], *, model: str,
                  api_key: str = "", upstream: str = "https://api.openai.com/v1",
                  use_model: bool = True) -> Dict[str, Any]:
    """
    Infer a site profile, preferring a model proposal and falling back to heuristics.

    :param identity: Network identity from _identity().
    :param peers: Existing community sites.
    :param model: Chat model that proposes connections.
    :param api_key: API key for the model; local inference is used when empty.
    :param upstream: OpenAI-compatible endpoint for the model.
    :param use_model: Whether to ask the model at all.
    :return: Profile with name, description, kind, type, icon, connect_to and connect_from.
    """
    fallback: Dict[str, Any] = heuristic_profile(identity, peers)
    proposed: Dict[str, Any] = {}
    model_succeeded: bool = False
    if use_model and api_key:
        try:
            proposed = _model_profile(identity, peers, model=model, api_key=api_key, upstream=upstream)
            model_succeeded = True
            print(f"   Cailville connections proposed via {model}")
        # pylint: disable-next=broad-exception-caught  # any model failure falls back to local inference
        except Exception as exc:
            print(f"   Cailville connection model failed ({str(exc)[:100]}); using local inference")
    else:
        print("   Cailville connections: using local inference" + (" (no API key)" if use_model else ""))

    peer_ids: Set[str] = {peer["id"] for peer in peers}
    site_type: Any = proposed.get("type") if proposed.get("type") in SITE_TYPES else fallback["type"]
    icon: Any = proposed.get("icon") if proposed.get("icon") in ICONS else fallback["icon"]
    proposed_to: Any = proposed.get("connect_to", [])
    proposed_from: Any = proposed.get("connect_from", [])
    connect_to: List[str] = [item for item in proposed_to if item in peer_ids] if isinstance(proposed_to, list) else []
    connect_from: List[str]
    connect_from = [item for item in proposed_from if item in peer_ids] if isinstance(proposed_from, list) else []
    if not connect_to:
        connect_to = fallback["connect_to"]
    if not model_succeeded or "connect_from" not in proposed:
        connect_from = fallback["connect_from"]
    return {
        "name": _clean(proposed.get("name") or fallback["name"], 60),
        "description": _clean(proposed.get("description") or fallback["description"], 160),
        "kind": _clean(proposed.get("kind") or fallback["kind"], 24),
        "type": site_type,
        "icon": icon,
        "connect_to": list(dict.fromkeys(connect_to))[:5],
        "connect_from": list(dict.fromkeys(connect_from))[:3],
    }


def choose_position(sites: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Choose the free map position farthest from existing sites.

    :param sites: Existing community sites.
    :return: Position with x, y, mx and my_px keys.
    """
    occupied: List[Dict[str, Any]] = [site.get("position", {}) for site in sites]
    candidates: List[Tuple[int, int]] = [
        (x, y) for y in (13, 24, 35, 46, 57, 68, 79, 88)
        for x in (13, 22, 31, 40, 49, 58, 67, 76, 85, 91)
        if not (y < 22 and 35 < x < 69)
    ]

    def clearance(point: tuple[int, int]) -> float:
        if not occupied:
            return 999.0
        return min(math.hypot(point[0] - float(pos.get("x", 50)),
                              (point[1] - float(pos.get("y", 50))) * 1.35)
                   for pos in occupied)

    x: int
    y: int
    x, y = max(candidates, key=lambda point: (clearance(point), -point[1], -point[0]))
    addition_index: int = sum(1 for site in sites if not site.get("base", False))
    return {
        "x": x,
        "y": y,
        "mx": 25 if addition_index % 2 == 0 else 73,
        "my_px": max(1390 + addition_index * 110,
                     max((pos.get("my_px", 0) for pos in occupied), default=0) + 110),
    }


# pylint: disable-next=too-many-arguments  # keyword-only URL settings
def augment_config(config: Dict[str, Any], network: str,
                   community: Dict[str, Any], *, base_domain: Optional[str] = None,
                   public_scheme: str = "http",
                   public_port: Optional[int] = None) -> Dict[str, Any]:
    """
    Add the network's outbound Cailville relationships as front-man tools and links.

    :param config: The network config.
    :param network: The network ID.
    :param community: The community document.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :return: A copy of the config with the links added.
    """
    result: Dict[str, Any] = copy.deepcopy(config)
    sites: Dict[str, Dict[str, Any]] = {site["id"]: site for site in community.get("sites", [])}
    targets: List[str] = [target for source, target in community.get("relationships", [])
                          if source == network and target in sites]
    agents: List[Dict[str, Any]] = [
        item for item in (result.get("tools", []) or [])
        if isinstance(item, dict) and "instructions" in item
        and "class" not in item and "toolbox" not in item
    ]
    if not agents or not targets:
        return result
    front: Dict[str, Any] = agents[0]
    tools: List[str] = list(front.get("tools", []) or [])
    links: Dict[str, str] = dict(result.get("links", {}) or {})
    target: str
    for target in targets:
        if target not in tools:
            tools.append(target)
        origin: str = site_origin(sites[target], base_domain=base_domain,
                                  public_scheme=public_scheme, public_port=public_port)
        links[target] = f"{origin}/{target}"
    front["tools"] = tools
    result["links"] = links
    return result


# pylint: disable-next=too-many-arguments,too-many-locals  # keyword-only CLI settings
def plan_addition(config: Dict[str, Any], hocon_path: Path, *, port: Optional[int],
                  site_dir: Path, cailville_dir: Optional[Path] = None,
                  base_map: bool = False, model: str = "gpt-5.5", api_key: str = "",
                  upstream: str = "https://api.openai.com/v1", use_model: bool = True,
                  studio: Optional[str] = None, repo: str = DEFAULT_REPO,
                  ref: str = DEFAULT_REF) -> CommunityDraft:
    """
    Plan how a network joins Cailville without writing anything.

    :param config: The resolved network config.
    :param hocon_path: Path of the network HOCON; its stem is the network ID.
    :param port: Requested site port, or None to reuse or allocate one.
    :param site_dir: Editable site source directory.
    :param cailville_dir: Cailville directory; defaults to the bundled one.
    :param base_map: Whether to start from the base map, discarding earlier additions.
    :param model: Chat model that proposes connections.
    :param api_key: API key for the model.
    :param upstream: OpenAI-compatible endpoint for the model.
    :param use_model: Whether to ask the model at all.
    :param studio: Local studio checkout, if any.
    :param repo: GitHub studio repo.
    :param ref: Git ref of the studio repo.
    :return: The draft community update.
    :raises ValueError: If the community file is invalid or the port is unavailable.
    """
    cailville_dir = (cailville_dir or DEFAULT_CAILVILLE_DIR).resolve()
    source_path: Path = cailville_dir / ("community.base.json" if base_map else "community.json")
    if not source_path.is_file():
        source_path = cailville_dir / "community.base.json"
    community: Dict[str, Any] = copy.deepcopy(load_community(source_path))
    network: str = hocon_path.stem
    existing: Optional[Dict[str, Any]] = next((site for site in community["sites"] if site["id"] == network), None)
    peers: List[Dict[str, Any]] = [site for site in community["sites"] if site["id"] != network]
    identity: Dict[str, Any] = _identity(config, network)
    profile: Dict[str, Any] = infer_profile(identity, peers, model=model, api_key=api_key,
                                            upstream=upstream, use_model=use_model)
    if existing and port is None:
        selected_port: int = int(existing["port"])
    else:
        port_community: Dict[str, Any] = {**community, "sites": peers}
        selected_port = allocate_port(port_community, port)
    position: Optional[Dict[str, Any]] = copy.deepcopy(existing.get("position")) if existing else choose_position(peers)
    site: Dict[str, Any] = {
        "id": network,
        "name": profile["name"],
        "description": profile["description"],
        "kind": profile["kind"],
        "type": profile["type"],
        "icon": profile["icon"],
        "port": selected_port,
        "hocon": str(hocon_path.resolve()),
        "site_dir": str(site_dir.resolve()),
        "base": bool(existing and existing.get("base")),
        "position": position,
    }
    if studio:
        site["studio"] = str(Path(studio).resolve())
    elif repo != DEFAULT_REPO or ref != DEFAULT_REF:
        site.update({"repo": repo, "ref": ref})

    community["sites"] = peers + [site]
    edges: Set[Tuple[str, str]] = {
        (source, target) for source, target in community.get("relationships", [])
        if network not in (source, target)
    }
    edges.update((network, target) for target in profile["connect_to"])
    edges.update((source, network) for source in profile["connect_from"])
    order: Dict[str, int] = {item["id"]: index for index, item in enumerate(community["sites"])}
    community["relationships"] = [
        list(edge) for edge in sorted(edges, key=lambda edge: (order.get(edge[0], 999), order.get(edge[1], 999)))
    ]
    augmented: Dict[str, Any] = augment_config(config, network, community)
    return CommunityDraft(community, augmented, site, profile["connect_to"],
                          profile["connect_from"], cailville_dir)


def _map_payload(community: Dict[str, Any], *, base_domain: Optional[str] = None,
                 public_scheme: str = "http",
                 public_port: Optional[int] = None) -> Dict[str, Any]:
    sites: List[Dict[str, Any]] = []
    item: Dict[str, Any]
    for item in community.get("sites", []):
        site: Dict[str, Any] = {key: item[key] for key in (
            "id", "name", "description", "kind", "type", "icon", "port", "position", "base"
        )}
        site["url"] = site_origin(item, base_domain=base_domain,
                                  public_scheme=public_scheme, public_port=public_port)
        sites.append(site)
    return {"version": 1, "sites": sites, "relationships": community.get("relationships", [])}


def render_map_html(html_path: Path, community: Dict[str, Any], *,
                    base_domain: Optional[str] = None, public_scheme: str = "http",
                    public_port: Optional[int] = None) -> None:
    """
    Replace the embedded community data in the Cailville map HTML.

    :param html_path: Path of the map HTML file.
    :param community: The community document.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :raises ValueError: If the data markers are missing or cannot be replaced.
    """
    text: str = html_path.read_text(encoding="utf-8")
    if DATA_START not in text or DATA_END not in text:
        raise ValueError(f"Cailville data markers are missing from {html_path}")
    raw: str = json.dumps(
        _map_payload(community, base_domain=base_domain, public_scheme=public_scheme,
                     public_port=public_port),
        indent=2, ensure_ascii=False,
    ).replace("<", "\\u003c")
    replacement: str = (f'{DATA_START}\n  <script id="cailville-community-data" type="application/json">\n'
                        f'{raw}\n  </script>\n  {DATA_END}')
    pattern: re.Pattern[str] = re.compile(re.escape(DATA_START) + ".*?" + re.escape(DATA_END), re.S)
    updated: str
    count: int
    updated, count = pattern.subn(replacement, text, count=1)
    if count != 1:
        raise ValueError(f"could not update Cailville data in {html_path}")
    temp: Path = html_path.with_name(f".{html_path.name}.tmp")
    temp.write_text(updated, encoding="utf-8")
    temp.replace(html_path)


def commit_addition(draft: CommunityDraft) -> None:
    """
    Write the drafted community file and refresh the map HTML.

    :param draft: The planned community update.
    """
    output: Path = draft.cailville_dir / "community.json"
    temp: Path = output.with_name(f".{output.name}.tmp")
    temp.write_text(json.dumps(draft.community, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(output)
    render_map_html(draft.cailville_dir / "cailville.html", draft.community)
    print(f"✅ Added {draft.site['name']} to Cailville on port {draft.site['port']}")
    print("   calls → " + ", ".join(draft.connect_to))
    print("   called by ← " + (", ".join(draft.connect_from) or "none"))


def reset_map(cailville_dir: Path = DEFAULT_CAILVILLE_DIR) -> None:
    """
    Restore community.json and the map HTML from the base community file.

    :param cailville_dir: Cailville directory.
    """
    cailville_dir = cailville_dir.resolve()
    community: Dict[str, Any] = load_community(cailville_dir / "community.base.json")
    output: Path = cailville_dir / "community.json"
    output.write_text(json.dumps(community, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    render_map_html(cailville_dir / "cailville.html", community)
    print(f"✅ Restored the base Cailville map ({len(community['sites'])} sites)")


def _member_path(cailville_dir: Path, value: str) -> Path:
    path: Path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (cailville_dir / path).resolve()


# pylint: disable-next=too-many-locals
def prepare_runtime_sources(cailville_dir: Path, project_dir: Path, *,
                            base_domain: Optional[str] = None,
                            public_scheme: str = "http",
                            public_port: Optional[int] = None) -> Dict[str, Path]:
    """
    Write link-augmented configs for added sites and the sites that call them.

    :param cailville_dir: Directory holding community.json.
    :param project_dir: Project root that holds the .nsdeploy output tree.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :return: Map of site ID to its written config path.
    """
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    sites: Dict[str, Dict[str, Any]] = {site["id"]: site for site in community["sites"]}
    added: Set[str] = {site_id for site_id, site in sites.items() if not site.get("base", False)}
    derived: Set[str] = set(added)
    derived.update(source for source, target in community.get("relationships", []) if target in added)
    output_dir: Path = project_dir / ".nsdeploy" / "cailville" / "community-sources"
    output_dir.mkdir(parents=True, exist_ok=True)
    result: Dict[str, Path] = {}
    site_id: str
    for site_id in sorted(derived):
        site: Dict[str, Any] = sites[site_id]
        hocon: Path = _member_path(cailville_dir, site["hocon"])
        source: StudioSource
        if site.get("studio"):
            source = LocalStudio(site["studio"])
        else:
            source = GithubStudio(site.get("repo", DEFAULT_REPO), site.get("ref", DEFAULT_REF))
        config: Dict[str, Any]
        config, _ = resolve_hocon(hocon, source)
        config = augment_config(config, site_id, community, base_domain=base_domain,
                                public_scheme=public_scheme, public_port=public_port)
        destination: Path = output_dir / f"{site_id}.hocon"
        destination.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        result[site_id] = destination
    return result


def write_steward_sites_file(cailville_dir: Path, project_dir: Path, *,
                             base_domain: Optional[str] = None,
                             public_scheme: str = "http",
                             public_port: Optional[int] = None) -> Path:
    """
    Write the public-site directory that private stewards read.

    :param cailville_dir: Directory holding community.json.
    :param project_dir: Project root that holds the .nsdeploy output tree.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :return: Path of the written file.
    """
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    destination: Path = project_dir / ".nsdeploy" / "cailville" / "community-public-sites.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(public_site_directory(
            community, base_domain=base_domain, public_scheme=public_scheme,
            public_port=public_port,
        ), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return destination


def write_active_private_manifest(cailville_dir: Path, project_dir: Path) -> Path:
    """
    Write the private steward manifest listing every active Cailville network.

    :param cailville_dir: Directory holding community.json.
    :param project_dir: Project root that holds the .nsdeploy output tree.
    :return: Path of the written manifest.
    :raises ValueError: If community.json is missing or malformed.
    """
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    active: List[str] = [site["id"] for site in community["sites"]]
    return write_private_steward_manifest(
        project_dir / ".nsdeploy" / "cailville", active_networks=active
    )


def write_runtime_link_files(cailville_dir: Path, project_dir: Path, *,
                             base_domain: str, public_scheme: str = "http",
                             public_port: Optional[int] = None) -> Dict[str, Path]:
    """Write subdomain-aware sidecars without changing checked-in port sidecars."""
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    sites: Dict[str, Dict[str, Any]] = {site["id"]: site for site in community["sites"]}
    targets: Dict[str, List[str]] = {site_id: [] for site_id in sites}
    source: str
    target: str
    for source, target in community.get("relationships", []):
        if source in sites and target in sites:
            targets[source].append(target)
    output_dir: Path = project_dir / ".nsdeploy" / "cailville" / "community-links"
    result: Dict[str, Path] = {}
    linked: List[str]
    for source, linked in targets.items():
        links: Dict[str, str] = {
            target: (
                site_origin(sites[target], base_domain=base_domain,
                            public_scheme=public_scheme, public_port=public_port)
                + f"/{target}"
            )
            for target in linked
        }
        path: Path = output_dir / f"{source}.links.json"
        write_link_file(path, source, links)
        result[source] = path
    return result


# pylint: disable-next=too-many-locals
def emit_launch_rows(cailville_dir: Path, project_dir: Path, *,
                     base_domain: Optional[str] = None,
                     public_scheme: str = "http",
                     public_port: Optional[int] = None) -> None:
    """
    Prepare runtime files and print one tab-separated launch row per Cailville site.

    :param cailville_dir: Directory holding community.json.
    :param project_dir: Project root that holds the .nsdeploy output tree.
    :param base_domain: Base domain for subdomain URLs; loopback port URLs when omitted.
    :param public_scheme: URL scheme for subdomain URLs.
    :param public_port: Optional public port for subdomain URLs.
    :raises ValueError: If network names map to duplicate subdomains.
    """
    community: Dict[str, Any] = load_community(cailville_dir / "community.json")
    runtime_sources: Dict[str, Path] = prepare_runtime_sources(
        cailville_dir, project_dir, base_domain=base_domain,
        public_scheme=public_scheme, public_port=public_port,
    )
    write_steward_sites_file(
        cailville_dir, project_dir, base_domain=base_domain,
        public_scheme=public_scheme, public_port=public_port,
    )
    runtime_links: Dict[str, Path] = (
        write_runtime_link_files(
            cailville_dir, project_dir, base_domain=base_domain,
            public_scheme=public_scheme, public_port=public_port,
        )
        if base_domain else {}
    )
    if base_domain:
        slugs: List[str] = [network_slug(site["id"]) for site in community["sites"]]
        if len(slugs) != len(set(slugs)):
            raise ValueError("Cailville network names produce duplicate subdomains")
    # Regenerate for both modes so returning to the default port launcher restores
    # port URLs after a prior subdomain run.
    render_map_html(
        cailville_dir / "cailville.html", community, base_domain=base_domain,
        public_scheme=public_scheme, public_port=public_port,
    )
    site: Dict[str, Any]
    for site in community["sites"]:
        site_id: str = site["id"]
        hocon: Path = runtime_sources.get(site_id) or _member_path(cailville_dir, site["hocon"])
        site_dir: Path = _member_path(cailville_dir, site["site_dir"])
        studio: str = site.get("studio") or "-"
        links: Optional[Path] = runtime_links.get(site_id)
        origin: str = site_origin(site, base_domain=base_domain, public_scheme=public_scheme,
                                  public_port=public_port)
        print("\t".join((site_id, str(site["port"]), str(hocon), str(site_dir),
                         str(studio), str(links) if links else "-", origin)))


# pylint: disable-next=too-many-branches,too-many-statements  # flat CLI option handling
def run_cailville_command(argv: Optional[List[str]] = None) -> int:
    """
    Generate a site, add it to Cailville and optionally launch the whole demo.

    :param argv: Command-line arguments; defaults to sys.argv.
    :return: Process exit status.
    """
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        prog="nsdeploy cailville",
        description="Generate a public site, connect it into Cailville, and launch the complete demo.",
    )
    parser.add_argument("hocon", nargs="?", help="network HOCON (default: newest ~/Downloads/*.hocon)")
    parser.add_argument("--port", type=int, default=None,
                        help="site port (default: next Cailville port, starting at 8088)")
    parser.add_argument("--base-map", action="store_true",
                        help="discard earlier demo additions before adding this site")
    parser.add_argument("--reset-map", action="store_true", help="restore the original 13-site map and exit")
    parser.add_argument("--no-launch", action="store_true",
                        help="generate and integrate the site without launching Cailville")
    parser.add_argument("--no-theme", action="store_true", help="skip LLM site design")
    parser.add_argument("--no-theme-refresh", action="store_true", help="reuse an existing editable site theme")
    parser.add_argument("--theme-model", default="gpt-5.5", help="site-design and connection model (default gpt-5.5)")
    parser.add_argument("--theme-upstream", default=None, help="OpenAI-compatible endpoint for design and connections")
    parser.add_argument("--theme-key", default=None, help="API key (else $OPENAI_API_KEY)")
    parser.add_argument("--theme-prompt", default=None,
                        help="additional design instructions (refreshes the theme unless --no-theme-refresh)")
    parser.add_argument("--no-ai-connections", action="store_true", help="use deterministic local connection inference")
    parser.add_argument("--upstream", default="https://api.openai.com/v1", help="runtime BYOK upstream")
    parser.add_argument("--studio", default=None, help="local neuro-san-studio checkout")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub studio repo (default {DEFAULT_REPO})")
    parser.add_argument("--ref", default=DEFAULT_REF, help=f"Git ref (default {DEFAULT_REF})")
    parser.add_argument("--site-dir", default=None, help="editable source directory for the new public site")
    parser.add_argument("--cailville-dir", default=str(DEFAULT_CAILVILLE_DIR), help=argparse.SUPPRESS)
    args: argparse.Namespace = parser.parse_args(argv)
    cailville_dir: Path = Path(args.cailville_dir).resolve()
    if args.reset_map:
        reset_map(cailville_dir)
        return 0
    try:
        hocon: Path = Path(args.hocon).expanduser().resolve() if args.hocon else latest_download_hocon()
        if not hocon.is_file():
            raise ValueError(f"HOCON not found: {hocon}")
        current_path: Path = cailville_dir / ("community.base.json" if args.base_map else "community.json")
        community: Dict[str, Any]
        community = load_community(current_path if current_path.is_file() else cailville_dir / "community.base.json")
        existing: Optional[Dict[str, Any]]
        existing = next((site for site in community["sites"] if site["id"] == hocon.stem), None)
        port: int
        port = args.port if args.port is not None else (int(existing["port"]) if existing else allocate_port(community))
    except ValueError as exc:
        parser.error(str(exc))

    if not args.hocon:
        print(f"▶ Using newest Downloads HOCON: {hocon}")
    project_dir: Path = cailville_dir.parent
    site_dir: Path
    site_dir = Path(args.site_dir).expanduser().resolve() if args.site_dir else hocon.parent / "sites" / hocon.stem
    out_dir: Path = project_dir / ".nsdeploy" / "cailville" / hocon.stem
    command: List[str] = [
        sys.executable, "-m", "nsdeploy", str(hocon),
        "--port", str(port), "--out", str(out_dir), "--site-dir", str(site_dir),
        "--upstream", args.upstream, "--add-to-cailville", "--no-serve",
        "--cailville-dir", str(cailville_dir), "--theme-model", args.theme_model,
    ]
    if args.base_map:
        command.append("--cailville-base-map")
    if args.no_ai_connections:
        command.append("--cailville-no-ai-connections")
    if args.studio:
        command.extend(("--studio", args.studio))
    else:
        command.extend(("--repo", args.repo, "--ref", args.ref))
    if not args.no_theme:
        command.append("--theme")
        if not args.no_theme_refresh:
            command.append("--theme-refresh")
    if args.theme_upstream:
        command.extend(("--theme-upstream", args.theme_upstream))
    if args.theme_key:
        command.extend(("--theme-key", args.theme_key))
    if args.theme_prompt:
        command.extend(("--theme-prompt", args.theme_prompt))
    result: subprocess.CompletedProcess[bytes] = subprocess.run(command, cwd=project_dir, check=False)
    if result.returncode:
        return result.returncode
    if args.no_launch:
        print(f"\nPrepared Cailville. Launch later with {cailville_dir / 'launch_all.sh'}")
        return 0
    return subprocess.call([str(cailville_dir / "launch_all.sh")], cwd=project_dir,
                           env=os.environ.copy())


def _internal_main(argv: Optional[List[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(prog="python -m nsdeploy.cailville")
    # pylint: disable-next=protected-access  # argparse exposes no public name for the subparsers action type
    sub: argparse._SubParsersAction[argparse.ArgumentParser] = parser.add_subparsers(dest="command", required=True)
    rows: argparse.ArgumentParser = sub.add_parser("launch-rows")
    rows.add_argument("--cailville-dir", required=True)
    rows.add_argument("--project-dir", required=True)
    rows.add_argument("--base-domain")
    rows.add_argument("--public-scheme", choices=("http", "https"), default="http")
    rows.add_argument("--public-port", type=int)
    ports: argparse.ArgumentParser = sub.add_parser("ports")
    ports.add_argument("--cailville-dir", required=True)
    ports.add_argument("--project-dir")
    manifest: argparse.ArgumentParser = sub.add_parser("active-manifest")
    manifest.add_argument("--cailville-dir", required=True)
    manifest.add_argument("--project-dir", required=True)
    args: argparse.Namespace = parser.parse_args(argv)
    if args.command == "launch-rows":
        emit_launch_rows(
            Path(args.cailville_dir).resolve(), Path(args.project_dir).resolve(),
            base_domain=args.base_domain, public_scheme=args.public_scheme,
            public_port=args.public_port,
        )
    elif args.command == "ports":
        project_dir: Optional[Path] = Path(args.project_dir).resolve() if args.project_dir else None
        port: int
        for port in cailville_ports(Path(args.cailville_dir).resolve(), project_dir):
            print(port)
    elif args.command == "active-manifest":
        write_active_private_manifest(
            Path(args.cailville_dir).resolve(), Path(args.project_dir).resolve()
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(_internal_main())
