# pylint: disable=too-many-lines  # supervisor state machine kept in one module
"""Deployment supervisor: one `python -m nsdeploy` child process per network.

Why a child process rather than calling nsdeploy.launcher.serve() in-process:

* serve() blocks in httpd.serve_forever() and exposes no shutdown handle
  (nsdeploy/launcher.py), so an in-process call could never be torn down.
* A build imports the HOCON's coded-tool classes and may pip-install their deps
  (nsdeploy/resolve.py::_import_with_autoinstall). Keeping that out of the API
  process means a bad upload cannot crash or mutate the service.
* Each site already owns a tree of subprocesses (one FastMCP host per hostable
  tool + the public facade), so process-tree teardown is required regardless.

This mirrors cailville/launch_all.sh, which supervises the 13-site demo the same way.
"""
from __future__ import annotations

import asyncio
import functools
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Tuple

from nsdeploy_service.config import REPO_ROOT
from nsdeploy_service.config import SERVICE_ROOT
from nsdeploy_service.config import Settings
from nsdeploy_service.layout import is_on_grid
from nsdeploy_service.layout import next_position
from nsdeploy_service.models import AgentGraphEdge
from nsdeploy_service.models import AgentGraphNode
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.models import NetworkLink
from nsdeploy_service.models import NetworkSummary
from nsdeploy_service.models import SUMMARY_SCHEMA_VERSION
from nsdeploy_service.ports import PortPool
from nsdeploy_service.ports import PortPoolExhausted
from nsdeploy_service.shared_byok import sync_shared_byok
from nsdeploy_service.site_env import SiteEnv
from nsdeploy_service.store import UNATTRIBUTED_NAME
from nsdeploy_service.store import Store
from nsdeploy_service.store import StoreError

IS_WINDOWS = sys.platform == "win32"
READINESS_POLL_SECONDS = 0.5
HTTP_PROBE_TIMEOUT_SECONDS = 5.0
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
HOCON_SUFFIXES = (".hocon", ".conf", ".txt")
# Every browser renames a second download of the same file to "thing (1).hocon", and
# downloading a network's HOCON, editing it and uploading it again is a normal round
# trip — so that marker arrives far more often than it looks like it would.
DUPLICATE_MARKER_RE = re.compile(r"\s*\(\d+\)$")


class DeploymentError(RuntimeError):
    """A deployment could not be accepted (bad input, no capacity)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat(timespec="seconds") if value else None


def safe_network_name(raw: str) -> str:
    """Validate a network name that will become a filename and a URL fragment.

    nsdeploy derives the network name from the HOCON's filename stem, so this value
    reaches the filesystem and the generated bundle. Only a trailing .hocon/.conf/.txt
    is stripped — .txt because the browser renames uploads to dodge proxies that block
    the .hocon extension (deploy.js's toUploadFilename) — anything else that is not a
    plain identifier is rejected rather than sanitised, so `../../evil` is an error
    instead of a silent rename to `evil`. Callers that legitimately receive a path (an
    upload filename) must pass the basename themselves — that choice should be
    explicit, not hidden in here.

    A browser's duplicate-download marker is the one other thing removed: a file saved
    twice becomes `acute_care_hospital_network (1).hocon`, and that is the same network
    re-downloaded and edited, not a new one named with a space and brackets. Dropping it
    stays within the rule above rather than loosening it — only a trailing parenthesised
    integer goes, and whatever remains must still be a plain identifier, so `my network`
    is as much an error as it ever was.

    Note the consequence, which is the wanted one: the marker being gone means an edited
    re-upload carries the original name, so it *replaces* that organization's existing
    deployment instead of standing up a near-duplicate beside it.
    """
    name = (raw or "").strip()
    for suffix in HOCON_SUFFIXES:
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
            break
    name = DUPLICATE_MARKER_RE.sub("", name).strip()
    if not NAME_RE.match(name):
        raise DeploymentError(
            f"invalid network name {raw!r}: use 1-64 characters of letters, digits, "
            f"'_' or '-' (optionally with a .hocon/.conf/.txt suffix), and no path separators"
        )
    return name


@dataclass
class Deployment:  # pylint: disable=too-many-instance-attributes; one field per persisted column
    """Server-side record for one deployed network."""

    id: str
    name: str
    org_id: str
    org_name: str
    work_dir: Path
    log_path: Path
    hocon_path: Path
    out_dir: Path
    site_dir: Path
    port: int
    url: str
    options: DeployOptions
    status: DeploymentStatus = DeploymentStatus.QUEUED
    created_at: datetime = field(default_factory=_now)
    ready_at: Optional[datetime] = None
    stopped_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    error: Optional[str] = None
    process: Optional[subprocess.Popen] = None
    network: Optional[NetworkSummary] = None
    warnings: List[str] = field(default_factory=list)
    # When this network was put on the map, or None for a draft. Mirrors the stored
    # column so the create/restart responses can report it without a re-read; the
    # store is still the only writer (see store.set_published).
    published_at: Optional[str] = None
    # True when this deploy replaced an existing network of the same name in the same
    # organization. Transient and never persisted — it describes what this one upload
    # did, not a property of the network, so `as_row` deliberately omits it and a
    # later restart of the same record reports nothing.
    replaced: bool = False
    # Map coordinates. Assigned on first create and preserved by the store on every
    # later write, so a rebuild or restart never moves the pin.
    position: Optional[Dict[str, int]] = None

    @property
    def pid(self) -> Optional[int]:
        """
        Return the child process id while one is running.

        :return: The pid, or None when no process is attached.
        """
        return self.process.pid if self.process else None

    @property
    def is_live(self) -> bool:
        """
        Report whether the deployment is queued, building or ready.

        :return: True for a live deployment.
        """
        return self.status in (DeploymentStatus.QUEUED, DeploymentStatus.BUILDING,
                               DeploymentStatus.READY)

    def as_row(self) -> Dict[str, Any]:
        """Flatten into the persisted deployment record."""
        return {
            "id": self.id, "org_id": self.org_id, "name": self.name,
            "status": self.status.value,
            "url": self.url if self.status is DeploymentStatus.READY else None,
            "port": self.port if self.is_live else None,
            "created_at": _iso(self.created_at), "ready_at": _iso(self.ready_at),
            "stopped_at": _iso(self.stopped_at), "expires_at": _iso(self.expires_at),
            "error": self.error, "pid": self.pid,
            "network_json": json.dumps(self.network.model_dump()) if self.network else None,
            "warnings_json": json.dumps(self.warnings) if self.warnings else None,
            "log_path": str(self.log_path), "work_dir": str(self.work_dir),
            # Recorded so restart can replay the caller's original choices.
            "options_json": json.dumps(self.options.model_dump()),
            "hocon_path": str(self.hocon_path),
            "position_json": json.dumps(self.position) if self.position else None,
        }

    def endpoints(self) -> Dict[str, str]:
        """Notable routes on the deployed origin, as served by nsdeploy's launcher."""
        if self.status is not DeploymentStatus.READY:
            return {}
        base = self.url.rstrip("/")
        return {
            "site": f"{base}/",
            "mock_llm": f"{base}/v1/chat/completions",
            "byok_proxy": f"{base}/byok/v1/chat/completions",
            "mcp_facade": f"{base}/mcp",
            "agent_manifest": f"{base}/agent-manifest.json",
            "well_known": f"{base}/.well-known/nsdeploy-agent.json",
        }


def _terminate_tree(proc: subprocess.Popen, timeout: float = 10.0) -> None:
    """Kill a deployment's whole process tree.

    Each site spawns one FastMCP host per hostable tool plus the public MCP facade,
    so signalling only the parent would orphan them holding their private ports.
    """
    if proc.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            # /T walks the tree; the child was started in its own process group so
            # this cannot reach the service itself.
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                           capture_output=True, check=False, timeout=timeout)
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (OSError, subprocess.SubprocessError, ProcessLookupError):
        pass
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            if not IS_WINDOWS:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except (OSError, ProcessLookupError):
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


