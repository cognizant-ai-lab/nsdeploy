"""Service settings, all overridable from the environment with an NSDEPLOY_SERVICE_ prefix.

Defaults are tuned for a local, single-operator run: the API and every deployed site
bind to loopback, theming is off (it needs a key and adds minutes to a build), and no
API token is required. The hosted phase overrides these — see nsdeploy_service/README.md.
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import List
from typing import Optional
from urllib.parse import urlsplit

ENV_PREFIX = "NSDEPLOY_SERVICE_"

# A DNS label is at most 63 characters. The network slug is capped well below that
# so `{slug}-{id}` always fits without the truncation ever reaching the id — the id
# is the part that makes the hostname unique, so it must survive intact.
SLUG_MAX = 40
LABEL_MAX = 63


def slugify(value: str) -> str:
    """A network name as a DNS label fragment.

    Network names are Python-ish identifiers (`store_order_management_system`) and
    underscores are not legal in hostnames, so they become hyphens.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return slug[:SLUG_MAX].strip("-")


def sanitize_label(label: str) -> str:
    """Force an arbitrary rendered template into something DNS will accept."""
    label = re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9-]+", "-", str(label or "").lower()))
    return label.strip("-")[:LABEL_MAX].strip("-")


# This package. Everything the service owns lives under here, so the whole folder
# can be dropped into any version of nsdeploy without edits on either side.
SERVICE_ROOT = Path(__file__).resolve().parent
# The nsdeploy checkout this service was dropped into. `python -m nsdeploy` is run
# from here so the package and its bundled browser runtime resolve.
REPO_ROOT = SERVICE_ROOT.parent