def _port_listening(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def _http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=HTTP_PROBE_TIMEOUT_SECONDS) as resp:
            return 200 <= resp.status < 400
    except (urllib.error.URLError, OSError, ValueError):
        return False


def _served_network_name(port: int, host: str = "127.0.0.1") -> Optional[str]:
    """The network name the site on `port` publishes, or None if it isn't ours yet.

    A bare "does / return 200" probe cannot tell this deployment's site apart from
    an unrelated server that happens to hold the port, and trusting it marked
    deployments ready before their bundle existed. The published manifest names the
    network, so it identifies the origin rather than merely proving something listens.
    """
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/agent-manifest.json",
                                    timeout=HTTP_PROBE_TIMEOUT_SECONDS) as resp:
            if not 200 <= resp.status < 400:
                return None
            manifest = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, UnicodeDecodeError):
        return None
    networks = manifest.get("networks") or [{}]
    name = networks[0].get("name")
    return name if isinstance(name, str) else None


def is_publishable(row: Dict[str, Any]) -> bool:
    """Whether this record could be published right now.

    Derived server-side and reported on the deployment view so the console does not
    re-implement the rule and drift from it.
    """
    return (DeploymentStatus(row["status"]) is DeploymentStatus.READY
            and not row.get("published_at"))


def publish_refusal(row: Dict[str, Any]) -> str:
    """Why this record cannot go on the map, and what to do about it.

    Two distinct cases with two different remedies — a build that never served needs
    deploying, whereas one that served and then stopped needs relaunching. Collapsing
    them into "not ready" tells the operator nothing they can act on.
    """
    name = row.get("name", "this network")
    if not row.get("ready_at"):
        return (f"Deploy {name} successfully before publishing it to the map — "
                f"it is {row['status']} and has never served.")
    return (f"{name} is {row['status']}. Restart it so it is serving again, then "
            f"publish it — a pin on the map has to lead somewhere.")


def probe_host(deploy_host: str) -> str:
    """The address to health-check a site on, given the address it binds.

    A wildcard bind is not a connectable address, so those are probed over
    loopback. A specific non-loopback bind must be probed at that address —
    probing 127.0.0.1 would time out and fail every build.
    """
    return "127.0.0.1" if deploy_host in ("", "0.0.0.0", "::", "*") else deploy_host


@functools.lru_cache(maxsize=4)
def engine_supports_host(python_exe: str) -> bool:
    """Whether this nsdeploy build accepts `--host`.

    Asked rather than assumed. `--host` is the only flag the service needs that
    upstream nsdeploy does not ship, and three successive engine drops have removed
    it — each time producing a deployment that reports `ready` and serves nothing,
    because the site bound loopback inside a bridged container. Probing turns that
    into a decision the service can act on.

    Reads `--help` instead of importing nsdeploy's argument parser: the parser is
    built inside `main()` and is not importable without running it, and the help text
    is the same contract the command line is built against.

    Cached because it spawns a subprocess and the answer cannot change while the
    process is alive — a new engine means a new container. Keyed on the interpreter so
    a test can point at a different one.

    Fails CLOSED: anything unexpected (timeout, non-zero exit, missing module) reports
    False, so the service raises a clear configuration error rather than passing a flag
    that might not parse.
    """
    try:
        result = subprocess.run(
            [python_exe, "-m", "nsdeploy", "--help"],
            capture_output=True, text=True, timeout=60,
            cwd=str(REPO_ROOT), check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    return "--host" in (result.stdout or "")


def readiness_artifacts(out_dir: Path, name: str) -> List[Path]:
    """The files a finished build leaves behind, which `summarize_build` reads.

    Named in one place because two things depend on the same list: `bundle_ready`
    tests for them, and `Supervisor._clear_readiness` removes them before a
    rebuild so that the test cannot pass on the last build's output.
    """
    return [out_dir / "agent-manifest.json", out_dir / f"{name}.network.json"]


def bundle_ready(out_dir: Path, name: str) -> bool:
    """True once nsdeploy has written the artifacts `summarize_build` reads.

    Gating readiness on this keeps a deployment out of `ready` until the values the
    directory and the network map are built from actually exist on disk.

    Existence only, deliberately: the files are written by another process and
    there is no moment at which this one can read them atomically. What makes that
    safe is that a rebuild clears them first — see `Supervisor._clear_readiness`.
    """
    # Both have to exist; the first missing one answers the question.
    for path in readiness_artifacts(out_dir, name):
        if not path.is_file():
            return False
    return True


MAX_ERROR_CHARS = 600
# A restart appends to the same log so the earlier attempt stays readable. Everything
# that parses the log must therefore look only at the most recent run, or a previous
# attempt's tool list and errors bleed into the current result.
RUN_SEPARATOR = "=== nsdeploy-service: new run ==="


def latest_run(text: str) -> str:
    """The slice of a deployment log belonging to the most recent run."""
    _, separator, tail = text.rpartition(RUN_SEPARATOR)
    return tail if separator else text


# A HOCON syntax error surfaces as a multi-kilobyte pyparsing grammar dump. The only
# parts worth reporting are the exception class and where the parser gave up.
_PARSE_LOCATION_RE = re.compile(r"\(at char \d+\), \(line:(\d+), col:(\d+)\)")
_EXCEPTION_RE = re.compile(r"^(?P<cls>[\w.]*(?:Error|Exception)): (?P<msg>.*)$")
_CLI_ERROR_RE = re.compile(r"^error: (?P<msg>.+)$")


def _error_excerpt(log_path: Path, returncode: Optional[int]) -> str:
    """A short, human-readable reason a build failed.

    The full output always stays available via GET /deployments/{id}/logs; this is the
    one-glance summary that goes in the `error` field.
    """
    status = f"nsdeploy exited with status {returncode}"
    try:
        text = latest_run(log_path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return status
    lines = text.splitlines()

    # nsdeploy's own argparse/validation failures are already well phrased.
    for line in reversed(lines):
        cli = _CLI_ERROR_RE.match(line.strip())
        if cli:
            return f"{status}: {cli.group('msg')[:MAX_ERROR_CHARS]}"

    if "pyparsing.exceptions" in text or "ConcatenatedValueParser" in text:
        location = _PARSE_LOCATION_RE.search(text)
        where = (f" at line {location.group(1)}, column {location.group(2)}"
                 if location else "")
        return (f"the HOCON could not be parsed{where}. {status}. "
                f"Check the syntax and that every `include` path exists upstream.")

    for line in reversed(lines):
        exc = _EXCEPTION_RE.match(line.strip())
        if exc:
            message = " ".join(exc.group("msg").split())[:MAX_ERROR_CHARS]
            return f"{status}: {exc.group('cls')}: {message}"

    tail = " ".join(" ".join(lines[-6:]).split())
    return f"{status}: {tail[:MAX_ERROR_CHARS]}" if tail else status


def _tail(path: Path, limit: int) -> Tuple[List[str], bool]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return [], False
    lines = text.splitlines()
    if limit <= 0 or len(lines) <= limit:
        return lines, False
    return lines[-limit:], True


# --- build-result extraction -------------------------------------------------
# Authoritative values come from the generated bundle. Tool/agent *names* are only
# printed in nsdeploy's stdout report (resolve.format_report), so those are parsed
# from the log on a best-effort basis: a parse miss leaves the field empty and the
# full log stays available via GET /deployments/{id}/logs.
_BULLET_RE = re.compile(r"^\s*[•\-\*]\s*(.+?)\s*$")
_SECTIONS = {
    "hostable_tools": "Hostable tools",
    "demo_mode_agents": "DEMO-MODE agents",
    "missing_tools": "Missing tools",
}
_EXT_MCP_RE = re.compile(r"External MCP \(proxied\):\s*\S+\s*→\s*(\S+)")


def _parse_report(log_text: str) -> Dict[str, List[str]]:
    found: Dict[str, List[str]] = {key: [] for key in _SECTIONS}
    current: Optional[str] = None
    for line in log_text.splitlines():
        matched_header = next((key for key, marker in _SECTIONS.items() if marker in line), None)
        if matched_header:
            current = matched_header
            continue
        bullet = _BULLET_RE.match(line)
        if bullet and current:
            # "ddgs_search  →  module.Class  (MCP /_mcp/0/mcp)" → "ddgs_search"
            item = re.split(r"\s+→\s+|\s*:\s", bullet.group(1), maxsplit=1)[0].strip()
            if item:
                found[current].append(item)
        elif not line.strip():
            current = None
    found["external_mcps"] = _EXT_MCP_RE.findall(log_text)
    return found


# A tool URL that is an MCP endpoint rather than a peer agent network. nsdeploy
# classifies by path (resolve.py::_looks_like_mcp) and rewrites hostable tools and
# external MCP servers to same-origin proxy paths, so all three shapes appear in the
# generated config and none of them is a peer network.
_MCP_SHAPED = re.compile(r"(/mcp/?$|/mcp/|/sse/?$|/_mcp/|/ext-mcp/)", re.I)


def _inline_peers(network: Dict[str, Any]) -> List[NetworkLink]:
    """Agent-network URLs written directly into an agent's `tools`.

    `rewrite_config` preserves public agent-network URLs verbatim (it only rewrites
    tool and MCP references), so the generated config is where they can be found.
    They never reach `linking.imports`, which is built only from named link slots —
    so without this a network wired up with plain URLs looked completely
    unconnected on the map even though it calls its peers perfectly well.

    One entry per (url, caller) pair collapsed to one per url, with every calling
    agent listed, matching the shape of a slot-bound link.
    """
    callers_by_url: Dict[str, List[str]] = {}
    for agent in network.get("tools") or []:
        if not isinstance(agent, dict):
            continue
        caller = agent.get("name") or ""
        for ref in agent.get("tools") or []:
            if not isinstance(ref, str) or not ref.lower().startswith(("http://", "https://")):
                continue
            if _MCP_SHAPED.search(ref):
                continue
            callers_by_url.setdefault(ref.rstrip("/"), [])
            if caller and caller not in callers_by_url[ref.rstrip("/")]:
                callers_by_url[ref.rstrip("/")].append(caller)
    return [
        # `reference` is the URL itself: an inline peer has no slot name, and
        # inventing one would read as a binding that does not exist.
        NetworkLink(reference=url, target=url, callers=sorted(callers))
        for url, callers in sorted(callers_by_url.items())
    ]


def summarize_build(out_dir: Path, name: str, log_text: str) -> NetworkSummary:
    """
    Read the generated bundle and build log into a network summary.

    :param out_dir: The nsdeploy output directory.
    :param name: The network name.
    :param log_text: The deployment log; only the most recent run is read.
    :return: The network summary.
    """
    summary = NetworkSummary()
    log_text = latest_run(log_text)
    try:
        manifest = json.loads((out_dir / "agent-manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = {}
    try:
        network = json.loads((out_dir / f"{name}.network.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        network = {}

    summary.front_man = (manifest.get("agent_mcp") or {}).get("front_man", "")
    summary.agent_count = len(network.get("tools") or [])
    summary.link_slots = sorted((network.get("link_slots") or {}).keys())
    # Resolved outbound links are the map's edges. `pending` imports are dangling
    # references and are already reported as link_slots, so only `linked` counts.
    summary.links = [
        NetworkLink(
            reference=item.get("reference", ""),
            target=item.get("target", ""),
            callers=[caller for caller in (item.get("callers") or []) if caller],
        )
        for item in ((manifest.get("linking") or {}).get("imports") or [])
        if item.get("status") == "linked" and item.get("target")
    ]
    summary.peer_urls = _inline_peers(network)
    summary.brand = manifest.get("brand", "")
    networks = manifest.get("networks") or [{}]
    summary.description = networks[0].get("description", "")
    summary.sample_queries = networks[0].get("sample_queries") or []
    # The front-man's authored purpose, which theming does not touch. Read from the
    # resolved config rather than the manifest: `networks[0].description` is the field
    # the theme pass rewrites, so on a themed build that is a tagline while this is
    # still the paragraph the author wrote. Both are kept — see NetworkSummary.
    summary.front_man_description = next(
        (
            _agent_description(agent)
            for agent in (network.get("tools") or [])
            if isinstance(agent, dict) and agent.get("name") == summary.front_man
        ),
        "",
    )

    parsed = _parse_report(log_text)
    summary.hostable_tools = parsed["hostable_tools"]
    summary.demo_mode_agents = parsed["demo_mode_agents"]
    summary.missing_tools = parsed["missing_tools"]
    summary.external_mcps = parsed["external_mcps"]
    return summary


def _agent_description(item: dict) -> str:
    """One agent's authored purpose, from its resolved `function.description`.

    HOCON block strings arrive wrapped and indented — leading newlines and a
    trailing run of alignment spaces are normal — so the whitespace is collapsed
    to single spaces here rather than left for every reader to cope with. The
    text itself is the author's and is not otherwise touched or truncated.
    """
    function = item.get("function")
    raw = function.get("description") if isinstance(function, dict) else None
    if not isinstance(raw, str):
        return ""
    return " ".join(raw.split())


def network_topology(
    out_dir: Path, name: str, front_man: str,
) -> Tuple[List[AgentGraphNode], List[AgentGraphEdge]]:
    """The agent call graph inside one deployed network.

    `summarize_build` reads the same generated `{name}.network.json` and keeps only
    a count; this keeps every agent and every "tools" reference between them, since
    that is the entire nodes+edges structure the console's network diagram needs —
    no re-parsing of the original HOCON required.
    """
    try:
        network = json.loads((out_dir / f"{name}.network.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], []

    tools = [item for item in (network.get("tools") or []) if item.get("name")]
    by_name = {item["name"] for item in tools}

    nodes = [
        AgentGraphNode(
            id=item["name"], name=item["name"],
            kind="root" if item["name"] == front_man
                 else ("orchestrator" if item.get("tools") else "agent"),
            description=_agent_description(item),
            # Only the callees that are agents in this network. A URL callee is an
            # endpoint, reported as its own external node below, and listing it
            # here as a sibling of named agents would read as one.
            calls=[callee for callee in (item.get("tools") or []) if callee in by_name],
        )
        for item in tools
    ]

    edges: List[AgentGraphEdge] = []
    external_ids: Dict[str, str] = {}
    for item in tools:
        for callee in (item.get("tools") or []):
            if not callee:
                continue
            if callee in by_name:
                edges.append(AgentGraphEdge(source=item["name"], target=callee))
                continue
            # A hosted or external MCP endpoint, addressed by URL rather than by its
            # own agent card — represented as a leaf node keyed on that URL.
            ext_id = external_ids.get(callee)
            if ext_id is None:
                ext_id = f"ext:{len(external_ids)}"
                external_ids[callee] = ext_id
                label = "Hosted tool" if "/_mcp/" in callee else "External MCP"
                # For an endpoint the URL *is* the description: there is no
                # authored prose about it anywhere in the HOCON, and "which one"
                # is the only question a reader has about it.
                nodes.append(AgentGraphNode(
                    id=ext_id, name=label, kind="external", description=callee,
                ))
            edges.append(AgentGraphEdge(source=item["name"], target=ext_id))

    return nodes, edges


def build_warnings(summary: NetworkSummary) -> List[str]:
    """
    Turn the problems recorded in a summary into user-facing warnings.

    :param summary: The network summary.
    :return: The warning messages.
    """
    warnings: List[str] = []
    if summary.missing_tools:
        warnings.append(
            f"{len(summary.missing_tools)} tool reference(s) could not be resolved and were "
            f"dropped from the deployed network: {', '.join(summary.missing_tools)}"
        )
    if summary.demo_mode_agents:
        warnings.append(
            f"{len(summary.demo_mode_agents)} agent(s) run in demo_mode and fabricate "
            f"plausible answers instead of using real data: {', '.join(summary.demo_mode_agents)}"
        )
    if summary.link_slots:
        warnings.append(
            f"{len(summary.link_slots)} unlinked agent-network reference(s): "
            f"{', '.join(summary.link_slots)}"
        )
    return warnings


class Supervisor:  # pylint: disable=too-many-instance-attributes; owns registry, pool, locks and tasks
    """Owns the deployment registry, the port pool, and every child process."""

    def __init__(self, settings: Settings, store: Optional[Store] = None) -> None:
        self.settings = settings
        self.ports = PortPool(settings.port_start, settings.port_end)
        self._deployments: Dict[str, Deployment] = {}
        self._lock = threading.Lock()
        self._build_slots = asyncio.Semaphore(settings.max_concurrent_builds)
        # Slots actually held. A deployment keeps BUILDING status after it
        # releases its slot, so the status counts alone no longer say whether
        # the service is saturated.
        self._slots_in_use: int = 0
        # One lock per work directory. A restart and a re-upload both reuse the
        # directory of the deployment they replace, so without this the outgoing
        # build's cleanup can still be deleting files while its replacement is
        # generating them there. Keyed by path rather than by deployment, because
        # the replacement is a different Deployment over the same directory.
        #
        # Only ever touched from the event loop, so neither dict needs a guard of
        # its own. A lock is kept only while a build holds or waits for it:
        # MAX_DEPLOYMENTS bounds live deployments, not directories ever built in,
        # and forget() drops a record without dropping its lock, so a registry that
        # only grew would keep an entry for every deploy/purge cycle of the
        # service's life.
        self._work_locks: Dict[str, asyncio.Lock] = {}
        self._work_claims: Dict[str, int] = {}
        self._tasks: set[asyncio.Task] = set()
        settings.work_root.mkdir(parents=True, exist_ok=True)
        self.store = store or Store(settings.database_path())
        # Deployed sites are children of this process, so anything a previous run left
        # marked live is already dead. Settle those rows before serving the directory.
        self.orphaned = self.store.reconcile_orphans()
        # Uploads without an org still belong in the directory.
        self.fallback_org = self.store.ensure_org(UNATTRIBUTED_NAME)
        self.backfilled_positions = self._backfill_positions()
        self.resummarized = self._repair_summaries()
        self.shared_byok_synced = self._sync_shared_byok_sites()

    def _sync_shared_byok_sites(self) -> List[str]:
        """Apply the reversible browser behavior to already-generated sites."""
        changed: List[str] = []
        for row in self.store.list_deployments():
            if sync_shared_byok(Path(row["work_dir"])):
                changed.append(row["id"])
        return changed

    def _repair_summaries(self) -> List[str]:
        """Re-derive network summaries that were persisted empty or incomplete.

        A record marked ready before its bundle was written stored a blank summary:
        no front-man, no agent count, and — the part that matters for a multi-network
        deployment — no resolved links, so GET /graph drew no edges between networks
        that can in fact call each other. The generated bundle is still on disk and is
        the authoritative source, so the summary is rebuilt from it at startup rather
        than left wrong until someone redeploys.

        It also backfills summaries written before a field existed. `network_json` is a
        point-in-time snapshot of whatever NetworkSummary looked like at build time, so
        adding a field leaves every older record without it — and a console that reads
        the new field then behaves differently for old and new networks with nothing to
        tell them apart. Re-deriving from the bundle fixes that on the next restart
        rather than demanding a hundred redeployments.

        Which records need that backfill is decided by SUMMARY_SCHEMA_VERSION, not by
        inspecting the fields. No field can answer it: one that is legitimately empty —
        a front-man with no description of its own, a network with no outbound links —
        looks exactly like one that was never filled in, so a check written over the
        fields re-derives such a record at every startup and never converges.
        """
        repaired: List[str] = []
        for row in self.store.list_deployments():
            summary = row.get("network") or {}
            # Derived under this revision of the model, and not left blank by the
            # premature-ready bug. A record written before the version was recorded
            # reads back as 0 and is re-derived once, which stamps the version.
            version = int(summary.get("schema_version") or 0)
            complete = summary.get("agent_count") and version >= SUMMARY_SCHEMA_VERSION
            if complete:
                continue
            out_dir = Path(row["work_dir"]) / "site"
            if not bundle_ready(out_dir, row["name"]):
                continue  # never built; nothing to recover
            log_path = Path(row["log_path"])
            log_text = log_path.read_text(encoding="utf-8", errors="replace") \
                if log_path.is_file() else ""
            rebuilt = summarize_build(out_dir, row["name"], log_text)
            if not rebuilt.agent_count:
                continue  # bundle unreadable — leave the record untouched
            self.store.set_summary(row["id"], rebuilt.model_dump(),
                                   build_warnings(rebuilt))
            repaired.append(row["id"])
        return repaired

    def _backfill_positions(self) -> List[str]:
        """Give every record a map position that is valid on the current grid.

        Two cases, both resolved once at startup so GET /graph stays a pure
        projection (a read-time fallback would re-derive coordinates on every request
        and existing pins would shift whenever a new one was added):

        * records written before positions were stored at all;
        * records whose stored slot is no longer on the grid, e.g. after the artwork's
          coastline moved and their pin would now sit in the water.
        """
        rows = self.store.list_deployments()
        stale = [row["id"] for row in rows if not is_on_grid(row.get("position"))]
        if not stale:
            return []
        placed = [row["position"] for row in rows if is_on_grid(row.get("position"))]
        for deployment_id in stale:
            position = next_position(placed)
            placed.append(position)
            self.store.set_position(deployment_id, position)
        return stale

    def _persist(self, dep: Deployment) -> None:
        self.store.save_deployment(dep.as_row())

    # --- registry ---------------------------------------------------------
    def get(self, deployment_id: str) -> Optional[Deployment]:
        """
        Look up a deployment by id.

        :param deployment_id: The deployment id.
        :return: The deployment, or None if it is not registered.
        """
        with self._lock:
            return self._deployments.get(deployment_id)

    def build_queue(self) -> Dict[str, Any]:
        """
        Report how many deployments wait for a build slot, and for how long.

        A deployment holds its slot for the whole build *and* the readiness poll, so
        one stuck build can keep others queued for up to BUILD_TIMEOUT_SECONDS. The
        wait itself has no deadline — `build_timeout_seconds` is measured only after
        a slot is taken — so without these numbers a stalled queue and a busy one
        look the same from outside.

        Counted from the in-memory deployments, which is where a queue can exist: a
        record from an earlier run is terminal and never waits for a slot.

        :return: The slot count, how many build now, how many wait, and the longest
                 wait in whole seconds (None when nothing waits).
        """
        waiting: List[Deployment] = []
        building: int = 0
        now: datetime = _now()
        # One pass over the live deployments, so both counts read one snapshot.
        for dep in self.list():
            if dep.status is DeploymentStatus.QUEUED:
                waiting.append(dep)
            elif dep.status is DeploymentStatus.BUILDING:
                building += 1
        oldest: Optional[int] = None
        if waiting:
            # list() is newest first, so the last entry has waited longest.
            earliest: Deployment = waiting[-1]
            oldest = int((now - earliest.created_at).total_seconds())
        return {
            "slots": self.settings.max_concurrent_builds,
            "slots_in_use": self._slots_in_use,
            "building": building,
            "waiting": len(waiting),
            "oldest_wait_seconds": oldest,
        }

    def list(self) -> List[Deployment]:
        """
        List every registered deployment, newest first.

        :return: The deployments.
        """
        with self._lock:
            return sorted(self._deployments.values(), key=lambda d: d.created_at, reverse=True)

    def counts(self) -> Dict[str, int]:
        """
        Count registered deployments per status.

        :return: A mapping from status value to count.
        """
        counts = {status.value: 0 for status in DeploymentStatus}
        with self._lock:
            for dep in self._deployments.values():
                counts[dep.status.value] += 1
        return counts

    # --- create -----------------------------------------------------------
    def _resolve_org(self, options: DeployOptions) -> Dict[str, Any]:
        """Pick the organization an upload is attributed to.

        An explicit `org_id` is authoritative and must exist: a caller naming a
        specific organization that has been deleted is an error, not a reason to
        quietly re-attribute their network to someone else. A free-text `org_name`
        is get-or-create, which is what lets the console ask for one field instead
        of making an operator create a profile before their first deployment —
        matching is case- and whitespace-insensitive, so "Acme Ltd" and "acme  ltd"
        are the same organization rather than two pins claiming the same name.
        """
        if options.org_id:
            org = self.store.get_org(options.org_id)
            if org is None:
                raise DeploymentError(f"no organization {options.org_id!r}")
            return org
        if options.org_name and options.org_name.strip():
            try:
                return self.store.ensure_org(options.org_name)
            except StoreError as exc:
                # A rejected name is bad input on this request (400), not a conflict
                # with existing state (409) — ensure_org already absorbed the
                # duplicate-name race.
                raise DeploymentError(str(exc)) from exc
        return self.fallback_org

    def _existing_for(self, org_id: str, name: str) -> Optional[Dict[str, Any]]:
        """The record this upload should replace, or None.

        Matched on (organization, name). Existing installations may already hold
        several rows for one name — this feature is the thing that stops that
        happening, not a migration of what it already produced — so the choice has
        to be deterministic: a live one first (replacing a stopped record while a
        live copy of the same network keeps serving would be the surprising
        outcome), then the most recently created.
        """
        rows = [row for row in self.store.list_deployments(org_id=org_id)
                if row.get("name") == name]
        if not rows:
            return None
        live_ids = {dep.id for dep in self.list() if dep.is_live}
        rows.sort(key=lambda row: (row["id"] in live_ids, row.get("created_at") or ""),
                  reverse=True)
        return rows[0]

    def _replace(self, row: Dict[str, Any], text: str, options: DeployOptions,
                 org: Dict[str, Any]) -> Deployment:
        """Rebuild an existing network in place from a freshly uploaded HOCON.

        Keeps four things, each for its own reason:
        * the **port**, so the site's URL does not change — the origin is baked into
          every bundle at build time, so another network's configured link to this
          one would break the moment the port moved;
        * the **id**, so bookmarks into the console and the stored logs stay valid;
        * the **map position**, so the pin does not jump on an edit;
        * **published_at**, because a revision of a published network is still
          published and should not silently vanish off the map.
        """
        deployment_id = row["id"]
        existing = self.get(deployment_id)
        if existing is not None and existing.is_live:
            # Synchronous teardown: the port has to be free before it is re-reserved
            # below, and two processes must never hold it at once.
            self._teardown(existing, DeploymentStatus.STOPPED, "replaced by a new upload")

        work_dir = Path(row["work_dir"])
        try:
            work_dir.mkdir(parents=True, exist_ok=True)
            hocon_path = work_dir / f"{row['name']}.hocon"
            hocon_path.write_text(text, encoding="utf-8")
        except OSError as exc:
            raise DeploymentError(
                f"cannot write the replacement HOCON for {row['name']}: {exc}") from exc

        try:
            port = self.ports.reserve(preferred=row.get("port") or None)
        except PortPoolExhausted as exc:
            raise DeploymentError(str(exc)) from exc

        ttl = self.settings.ttl_seconds if options.ttl_seconds is None else options.ttl_seconds
        dep = Deployment(
            id=deployment_id,
            name=row["name"],
            org_id=org["id"],
            org_name=org["name"],
            position=row.get("position") or next_position(
                item.get("position") for item in self.store.list_deployments()),
            work_dir=work_dir,
            log_path=Path(row["log_path"]) if row.get("log_path") else work_dir / "nsdeploy.log",
            hocon_path=hocon_path,
            out_dir=work_dir / "site",
            site_dir=work_dir / "site-source",
            port=port,
            url=self.settings.site_url(deployment_id, port, row["name"]),
            # The NEW upload's options win: this is a fresh deploy of the same
            # network, not a restart replaying what was chosen last time.
            options=options,
            created_at=_now(),
            expires_at=_now() + timedelta(seconds=ttl) if ttl else None,
            published_at=row.get("published_at"),
            replaced=True,
        )

        with self._lock:
            self._deployments[deployment_id] = dep
        self._persist(dep)
        # A replacement of an unpublished network still honours autopublish, so an
        # edit does not need a second trip to the publish button.
        if self.settings.autopublish and not dep.published_at:
            dep.published_at = _iso(_now())
            self.store.set_published(deployment_id, dep.published_at)
        return dep

    def create(self, hocon_bytes: bytes, options: DeployOptions) -> Deployment:  # pylint: disable=too-many-locals
        """Accept an upload, reserve a port, and write the work dir. Does not build."""
        if not hocon_bytes.strip():
            raise DeploymentError("the uploaded HOCON is empty")
        if len(hocon_bytes) > self.settings.max_hocon_bytes:
            raise DeploymentError(
                f"HOCON is {len(hocon_bytes)} bytes; the limit is {self.settings.max_hocon_bytes}"
            )
        try:
            text = hocon_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise DeploymentError(f"HOCON must be UTF-8 text: {exc}") from exc

        name = safe_network_name(options.name or "network")
        org = self._resolve_org(options)

        # Re-uploading the same network for the same organization replaces it rather
        # than standing up a second copy. The identity is (organization, network
        # name) because the name IS the HOCON's filename stem — two uploads of
        # `store_returns_ops.hocon` are two revisions of one network, not two
        # networks, and treating them as two filled the port pool with duplicates
        # that all answered the same thing.
        #
        # Deliberately not keyed on the HOCON's *contents*: an edited file is still
        # the same network, and that is exactly the case this has to cover.
        replacing = self._existing_for(org["id"], name)
        if replacing is not None:
            return self._replace(replacing, text, options, org)

        with self._lock:
            live = sum(1 for dep in self._deployments.values() if dep.is_live)
        if live >= self.settings.max_deployments:
            # Phrased for whoever is standing in front of the upload form. They are
            # not the person who can raise MAX_DEPLOYMENTS or stop someone else's
            # network, so "DELETE one first" was an instruction they could not act
            # on — and with the ceiling defaulting to 20, a team of 20 reaches it.
            raise DeploymentError(
                f"This service is already running its maximum of "
                f"{self.settings.max_deployments} networks, so there is no room to "
                f"start another right now. Ask an administrator to stop one that is "
                f"no longer needed (or to raise the limit), then try again."
            )

        try:
            port = self.ports.reserve()
        except PortPoolExhausted as exc:
            raise DeploymentError(str(exc)) from exc

        deployment_id = uuid.uuid4().hex[:12]
        try:
            work_dir = self.settings.work_root / deployment_id
            work_dir.mkdir(parents=True, exist_ok=True)
            hocon_path = work_dir / f"{name}.hocon"
            hocon_path.write_text(text, encoding="utf-8")
            ttl = self.settings.ttl_seconds if options.ttl_seconds is None else options.ttl_seconds
            # Placed once, against every pin already on the map.
            position = next_position(
                row.get("position") for row in self.store.list_deployments())
            dep = Deployment(
                id=deployment_id,
                name=name,
                org_id=org["id"],
                org_name=org["name"],
                position=position,
                work_dir=work_dir,
                log_path=work_dir / "nsdeploy.log",
                hocon_path=hocon_path,
                out_dir=work_dir / "site",
                site_dir=work_dir / "site-source",
                port=port,
                url=self.settings.site_url(deployment_id, port, name),
                options=options,
                expires_at=_now() + timedelta(seconds=ttl) if ttl else None,
            )
        except OSError as exc:
            self.ports.release(port)
            raise DeploymentError(f"cannot prepare the deployment work dir: {exc}") from exc

        with self._lock:
            self._deployments[deployment_id] = dep
        self._persist(dep)
        # The console's flow is launch-then-watch, so the pin has to be on the map from
        # the moment the build starts rather than after a separate publish step — a
        # launch that produced nothing visible for the ~20s of a warm build read as
        # "it didn't work". Stamped after _persist, because save_deployment never
        # writes this column: set_published is its only writer.
        if self.settings.autopublish:
            dep.published_at = _iso(_now())
            self.store.set_published(deployment_id, dep.published_at)
        return dep

    def start(self, dep: Deployment) -> None:
        """Schedule the build on the running event loop."""
        task = asyncio.create_task(self._build(dep), name=f"build-{dep.id}")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # --- restart ----------------------------------------------------------
    def restart(self, deployment_id: str, *, overrides: Optional[Dict[str, Any]] = None) -> Deployment:
        """Relaunch a terminal deployment in place from its stored HOCON.

        Keeps the same record id (so directory links and bookmarks into this UI stay
        valid) and asks for the original port back, which keeps the site's own URL
        stable — the origin is baked into the generated bundle, so a different port
        means a different URL. The caller's original DeployOptions are replayed rather
        than re-deriving them from current service defaults.

        `overrides` folds new values (e.g. an edited theme prompt, see
        POST /deployments/{id}/theme) into those replayed options before this
        relaunch — and, since `_persist` below writes the merged options back to the
        row, every restart after this one keeps them too.
        """
        row = self.store.get_deployment(deployment_id)
        if row is None:
            raise DeploymentError(f"no deployment {deployment_id!r}")

        existing = self.get(deployment_id)
        if existing is not None and existing.is_live:
            raise DeploymentError(
                f"{row['name']} is already {existing.status.value}; stop it before restarting")

        # The HOCON is the one thing a restart cannot do without. Older records predate
        # the hocon_path column, so fall back to the conventional path in the work dir.
        hocon_path = Path(row["hocon_path"]) if row.get("hocon_path") \
            else Path(row["work_dir"]) / f"{row['name']}.hocon"
        if not hocon_path.is_file():
            raise DeploymentError(
                f"the uploaded HOCON for {row['name']} is no longer on disk "
                f"({hocon_path}); upload it again to deploy")

        with self._lock:
            live = sum(1 for dep in self._deployments.values() if dep.is_live)
        if live >= self.settings.max_deployments:
            raise DeploymentError(
                f"This service is already running its maximum of "
                f"{self.settings.max_deployments} networks, so this one cannot be "
                f"restarted yet. Stop a network that is no longer needed, then try "
                f"again.")

        try:
            options = DeployOptions(**(row.get("options") or {}))
        except (TypeError, ValueError):
            # A corrupt options blob must not block a restart; fall back to defaults
            # for everything except the organization, which the record still knows.
            options = DeployOptions(name=row["name"], org_id=row["org_id"])
        if overrides:
            options = options.model_copy(update=overrides)

        port = self.ports.reserve(preferred=row.get("port") or None)
        try:
            work_dir = Path(row["work_dir"])
            ttl = self.settings.ttl_seconds if options.ttl_seconds is None else options.ttl_seconds
            dep = Deployment(
                id=deployment_id,
                name=row["name"],
                org_id=row["org_id"],
                org_name=row.get("org_name", ""),
                # Keep the pin where it was; the store also guards this.
                position=row.get("position") or next_position(
                    item.get("position") for item in self.store.list_deployments()),
                work_dir=work_dir,
                log_path=Path(row["log_path"]),
                hocon_path=hocon_path,
                out_dir=work_dir / "site",
                site_dir=work_dir / "site-source",
                port=port,
                # Same label as the original build, so a restart keeps its hostname.
                url=self.settings.site_url(deployment_id, port, row["name"]),
                options=options,
                created_at=_now(),
                expires_at=_now() + timedelta(seconds=ttl) if ttl else None,
                # A restart neither publishes nor withdraws: carry the stored state so
                # the response reports it correctly without re-reading the row.
                published_at=row.get("published_at"),
            )
        except (OSError, ValueError) as exc:
            self.ports.release(port)
            raise DeploymentError(f"cannot prepare the restart: {exc}") from exc

        with self._lock:
            self._deployments[deployment_id] = dep
        self._persist(dep)
        return dep

    # --- publish ----------------------------------------------------------
    def publish(self, deployment_id: str) -> Dict[str, Any]:
        """Put a tested network on the map.

        A network must be **deployed and serving** to go on the map: a pin whose
        site does not answer is worse than no pin. So the bar is the current status,
        not "was ready once" — which does mean that after a service restart (every
        live record settles to `stopped`) a network has to be relaunched before it
        can be published. The two refusals are told apart deliberately, because the
        actions they call for are different: deploy it, versus restart it.

        Publishing is idempotent and keeps the original timestamp.
        """
        row = self.store.get_deployment(deployment_id)
        if row is None:
            raise DeploymentError(f"no deployment {deployment_id!r}")
        if row.get("published_at"):
            return row
        if DeploymentStatus(row["status"]) is not DeploymentStatus.READY:
            raise DeploymentError(publish_refusal(row))
        self.store.set_published(deployment_id, _iso(_now()))
        return self.store.get_deployment(deployment_id)

    def unpublish(self, deployment_id: str) -> Dict[str, Any]:
        """Take a network off the map, leaving the deployment itself running."""
        row = self.store.get_deployment(deployment_id)
        if row is None:
            raise DeploymentError(f"no deployment {deployment_id!r}")
        if row.get("published_at"):
            self.store.set_published(deployment_id, None)
        return self.store.get_deployment(deployment_id)

    # --- build ------------------------------------------------------------
    def _command(self, dep: Deployment) -> List[str]:
        s = self.settings
        opts = dep.options
        cmd = [
            s.python_exe, "-m", "nsdeploy", str(dep.hocon_path),
            "--port", str(dep.port),
            "--out", str(dep.out_dir),
            "--site-dir", str(dep.site_dir),
            # The public origin is baked into the generated bundle (MCP tool URLs,
            # manifests, .well-known, steward HOCON), so it must be declared now and
            # must match the URL we hand back.
            "--site-url", dep.url,
            # Always the service-wide upstream. The site's /byok/v1 forwards every
            # visitor's API key there, so a deployment does not choose it, and an
            # `upstream` still stored in a record's options is ignored.
            "--upstream", s.upstream,
        ]
        # `--host` is the ONE flag this service has ever needed that upstream nsdeploy
        # does not ship. Three successive engine drops have removed it, each time
        # silently: sites bind loopback inside the container, Docker's `-p` forwards to
        # the container's interface rather than its loopback, and every site answers
        # connection refused while the build still reports `ready`.
        #
        # So it is no longer assumed to exist. `engine_supports_host()` asks the engine
        # once, and a drop that lacks the flag now degrades to a clear startup error
        # instead of either a crash ("unrecognized arguments: --host") or silence.
        #
        # The flag is only needed at all for the port-per-deployment model on a bridged
        # container. Two deployments avoid it completely and need no engine patch:
        #   * `docker run --network host` — the container shares the host's network
        #     namespace, so a site on 127.0.0.1 is on the host's loopback where a
        #     reverse proxy already reaches it. DEPLOY_HOST stays 127.0.0.1.
        #   * SUBDOMAIN_TEMPLATE + siteproxy.py — sites stay on loopback and are routed
        #     by hostname through the service's own port.
        if s.deploy_host and s.deploy_host != "127.0.0.1":
            if engine_supports_host(s.python_exe):
                cmd += ["--host", s.deploy_host]
            else:
                raise DeploymentError(
                    f"DEPLOY_HOST is {s.deploy_host!r}, but this nsdeploy build has no "
                    f"--host flag, so a site cannot be told to bind anything but "
                    f"loopback. Either run the container with `--network host` and set "
                    f"DEPLOY_HOST=127.0.0.1, or set SUBDOMAIN_TEMPLATE and let "
                    f"siteproxy route by hostname. See nsdeploy_service/README.md."
                )
        if s.facade_upstream:
            cmd += ["--facade-upstream", s.facade_upstream]
        if s.studio:
            cmd += ["--studio", s.studio]
        if s.repo:
            cmd += ["--repo", s.repo]
        if s.ref:
            cmd += ["--ref", s.ref]
        theme = s.theme if opts.theme is None else opts.theme
        if theme:
            cmd.append("--theme")
            model = opts.theme_model or s.theme_model
            if model:
                cmd += ["--theme-model", model]
            theme_refresh = s.theme_refresh if opts.theme_refresh is None else opts.theme_refresh
            if theme_refresh:
                cmd.append("--theme-refresh")
            theme_prompt = opts.theme_prompt if opts.theme_prompt is not None else s.theme_prompt
            if theme_prompt:
                cmd += ["--theme-prompt", theme_prompt]
        cruse = s.cruse if opts.cruse is None else opts.cruse
        if not cruse:
            cmd.append("--no-cruse")
        return cmd

    def _claim_work_lock(self, dep: Deployment) -> asyncio.Lock:
        """
        Claim the lock that serializes builds sharing one work directory.

        Claiming before acquiring is what makes the lock safe to retire: a waiter
        has registered its claim before the holder releases, so the entry cannot be
        removed and recreated underneath it — two Lock objects for one directory
        would serialize nothing.

        Acquired *after* a build slot, never before: a build which held this while
        queueing for a slot would block the predecessor that already has one from
        finishing and releasing it.

        :param dep: The deployment about to be built.
        :return: The lock for its work directory.
        """
        key: str = str(dep.work_dir)
        lock: Optional[asyncio.Lock] = self._work_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._work_locks[key] = lock
        self._work_claims[key] = self._work_claims.get(key, 0) + 1
        return lock

    def _drop_work_lock(self, dep: Deployment) -> None:
        """
        Give up this build's claim, retiring the lock once nothing holds it.

        :param dep: The deployment whose build has finished with the directory.
        """
        key: str = str(dep.work_dir)
        claims: int = self._work_claims.get(key, 0) - 1
        if claims > 0:
            self._work_claims[key] = claims
            return
        self._work_claims.pop(key, None)
        self._work_locks.pop(key, None)

    def _abandon(self, dep: Deployment) -> None:
        """
        Stop a child this build started for a deployment which is no longer building.

        A stop which lands while `_spawn` runs tears down a deployment whose
        `process` is still None, so `_teardown` releases the port and has nothing to
        signal. The child this build then produces is invisible to that teardown: it
        would outlive the record, serving on a port the pool has already handed back
        to the next deployment.

        The port is deliberately not released again — the teardown that set this
        status already did that, and releasing twice would hand one port to two
        deployments.

        :param dep: The deployment whose child must go.
        """
        process: Optional[subprocess.Popen] = dep.process
        dep.process = None
        if process is not None:
            _terminate_tree(process)

    def _clear_readiness(self, dep: Deployment) -> None:
        """
        Remove the artifacts a previous build of this deployment left behind.

        A restart and a re-upload both keep the deployment's work directory, so the
        last build's `agent-manifest.json` and network JSON are still in `out_dir`
        when the next child starts. `bundle_ready` tests only that those files
        exist, so without this the build slot is handed back on the first poll —
        before the new child has resolved anything — and concurrent restarts would
        run their resolution and generation with no bound at all.

        One visible consequence: `/graph` and the inferred relations read the
        network JSON from `out_dir` (relations.py), so this deployment contributes
        nothing to them until the rebuild writes it again. It is `building` for that
        whole window, which is what the directory already reports.

        :param dep: The deployment about to be built.
        :raises DeploymentError: If an artifact cannot be removed. Continuing would
                                 report a stale bundle as this build's own.
        """
        # Both files, so a half-cleared directory cannot read as a finished build.
        for path in readiness_artifacts(dep.out_dir, dep.name):
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise DeploymentError(
                    f"cannot clear the previous build's {path.name}: {exc}") from exc

    def _spawn(self, dep: Deployment) -> subprocess.Popen:
        """
        Start the nsdeploy process that builds and serves a deployment.

        :param dep: The deployment to start. Its output goes to its log file.
        :return: The started process.
        :raises OSError: If the log file cannot be opened or the process cannot start.
        :raises DeploymentError: If DEPLOY_HOST needs a --host flag this nsdeploy lacks.
        """
        # The site runs code from the uploaded network, so it gets none of the service's
        # credentials or the host's provider keys. See site_env.py.
        env: Dict[str, str] = SiteEnv.build(os.environ, self.settings.site_env_allow)
        env["PYTHONUNBUFFERED"] = "1"
        # nsdeploy's report is emoji-rich; without this the child's stdout is written
        # in the console codepage and the log comes back mojibaked.
        env["PYTHONIOENCODING"] = "utf-8"
        # _bootstrap first: Python imports sitecustomize at start-up, which
        # configures TLS trust in the child (and its own MCP-host and facade
        # grandchildren) without nsdeploy needing any patch. See
        # _bootstrap/sitecustomize.py.
        env["PYTHONPATH"] = os.pathsep.join(
            [str(SERVICE_ROOT / "_bootstrap"), str(REPO_ROOT), env.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)

        # Append rather than truncate so a restart keeps the previous attempt's output
        # visible; the separator is what keeps the log parsers scoped to this run.
        if dep.log_path.is_file() and dep.log_path.stat().st_size:
            with dep.log_path.open("a", encoding="utf-8") as existing:
                existing.write(f"\n\n{RUN_SEPARATOR}\n\n")
        log_handle = dep.log_path.open("ab", buffering=0)
        # Own process group / session so the tree can be signalled as a unit and a
        # Ctrl-C to the service does not race the child's own cleanup.
        kwargs: Dict[str, object] = {}
        if IS_WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        try:
            return subprocess.Popen(
                self._command(dep), cwd=str(REPO_ROOT), env=env,
                stdout=log_handle, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                **kwargs,
            )
        finally:
            # Popen duplicated the handle; the parent does not need to hold it open.
            log_handle.close()

    async def _build(self, dep: Deployment) -> None:
        generated: bool = False
        deadline: Optional[datetime] = None
        async with self._build_slots:
            if dep.status is not DeploymentStatus.QUEUED:
                return  # cancelled while queued
            # Counted from here, not from when the task was scheduled: the wait for
            # a slot is unbounded, so a deadline set before it would spend a
            # queued deployment's whole budget on queueing and fail it the moment
            # its child started. One deadline for both phases, so splitting the
            # slot cannot let a deployment take twice BUILD_TIMEOUT_SECONDS.
            deadline = _now() + timedelta(seconds=self.settings.build_timeout_seconds)
            dep.status = DeploymentStatus.BUILDING
            self._persist(dep)
            # Counted for the whole time the slot is held, clearing and spawning
            # included, or /health reports free capacity while every slot is busy.
            self._slots_in_use += 1
            # Nothing else may be building in this directory. A restart or a
            # re-upload builds in the directory of the deployment it replaces, and
            # the outgoing build's cleanup runs in a worker thread: without this it
            # could still be deleting files while the replacement generates them,
            # and no later status check can undo that.
            work_lock: asyncio.Lock = self._claim_work_lock(dep)
            try:
                async with work_lock:
                    # Cleared before the child starts, so the readiness test can
                    # only pass on output this build produced.
                    try:
                        await asyncio.to_thread(self._clear_readiness, dep)
                    except DeploymentError as exc:
                        # A stop can have completed while that worker ran. Failing
                        # now would release the port a second time and persist this
                        # record over the replacement which has already taken it.
                        if dep.status is DeploymentStatus.BUILDING:
                            self._fail(dep, str(exc))
                        return
                    # Clearing is an await point, so a stop can complete inside
                    # it. That teardown released the port and found no child to
                    # signal, so spawning now would put one on a port the pool
                    # has already handed back.
                    if dep.status is not DeploymentStatus.BUILDING:
                        return
                    try:
                        dep.process = await asyncio.to_thread(self._spawn, dep)
                    except OSError as exc:
                        if dep.status is DeploymentStatus.BUILDING:
                            self._fail(dep, f"could not start nsdeploy: {exc}")
                        return
                    # Spawning is an await point too, and a stop which landed in
                    # it could not see the child that came out of it.
                    # _await_generated would return for the changed status and
                    # leave it running.
                    if dep.status is not DeploymentStatus.BUILDING:
                        await asyncio.to_thread(self._abandon, dep)
                        return
                    self._persist(dep)  # record the pid now the child exists
                    generated = await self._await_generated(dep, deadline)
            except asyncio.CancelledError:
                self._teardown(dep, DeploymentStatus.STOPPED, "service shutting down")
                raise
            finally:
                self._drop_work_lock(dep)
                self._slots_in_use -= 1
        if not generated or deadline is None:
            return
        # Outside the slot. The child has written its bundle and is only binding
        # a port now, so it needs no build capacity — and holding one here is what
        # made a slow-starting site stall every queued deployment behind it.
        try:
            await self._await_ready(dep, deadline)
        except asyncio.CancelledError:
            self._teardown(dep, DeploymentStatus.STOPPED, "service shutting down")
            raise

    def _settle_if_building(self, dep: Deployment, error: str) -> None:
        """
        Fail a deployment, unless it has already been stopped or replaced.

        Every outcome in the build loops is reached after an await, so a stop can
        have completed in between. `_fail` releases the port, and failing a record
        which has already stopped releases it twice — the second release taking the
        reservation of whatever replacement has since claimed that port, and
        persisting this record over the replacement's state.

        :param dep: The deployment that failed.
        :param error: What to record as the reason.
        """
        if dep.status is DeploymentStatus.BUILDING:
            self._fail(dep, error)

    async def _await_generated(self, dep: Deployment, deadline: datetime) -> bool:
        """
        Poll until nsdeploy has written the bundle, or the build ends badly.

        This is the phase a build slot exists to bound. `bundle_ready` tests the
        two files generate_site writes before launcher.serve() is reached, so it
        is the observable end of the resolving, include-fetching and generating
        a slot is meant to limit. What follows is the child binding a port, which
        costs nothing a slot protects.

        :param dep: The deployment being built.
        :param deadline: When the whole build gives up.
        :return: True when the bundle exists and the wait for a listener should
                 continue; False when this deployment is already settled.
        """
        while _now() < deadline:
            if dep.status is not DeploymentStatus.BUILDING:
                return False  # stopped underneath us
            proc: Optional[subprocess.Popen] = dep.process
            if proc is None:
                self._settle_if_building(dep, "deployment process vanished")
                return False
            if proc.poll() is not None:
                self._settle_if_building(
                    dep, _error_excerpt(dep.log_path, proc.returncode))
                return False
            if await asyncio.to_thread(self._site_is_ready_to_summarize, dep):
                return True
            await asyncio.sleep(READINESS_POLL_SECONDS)
        # The deadline can expire during the last poll or sleep, so this is reached
        # after an await like every other outcome here.
        self._settle_if_building(
            dep,
            f"nsdeploy did not generate the bundle within "
            f"{self.settings.build_timeout_seconds}s (a cold build fetches includes "
            f"from GitHub and may pip-install tool deps)",
        )
        return False

    async def _await_ready(self, dep: Deployment, deadline: datetime) -> None:
        """
        Poll until the site answers, the child dies, or the build times out.

        :param dep: The deployment being built.
        :param deadline: When the whole build gives up.
        """
        while _now() < deadline:
            if dep.status is not DeploymentStatus.BUILDING:
                return  # stopped underneath us
            proc = dep.process
            if proc is None:
                self._settle_if_building(dep, "deployment process vanished")
                return
            if proc.poll() is not None:
                self._settle_if_building(
                    dep, _error_excerpt(dep.log_path, proc.returncode))
                return
            if await asyncio.to_thread(self._site_is_ours, dep):
                # The probe is an await too: a deployment stopped during it must
                # not be marked ready over the top of whatever replaced it.
                if dep.status is DeploymentStatus.BUILDING:
                    self._mark_ready(dep)
                return
            await asyncio.sleep(READINESS_POLL_SECONDS)
        self._settle_if_building(
            dep,
            f"the site did not become ready within {self.settings.build_timeout_seconds}s "
            f"(a cold build fetches includes from GitHub and may pip-install tool deps)",
        )

    def _site_is_ready_to_summarize(self, dep: Deployment) -> bool:
        return bundle_ready(dep.out_dir, dep.name)

    def _site_is_ours(self, dep: Deployment) -> bool:
        """Readiness: our own bundle exists AND the port serves that same network.

        Both halves matter. The bundle check means `summarize_build` has values to
        read, so `ready` never persists an empty network summary. The name check
        means an unrelated server holding the port cannot satisfy the probe on this
        deployment's behalf.
        """
        if not self._site_is_ready_to_summarize(dep):
            return False
        host = probe_host(self.settings.deploy_host)
        if not _port_listening(host, dep.port):
            return False
        return _served_network_name(dep.port, host) == dep.name

    def _mark_ready(self, dep: Deployment) -> None:
        sync_shared_byok(dep.work_dir)
        log_text = dep.log_path.read_text(encoding="utf-8", errors="replace") \
            if dep.log_path.is_file() else ""
        dep.network = summarize_build(dep.out_dir, dep.name, log_text)
        dep.warnings = build_warnings(dep.network)
        dep.ready_at = _now()
        dep.status = DeploymentStatus.READY
        self._persist(dep)

    def _fail(self, dep: Deployment, error: str) -> None:
        dep.error = error
        self._teardown(dep, DeploymentStatus.FAILED, error)

    # --- teardown ---------------------------------------------------------
    def _teardown(self, dep: Deployment, status: DeploymentStatus,
                  reason: Optional[str] = None) -> None:
        if dep.process is not None:
            _terminate_tree(dep.process)
        self.ports.release(dep.port)
        dep.status = status
        dep.stopped_at = _now()
        if reason and not dep.error:
            dep.error = reason if status is DeploymentStatus.FAILED else None
        self._persist(dep)

    async def stop(self, dep: Deployment, reason: str = "stopped by request") -> None:
        """
        Stop a live deployment; does nothing if it is not live.

        :param dep: The deployment.
        :param reason: The reason recorded on the deployment.
        """
        if not dep.is_live:
            return
        await asyncio.to_thread(self._teardown, dep, DeploymentStatus.STOPPED, reason)

    async def reap_expired(self) -> List[str]:
        """Stop deployments past their TTL and surface crashed ones. Returns stopped ids."""
        stopped: List[str] = []
        now = _now()
        for dep in self.list():
            if not dep.is_live:
                continue
            if dep.status is DeploymentStatus.READY and dep.process \
                    and dep.process.poll() is not None:
                await asyncio.to_thread(
                    self._fail, dep,
                    f"the deployed site exited unexpectedly with status {dep.process.returncode}",
                )
                continue
            if dep.expires_at and now >= dep.expires_at:
                await self.stop(dep, "expired (TTL reached)")
                stopped.append(dep.id)
        return stopped

    async def forget(self, deployment_id: str) -> bool:
        """Remove a stopped record from the directory entirely.

        Refuses while the deployment is live. Removal is irreversible — it drops the
        record, and with it the URL, the logs and the uploaded HOCON that Restart
        needs — so it should not also be the thing that tears a running site down.
        Stopping first makes that a separate, deliberate step.
        """
        row = self.store.get_deployment(deployment_id)
        if row is not None and DeploymentStatus(row["status"]) in (
                DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.READY):
            raise DeploymentError(
                f"{row['name']} is {row['status']}. Stop it before removing it — "
                f"removal also discards its logs and its uploaded HOCON.")
        with self._lock:
            self._deployments.pop(deployment_id, None)
        return await asyncio.to_thread(self.store.delete_deployment, deployment_id)

    async def shutdown(self) -> None:
        """
        Cancel background tasks, stop live deployments and close the store.
        """
        for task in list(self._tasks):
            task.cancel()
        for dep in self.list():
            if dep.is_live:
                await asyncio.to_thread(
                    self._teardown, dep, DeploymentStatus.STOPPED, "service shutdown")
        await asyncio.to_thread(self.store.close)

    def logs(self, dep: Deployment, limit: int) -> Tuple[List[str], bool]:
        """
        Return the tail of a deployment's log.

        :param dep: The deployment.
        :param limit: The maximum number of lines.
        :return: The lines and whether the log was truncated.
        """
        return _tail(dep.log_path, limit)