def _env(name: str, default: str = "") -> str:
    return os.environ.get(ENV_PREFIX + name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{ENV_PREFIX}{name} must be an integer, got {raw!r}") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


def _env_list(name: str, default: List[str]) -> List[str]:
    """A comma-separated setting. Empty entries are dropped, not kept as ''."""
    raw = _env(name)
    if not raw:
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass
class Settings:  # pylint: disable=too-many-instance-attributes; one field per setting
    """Runtime configuration for the deployment service."""

    # --- the service's own listener ---
    host: str = "127.0.0.1"
    port: int = 9000

    # --- where deployed sites listen, and how their URL is spelled ---
    # deploy_host is the address each site's own listener binds, passed through as
    # `nsdeploy --host`. It is independent of public_scheme/public_host, which only
    # shape the URL handed back to the caller — that must match what the browser will
    # actually reach, and is baked into the generated bundle via --site-url.
    #
    # LEAVE THIS AT LOOPBACK. The advice here used to be "in a container it must be
    # 0.0.0.0 or nothing outside can reach the site", which was true of a *bridged*
    # container and cost this project three outages: `--host` is the one flag nsdeploy
    # does not ship, and three successive engine drops removed it. Each time, sites
    # bound container-loopback, Docker's published port forwarded to the container's
    # interface instead, and every URL answered connection refused while the build
    # reported `ready`.
    #
    # Both container shapes that work need no flag at all:
    #   * `docker run --network host` — the container shares the host's network
    #     namespace, so a site on 127.0.0.1 is already on the host's loopback where a
    #     reverse proxy reaches it. No `-p` publishing, no `--host`.
    #   * SUBDOMAIN_TEMPLATE + siteproxy.py — sites stay on loopback and are reached
    #     by hostname through the service's own single port.
    #
    # Setting this to anything else makes the service probe for `--host`
    # (supervisor.engine_supports_host) and refuse the deployment outright if the
    # engine cannot honour it — loudly, rather than serving nothing.
    deploy_host: str = "127.0.0.1"
    public_scheme: str = "http"
    public_host: str = "127.0.0.1"
    # When set, deployments are addressed as <scheme>://<sub>.<public_host> with no
    # port in the URL (a reverse proxy maps the subdomain to the private port).
    # Empty means port-per-deployment URLs, which is the local default.
    subdomain_template: str = ""

    # --- port pool for deployed sites ---
    port_start: int = 8100
    port_end: int = 8199

    # --- filesystem ---
    work_root: Path = field(default_factory=lambda: REPO_ROOT / ".nsdeploy" / "service")
    # Organizations and deployment records. Empty means <work_root>/service.db.
    db_path: Optional[Path] = None
    # The deployment console, inside this package so the whole folder is portable.
    # It consumes only the documented JSON API, so it can still be lifted to a CDN
    # or a separate origin later by pointing UI_DIR elsewhere.
    ui_dir: Path = field(default_factory=lambda: SERVICE_ROOT / "ui")
    python_exe: str = field(default_factory=lambda: sys.executable)

    # --- nsdeploy build options applied to every deployment ---
    upstream: str = "https://api.openai.com/v1"
    facade_upstream: str = ""
    studio: str = ""
    repo: str = ""
    ref: str = ""
    theme: bool = False
    theme_model: str = ""
    # Re-ask the LLM and replace an existing theme rather than reusing one already
    # on disk — nsdeploy's own --theme-refresh, off by default because most builds
    # of the same network want the theme they already have, not a fresh one every
    # deploy.
    theme_refresh: bool = False
    # Extra design instructions folded into the theming prompt — nsdeploy's own
    # --theme-prompt — meaningless unless theme is also on.
    theme_prompt: str = ""
    cruse: bool = True

    # --- map visibility ---
    # Whether a new deployment reaches the map immediately. The console's flow is
    # "type your organization, drop a HOCON, Launch" and then watch the pin appear,
    # so waiting for a separate publish step would make a launch look like it did
    # nothing. Turn this off to restore the explicit draft → POST /publish workflow;
    # both endpoints exist either way, so a network can still be withdrawn.
    autopublish: bool = True

    # --- limits ---
    # Live networks the service will run at once. Must be <= the port pool (validate()
    # enforces that), so the default 8100-8199 range leaves room up to 100.
    #
    # 60 rather than 20 because a team of N people needs headroom above N: at exactly
    # 20, twenty users each deploying one network fill it, and the next upload — or
    # anyone's second network — is refused. Each live deployment costs roughly three
    # processes and ~200 MB (one site, one MCP facade, one host per hosted tool), so
    # measure against your own networks before going much higher.
    max_deployments: int = 60
    # How many builds may run at once. Read into a semaphore when the Supervisor is
    # constructed, so changing it needs a restart, not a POST /settings.
    #
    # 4 rather than 2 because a build is I/O-bound, not CPU-bound: with theming on it
    # spends 30-90s waiting on an HTTP call to the theme model while the CPUs sit idle.
    # Two slots on a workload that is mostly *waiting* leaves throughput unused, and the
    # queue is what a reader feels at event scale.
    #
    # Capped at 4 deliberately. Above the core count the LLM wait still overlaps fine,
    # but a cold build can also `pip install` a tool's dependencies, and several of
    # those at once contend for CPU and disk in a way that has not been measured.
    #
    # Safe to raise because a theme failure is not fatal: propose_theme() catches any
    # exception, logs "using the default look" and returns an empty ThemeSpec, which
    # __main__ turns into `theme or ThemeSpec()`. More concurrent calls hitting a rate
    # limit costs plainer styling on some networks, not a failed deployment.
    max_concurrent_builds: int = 4
    # How many static bundle builds may run at once. A separate bound from the one
    # above, and not the same semaphore, for two reasons: a deployment holds its slot
    # for the whole build *and* the readiness poll (up to BUILD_TIMEOUT_SECONDS), so
    # sharing would queue a two-second bundle behind a cold deployment; and a bundle
    # build runs in this process rather than a child, so what it contends for is this
    # process's thread pool.
    #
    # 4 to match: the work is dominated by resolving includes, which waits on the
    # network, and POST /bundles answers on the open connection, so a deep queue is
    # felt as a timeout rather than as a wait.
    max_concurrent_bundle_builds: int = 4
    build_timeout_seconds: int = 600
    # Deployments are long-lived by design: an org's URL stays up until someone stops
    # it. Set a non-zero TTL only for demo/ephemeral installations.
    ttl_seconds: int = 0
    reap_interval_seconds: int = 30
    # How often the map view re-polls /graph. Served to the UI rather than hardcoded
    # there, so an operator can retune it without editing the frontend. The UI lets a
    # viewer pick a different interval for their own session.
    #
    # 30, not 60: at an event the interesting change is someone else's network arriving
    # or a new link appearing, and a minute of staleness is long enough for a reader to
    # conclude nothing happened and stop watching. The cost is small — /graph is a pure
    # projection over the deployment rows with `suggest=false` (the default), measured
    # at ~20ms for 100 networks and a 58KB payload — so even 100 viewers at this
    # cadence is a few requests a second. The UI caps whatever is advertised here at
    # MAX_MAP_REFRESH_SECONDS, so this can only make the map fresher, never staler.
    map_refresh_seconds: int = 60
    max_hocon_bytes: int = 512 * 1024
    log_tail_default: int = 200

    # --- inferred relations between deployed networks ---
    # Suggestions derived from each network's description (nsdeploy_service/relations.py).
    # The deterministic scorer is the default so the feature needs no key; RELATIONS_LLM
    # asks a model instead and falls back to the scorer on any failure.
    relations_max_per_network: int = 4
    relations_llm: bool = False
    relations_model: str = "gpt-4o"

    # --- build identity, shown in the console header ---
    build_version: str = ""          # empty = fall back to the package version

    # --- access control ---
    api_token: str = ""              # empty = open (fine on loopback only)
    # Lets /console-api add `api_token` to the console's own requests, so the console does not ask
    # for it. The token stays on the server, but anyone can then make those requests (see ConsoleProxy).
    console_proxy: bool = False

    # Origins allowed to call this API from a browser on another host. Empty — the
    # default — installs no CORS middleware at all, so the service answers exactly as
    # it did before: no CORS headers, and a cross-origin page cannot read a response.
    #
    # Needed because the console is served same-origin but other clients are not. A
    # browser app in a separate deployment that builds a bundle here (POST /bundles)
    # is refused by the browser, not by this service, unless its origin is listed.
    #
    # An entry is an origin and nothing else: scheme, host and optional port, with no
    # path and no trailing slash, because that is exactly what a browser puts in the
    # Origin header and the match is literal. validate() refuses anything else rather
    # than letting a silent non-match look like a server fault.
    #
    # "*" is accepted and means any origin. It is not a hole on its own — API_TOKEN
    # still gates every route — but with no token set it lets any page a user visits
    # drive this service from their browser, including over loopback, so /health
    # warns about that combination.
    #
    # Credentials are deliberately NOT allowed (see app.py): this API authenticates
    # with a bearer header, never a cookie, so there is nothing for a browser to
    # attach automatically and no reason to let it.
    cors_origins: List[str] = field(default_factory=list)

    # --- deployment environment ---
    # `/health` warns that https site URLs cannot resolve when the scheme is https and
    # no subdomain template is set, because the platforms this usually runs behind
    # publish a single port. That heuristic reads configuration only — it cannot see a
    # reverse proxy terminating TLS on each port of the pool. Set this when you have
    # actually provided that (nginx, Caddy, a load balancer per port) so the warning
    # stops firing on a configuration that works. It changes nothing else: the warning
    # still appears for anyone who has not.
    tls_terminated_externally: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        """
        Build validated settings from NSDEPLOY_SERVICE_* environment variables.

        :return: The settings, with unset variables taking their defaults.
        :raises ValueError: If a value is malformed or the settings are inconsistent.
        """
        default = cls()
        work_root = _env("WORK_ROOT")
        db_path = _env("DB_PATH")
        ui_dir = _env("UI_DIR")
        settings = cls(
            host=_env("HOST", default.host),
            port=_env_int("PORT", default.port),
            deploy_host=_env("DEPLOY_HOST", default.deploy_host),
            public_scheme=_env("PUBLIC_SCHEME", default.public_scheme),
            public_host=_env("PUBLIC_HOST", default.public_host),
            subdomain_template=_env("SUBDOMAIN_TEMPLATE", default.subdomain_template),
            port_start=_env_int("PORT_START", default.port_start),
            port_end=_env_int("PORT_END", default.port_end),
            work_root=Path(work_root).resolve() if work_root else default.work_root,
            db_path=Path(db_path).resolve() if db_path else None,
            ui_dir=Path(ui_dir).resolve() if ui_dir else default.ui_dir,
            python_exe=_env("PYTHON", default.python_exe),
            upstream=_env("UPSTREAM", default.upstream),
            facade_upstream=_env("FACADE_UPSTREAM", default.facade_upstream),
            studio=_env("STUDIO", default.studio),
            repo=_env("REPO", default.repo),
            ref=_env("REF", default.ref),
            theme=_env_bool("THEME", default.theme),
            theme_model=_env("THEME_MODEL", default.theme_model),
            theme_refresh=_env_bool("THEME_REFRESH", default.theme_refresh),
            theme_prompt=_env("THEME_PROMPT", default.theme_prompt),
            cruse=_env_bool("CRUSE", default.cruse),
            autopublish=_env_bool("AUTOPUBLISH", default.autopublish),
            max_deployments=_env_int("MAX_DEPLOYMENTS", default.max_deployments),
            max_concurrent_builds=_env_int("MAX_CONCURRENT_BUILDS", default.max_concurrent_builds),
            max_concurrent_bundle_builds=_env_int("MAX_CONCURRENT_BUNDLE_BUILDS",
                                                  default.max_concurrent_bundle_builds),
            build_timeout_seconds=_env_int("BUILD_TIMEOUT_SECONDS", default.build_timeout_seconds),
            ttl_seconds=_env_int("TTL_SECONDS", default.ttl_seconds),
            reap_interval_seconds=_env_int("REAP_INTERVAL_SECONDS", default.reap_interval_seconds),
            map_refresh_seconds=_env_int("MAP_REFRESH_SECONDS", default.map_refresh_seconds),
            max_hocon_bytes=_env_int("MAX_HOCON_BYTES", default.max_hocon_bytes),
            log_tail_default=_env_int("LOG_TAIL_DEFAULT", default.log_tail_default),
            relations_max_per_network=_env_int("RELATIONS_MAX_PER_NETWORK",
                                               default.relations_max_per_network),
            relations_llm=_env_bool("RELATIONS_LLM", default.relations_llm),
            relations_model=_env("RELATIONS_MODEL", default.relations_model),
            build_version=_env("BUILD_VERSION", default.build_version),
            api_token=_env("API_TOKEN", default.api_token),
            console_proxy=_env_bool("CONSOLE_PROXY", default.console_proxy),
            cors_origins=_env_list("CORS_ORIGINS", default.cors_origins),
            tls_terminated_externally=_env_bool("TLS_TERMINATED_EXTERNALLY",
                                                default.tls_terminated_externally),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        """
        Check that the settings are mutually consistent.

        :raises ValueError: If a setting is out of range or conflicts with another.
        """
        if self.port_end < self.port_start:
            raise ValueError("PORT_END must be >= PORT_START")
        pool_size = self.port_end - self.port_start + 1
        if self.max_deployments > pool_size:
            raise ValueError(
                f"MAX_DEPLOYMENTS ({self.max_deployments}) exceeds the port pool "
                f"({pool_size} ports in {self.port_start}-{self.port_end})"
            )
        if self.max_concurrent_builds < 1:
            raise ValueError("MAX_CONCURRENT_BUILDS must be >= 1")
        if self.max_concurrent_bundle_builds < 1:
            raise ValueError("MAX_CONCURRENT_BUNDLE_BUILDS must be >= 1")
        self._validate_cors_origins()
        if self.map_refresh_seconds < 5:
            raise ValueError("MAP_REFRESH_SECONDS must be >= 5")
        if self.port_start <= self.port <= self.port_end:
            raise ValueError(
                f"the service port ({self.port}) must not sit inside the deployment "
                f"port pool ({self.port_start}-{self.port_end})"
            )

    def _validate_cors_origins(self) -> None:
        """Refuse a CORS entry no browser could ever match.

        CORSMiddleware compares the Origin header literally, and a browser sends only
        scheme://host[:port] in it. So an entry carrying a path, a wildcard host or
        no scheme matches nothing — and the symptom is a blocked request that reads
        like a fault in this service. Say it at start-up instead.
        """
        if "*" in self.cors_origins and len(self.cors_origins) > 1:
            raise ValueError(
                "CORS_ORIGINS lists '*' alongside named origins; '*' already allows "
                "every origin, so keep one or the other"
            )
        # Each entry, because one unusable line should not be found a request at a time.
        for origin in self.cors_origins:
            if origin != "*":
                self._validate_cors_origin(origin)

    @staticmethod
    def _validate_cors_origin(origin: str) -> None:
        parts = urlsplit(origin.rstrip("/"))
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError(
                f"CORS_ORIGINS entry {origin!r} is not an origin; write it as "
                f"http://host[:port] or https://host[:port]"
            )
        if parts.path or parts.query or parts.fragment:
            raise ValueError(
                f"CORS_ORIGINS entry {origin!r} carries a path, query or fragment. A "
                f"browser sends only scheme://host[:port] as the Origin, so an entry "
                f"with more than that can never match"
            )
        if "@" in parts.netloc or "*" in parts.netloc:
            raise ValueError(
                f"CORS_ORIGINS entry {origin!r} is not a literal origin; a wildcard "
                f"host or embedded credentials are never matched"
            )

    def cors_allowed_origins(self) -> List[str]:
        """The configured origins, spelled the way a browser sends them."""
        allowed: List[str] = []
        # A trailing slash is the usual way to write this and would never match, so
        # it is removed rather than refused.
        for origin in self.cors_origins:
            allowed.append(origin.rstrip("/"))
        return allowed

    def database_path(self) -> Path:
        """
        Return the SQLite database path, defaulting to service.db under the work root.

        :return: The database path.
        """
        return self.db_path or (self.work_root / "service.db")

    def subdomain_label(self, deployment_id: str, port: int, name: str = "") -> str:
        """The per-deployment DNS label, rendered from SUBDOMAIN_TEMPLATE.

        Placeholders: `{id}` (12 hex chars), `{slug}` (the network name as a DNS
        label), `{name}` (alias for slug) and `{port}`. `{slug}-{id}` is the useful
        one: the slug says which network it is, and the id keeps it unique — network
        names are not unique, so a slug on its own would collide.

        Always returns something DNS accepts, falling back to the id if the rendered
        label is unusable. A deployment must not fail to get a URL because a template
        was mis-set, and the id alone is always valid.
        """
        slug = slugify(name)
        try:
            rendered = self.subdomain_template.format(
                id=deployment_id, port=port, slug=slug, name=slug)
        except (KeyError, IndexError, ValueError):
            rendered = deployment_id
        return sanitize_label(rendered) or sanitize_label(deployment_id)

    def site_url(self, deployment_id: str, port: int, name: str = "") -> str:
        """The URL handed to the caller — and baked into the bundle via --site-url.

        nsdeploy writes this origin into <net>.network.json, agent-manifest.json,
        .well-known/* and the MCP tool URLs at build time, so it has to be decided
        before generation and cannot be rewritten afterwards.
        """
        if self.subdomain_template:
            label = self.subdomain_label(deployment_id, port, name)
            return f"{self.public_scheme}://{label}.{self.public_host}"
        return f"{self.public_scheme}://{self.public_host}:{port}"
