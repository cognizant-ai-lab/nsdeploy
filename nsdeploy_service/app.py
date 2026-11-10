# pylint: disable=too-many-lines  # every route is registered inside create_app
"""FastAPI surface for the nsdeploy deployment service.

    POST   /deployments            upload a HOCON  -> 202 {id, status: "queued"}
    GET    /deployments/{id}       poll            -> {status, url, network, warnings}
    GET    /deployments/{id}/wait  block until ready/failed (scripting convenience)
    GET    /deployments/{id}/logs  nsdeploy's own build/serve output
    GET    /deployments/{id}/graph this network's own agent call graph
    GET    /deployments            list everything
    DELETE /deployments/{id}       tear down the process tree, free the port
    GET    /health                 capacity + environment

The flow is asynchronous because a cold build is slow by nature: nsdeploy fetches
the network's includes and coded-tool sources from GitHub and may pip-install a
tool's third-party dependencies before it can serve.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import os
import platform
import re
import sys
import urllib.request
from datetime import datetime
from datetime import timezone
from pathlib import Path
from pathlib import PurePosixPath
from typing import Annotated
from typing import List
from typing import Optional
from urllib.parse import urlsplit

from fastapi import Depends
from fastapi import FastAPI
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from fastapi import Response
from fastapi import UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.responses import JSONResponse
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from nsdeploy_service import PRODUCT_NAME
from nsdeploy_service import __version__
from nsdeploy_service import envfile
from nsdeploy_service import themespec
from nsdeploy_service.bundle_error import BundleError
from nsdeploy_service.bundle_result import BundleResult
from nsdeploy_service.bundler import Bundler
from nsdeploy_service.config import Settings
from nsdeploy_service.models import ORG_NAME_MAX
from nsdeploy_service.models import ORG_NAME_PATTERN
from nsdeploy_service.models import AgentGraphView
from nsdeploy_service.models import BundleOptions
from nsdeploy_service.models import DeploymentList
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeploymentView
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.models import DirectoryOrg
from nsdeploy_service.models import DirectoryView
from nsdeploy_service.models import GraphEdge
from nsdeploy_service.models import GraphNode
from nsdeploy_service.models import GraphView
from nsdeploy_service.models import HealthView
from nsdeploy_service.models import LogView
from nsdeploy_service.models import NetworkSummary
from nsdeploy_service.models import OrgCreate
from nsdeploy_service.models import OrgList
from nsdeploy_service.models import OrgUpdate
from nsdeploy_service.models import OrgView
from nsdeploy_service.models import SettingsUpdate
from nsdeploy_service.models import SettingsView
from nsdeploy_service.models import ThemeSpecApplied
from nsdeploy_service.models import ThemeSpecView
from nsdeploy_service.models import ThemeTokens
from nsdeploy_service.models import ThemeUpdate
from nsdeploy_service.layout import next_position
from nsdeploy_service.models import RelationsView
from nsdeploy_service.models import SuggestedEdge
from nsdeploy_service.relations import ChatFn
from nsdeploy_service.relations import SuggestedRelation
from nsdeploy_service.relations import identities_from_rows
from nsdeploy_service.relations import suggest_relations
from nsdeploy_service.siteproxy import SiteProxy
from nsdeploy_service.store import StoreError
from nsdeploy_service.supervisor import Deployment
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import Supervisor
from nsdeploy_service.supervisor import _iso
from nsdeploy_service.supervisor import _tail as read_log
from nsdeploy_service.supervisor import is_publishable
from nsdeploy_service.supervisor import network_topology
from nsdeploy_service.supervisor import publish_refusal
from nsdeploy_service.trust import ensure_ca_bundle

# Optional drop-in folder: a checkout without it still runs.
try:
    from nsdeploy_service.adminPanel import install as install_admin_panel
except ImportError:
    install_admin_panel = None

WAIT_POLL_SECONDS = 0.4


def read_ui_version(ui_dir: Path) -> str:
    """The `?v=N` the console's index.html pins its assets to.

    Reported on /health so an already-open console can notice it is running older
    code than the server is serving. `Cache-Control: no-cache` on the entry document
    only helps a *fresh* navigation — a tab that was already open when the service
    was updated never re-navigates, so it keeps running the JavaScript it booted
    with. That is indistinguishable from a broken button: a console left open across
    an update reported "I clicked Deploy and nothing happened" while the server had
    long since renamed that button.

    Returns '' when it cannot be determined, which the console treats as "no check"
    rather than as a mismatch — an unreadable version must not nag on every poll.
    """
    try:
        html = (ui_dir / "index.html").read_text(encoding="utf-8")
    except OSError:
        return ""
    found = re.findall(r"\?v=([A-Za-z0-9._-]+)", html)
    # One document pins every asset to the same version; if it ever disagrees with
    # itself, the highest-cardinality answer is meaningless, so report nothing.
    return found[0] if found and len(set(found)) == 1 else ""


class ConsoleFiles(StaticFiles):
    """Serve the console, but make its HTML and its modules always revalidate.

    StaticFiles sends `etag` and `last-modified` and no `Cache-Control`. With no
    explicit freshness a browser falls back to *heuristic* caching — commonly a
    fraction of the document's age — so a console that was open before a release can
    keep serving the previous `index.html` for a long time without asking. A stale
    entry point pins every versioned stylesheet with it, so the console goes stale
    together and only a manual hard reload clears it.

    And the `?v=N` in index.html does not cover the JavaScript. It versions only the
    stylesheets and `main.js`; every module `main.js` imports is fetched at its own
    bare path (`assets/js/views/directory.js`), and those URLs never change between
    releases. Heuristically cached, they outlive a deploy, and the browser then mixes
    new modules with old ones — which surfaces as a bare `SyntaxError` about a
    missing export, leaving the console a blank frame that only a hard reload clears.

    So revalidate both: the entry document and anything executable. `etag` makes the
    revalidation a 304 in the common case, and being correct after a release matters
    more here than saving a conditional request.
    """

    REVALIDATE = ("text/html", "text/javascript", "application/javascript")

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if response.headers.get("content-type", "").startswith(self.REVALIDATE):
            response.headers["Cache-Control"] = "no-cache"
        return response


# Only the deliberate GET /relations?strategy=llm call may wait on a provider; the
# polled map never does.
RELATIONS_LLM_TIMEOUT_SECONDS = 60

# Statuses a published network is drawn on the map in. A pin must either lead
# somewhere or be visibly on its way there, so the live states qualify and the
# terminal ones (failed, stopped) do not — see the filter in GET /graph.
# Only finished deployments get a pin. This once included QUEUED and BUILDING so a
# marker appeared the moment someone pressed Launch — good feedback when one person
# is deploying one network, because a warm build is ~20s of otherwise blank screen.
#
# At event scale it inverts: with dozens of people launching at once the map fills
# with half-built pins that churn on every poll, and the arrival of the one network a
# reader is waiting for is lost in the noise. The launch dialog already covers the
# wait — it watches the build and only opens the map once the site answers — so
# nothing is left unexplained by holding a pin back until it means something.
MAP_STATUSES = (DeploymentStatus.READY,)

# Organization-name rules (ORG_NAME_MAX, ORG_NAME_PATTERN) live in models.py, so the
# upload endpoints here, the /orgs endpoints and the console all enforce one rule.


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _view(dep: Deployment) -> DeploymentView:
    return DeploymentView(
        id=dep.id,
        name=dep.name,
        org_id=dep.org_id,
        org_name=dep.org_name,
        status=dep.status,
        url=dep.url if dep.status is DeploymentStatus.READY else None,
        port=dep.port if dep.is_live else None,
        created_at=_iso(dep.created_at) or "",
        ready_at=_iso(dep.ready_at),
        stopped_at=_iso(dep.stopped_at),
        expires_at=_iso(dep.expires_at),
        error=dep.error,
        pid=dep.pid,
        replaced=dep.replaced,
        # Auto-published on create by default, so this is normally already true and
        # the caller can send the operator straight to the map. With AUTOPUBLISH off
        # it is a draft and the console offers Publish once it reports ready.
        published=bool(dep.published_at),
        published_at=dep.published_at,
        publishable=dep.status is DeploymentStatus.READY and not dep.published_at,
        endpoints=dep.endpoints(),
        network=dep.network,
        warnings=dep.warnings,
        theme=dep.options.theme,
        theme_refresh=dep.options.theme_refresh,
        theme_prompt=dep.options.theme_prompt,
    )


def _row_view(row: dict, settings: Settings) -> DeploymentView:  # pylint: disable=unused-argument; shared call shape
    """Build a view from a persisted row — the read path for list/get/directory.

    Records outlive the processes they describe (and the service itself), so this must
    work without any in-memory Deployment. `endpoints` is derived rather than stored,
    since it is a pure function of a ready site's URL.
    """
    status = DeploymentStatus(row["status"])
    url = row.get("url")
    endpoints: dict = {}
    if status is DeploymentStatus.READY and url:
        base = url.rstrip("/")
        endpoints = {
            "site": f"{base}/",
            "mock_llm": f"{base}/v1/chat/completions",
            "byok_proxy": f"{base}/byok/v1/chat/completions",
            "mcp_facade": f"{base}/mcp",
            "agent_manifest": f"{base}/agent-manifest.json",
            "well_known": f"{base}/.well-known/nsdeploy-agent.json",
        }
    network = row.get("network")
    options = row.get("options") or {}
    return DeploymentView(
        id=row["id"], name=row["name"],
        org_id=row["org_id"], org_name=row.get("org_name", ""),
        status=status, url=url, port=row.get("port"),
        created_at=row["created_at"], ready_at=row.get("ready_at"),
        stopped_at=row.get("stopped_at"), expires_at=row.get("expires_at"),
        error=row.get("error"), pid=row.get("pid"),
        published=bool(row.get("published_at")),
        published_at=row.get("published_at"),
        publishable=is_publishable(row),
        publish_blocked_reason=(
            None if row.get("published_at") or is_publishable(row)
            else publish_refusal(row)),
        endpoints=endpoints,
        network=NetworkSummary(**network) if isinstance(network, dict) else None,
        warnings=row.get("warnings") or [],
        theme=options.get("theme"),
        theme_refresh=options.get("theme_refresh"),
        theme_prompt=options.get("theme_prompt"),
    )


def _tokens(spec) -> ThemeTokens:
    """A ThemeSpec's editable fields, for the console's design editor.

    Narrower than the spec on purpose: `welcome` and the model-authored
    `body`/`style` are not an operator's to edit here, so they are not offered
    for editing — see themespec.py.
    """
    return ThemeTokens(
        brand=spec.brand, icon=spec.icon, tagline=spec.tagline, hero=spec.hero,
        font=spec.font, radius=spec.radius, colors=dict(spec.colors),
    )


# A bundle build reports its caveats in a response header, because the body of that
# response is the bundle itself. No ceiling on a header is documented, but every
# proxy enforces one — commonly 8 KB for the whole block — so the list is trimmed
# rather than risking a 431 on a build that did produce a bundle. json.dumps escapes
# non-ASCII, which keeps the value inside what a header is allowed to carry.
MAX_BUNDLE_WARNING_HEADER_CHARS = 2000


def _bundle_warning_header(warnings: List[str]) -> str:
    """The warnings as a JSON header value, trimmed to what a proxy will carry."""
    shown: List[str] = list(warnings)
    listed: List[str] = list(shown)
    encoded: str = json.dumps(listed)
    dropped: int = 0
    # Drop the last line and say how many are missing, until the value fits.
    while shown and len(encoded) > MAX_BUNDLE_WARNING_HEADER_CHARS:
        shown.pop()
        dropped = len(warnings) - len(shown)
        listed = list(shown)
        listed.append(f"...and {dropped} more")
        encoded = json.dumps(listed)
    return encoded


def _bundle_headers(result: BundleResult) -> dict:
    """What a bundle build produced, for a response whose body is the archive."""
    headers = {
        "Content-Disposition": f'attachment; filename="{result.name}.tar.gz"',
        "X-Bundle-Name": result.name,
        "X-Bundle-Files": str(result.files),
        "X-Bundle-Unpacked-Bytes": str(result.unpacked_bytes),
        "X-Bundle-Sha256": result.sha256,
    }
    if result.warnings:
        headers["X-Bundle-Warnings"] = _bundle_warning_header(result.warnings)
    return headers


def _suggested_edge(relation: SuggestedRelation) -> SuggestedEdge:
    return SuggestedEdge(
        source=relation.source, target=relation.target, kind=relation.kind,
        score=relation.score, reason=relation.reason,
        reference=relation.reference, origin=relation.origin,
    )


def _relations_chat(settings: Settings) -> Optional[ChatFn]:
    """An OpenAI-compatible transport for the LLM relation strategy, or None.

    Kept here rather than in relations.py so that module stays pure and testable
    without a provider: composition (credentials, endpoint) belongs to the app layer.
    The deploy-time key is read from the environment, never from a request.
    """
    if not settings.relations_llm:
        return None
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        return None
    upstream = (settings.upstream or "https://api.openai.com/v1").rstrip("/")
    model = settings.relations_model

    def chat(system: str, user: str) -> str:
        payload = {
            "model": model, "stream": False,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }
        request = urllib.request.Request(
            f"{upstream}/chat/completions",
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {api_key}"},
        )
        with urllib.request.urlopen(request, timeout=RELATIONS_LLM_TIMEOUT_SECONDS) as response:
            body = json.loads(response.read().decode("utf-8"))
        return body["choices"][0]["message"]["content"]

    return chat


def _org_view(row: dict) -> OrgView:
    return OrgView(
        id=row["id"], name=row["name"], address=row.get("address", ""),
        contact=row.get("contact", ""), created_at=row["created_at"],
        deployment_count=row.get("deployment_count", 0),
        live_count=row.get("live_count", 0),
    )


async def _warm_studio(bundler: Bundler) -> None:
    """Cache the studio's git tree once, before any build needs it.

    Every deployment resolves its `include` lines in its own child process, so the
    only thing a burst can share is the on-disk listing. Cold, each process misses
    it before any has written it and spends one api.github.com call — 60 an hour
    per IP unauthenticated, after which includes stop resolving altogether. One
    call here serves every build that follows.

    A task rather than part of start-up: the fetch can take seconds, and a service
    that cannot answer its own health probe because GitHub is slow is worse than
    one whose first build pays for the listing itself. Nothing waits on the result.

    :param bundler: The bundler, which owns how a studio source is chosen.
    """
    source = bundler.studio_source()
    await asyncio.to_thread(source.warm_tree)


# pylint: disable-next=too-many-locals,too-many-statements  # routes are closures over settings and app
def create_app(settings: Optional[Settings] = None) -> FastAPI:
    """
    Build the FastAPI application with every route, middleware and the site proxy.

    :param settings: The service settings, or None to read them from the environment.
    :return: The ASGI application.
    :raises ValueError: If settings are read from the environment and are invalid.
    """
    settings = settings or Settings.from_env()
    # Configure TLS trust here rather than only in __main__, so an ASGI server
    # importing `app` directly (uvicorn/gunicorn in a container) gets it too.
    # Service-owned, so this works against an unmodified nsdeploy; the build
    # subprocesses get it via _bootstrap/sitecustomize.py instead.
    ensure_ca_bundle()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):  # pylint: disable=redefined-outer-name; FastAPI passes the app
        # Built inside the loop so the build semaphore binds to the right one.
        app.state.settings = settings
        app.state.supervisor = Supervisor(settings)
        # Same reason as the Supervisor: its semaphore binds to this loop.
        app.state.bundler = Bundler(settings)
        if app.state.supervisor.orphaned:
            print(f"reconciled {len(app.state.supervisor.orphaned)} deployment record(s) "
                  f"left live by a previous run", file=sys.stderr)
        if app.state.supervisor.resummarized:
            print(f"rebuilt the network summary for {len(app.state.supervisor.resummarized)} "
                  f"deployment record(s) from their generated bundle", file=sys.stderr)
        reaper = asyncio.create_task(_reaper(app.state.supervisor), name="ttl-reaper")
        # Fire and forget. Held only so the task is not garbage collected while
        # it runs, and cancelled with everything else on shutdown.
        warming = asyncio.create_task(_warm_studio(app.state.bundler), name="warm-studio")
        try:
            yield
        finally:
            reaper.cancel()
            warming.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            with contextlib.suppress(asyncio.CancelledError):
                await warming
            # Never leave orphaned site/tool/facade processes holding ports.
            await app.state.supervisor.shutdown()

    async def _reaper(supervisor: Supervisor) -> None:
        interval = max(5, supervisor.settings.reap_interval_seconds)
        while True:
            await asyncio.sleep(interval)
            with contextlib.suppress(Exception):
                await supervisor.reap_expired()

    app = FastAPI(  # pylint: disable=redefined-outer-name; module-level `app` is this function's result
        title=PRODUCT_NAME,
        version=__version__,
        summary="Deploy a neuro-san agent-network HOCON as a live website over HTTP.",
        lifespan=lifespan,
    )

    # --- cross-origin access ----------------------------------------------
    # Installed only when CORS_ORIGINS names something. With it empty the middleware
    # is not added at all, so the service answers byte for byte as it did before:
    # no Vary, no Access-Control-* on any response.
    #
    # allow_credentials stays False. Every route is gated by a bearer header, never
    # by a cookie, so there is nothing a browser would attach on its own — and
    # allowing credentials would forbid "*" outright and turn a listed origin into a
    # standing invitation to act as whoever is signed in.
    #
    # The exposed list is what a cross-origin caller actually has to read. A browser
    # hides every other response header, so a bundle fetched from another origin
    # would otherwise arrive with its name, digest and warnings reading as null.
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_allowed_origins(),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type"],
            expose_headers=[
                "Location",
                "Content-Disposition",
                "X-Bundle-Name",
                "X-Bundle-Files",
                "X-Bundle-Unpacked-Bytes",
                "X-Bundle-Sha256",
                "X-Bundle-Warnings",
            ],
            max_age=600,
        )

    def require_token(request: Request) -> None:
        """Bearer-token gate. Disabled when no token is configured (loopback default)."""
        if not settings.api_token:
            return
        header = request.headers.get("Authorization", "")
        scheme, _, value = header.partition(" ")
        if scheme.lower() != "bearer" or value.strip() != settings.api_token:
            raise HTTPException(status_code=401, detail="a valid bearer token is required")

    # Applied per route rather than as a parameter: the gate injects nothing into the
    # handler, and a route-level dependency keeps it out of the OpenAPI parameter list.
    AUTH = [Depends(require_token)]  # pylint: disable=invalid-name; route-level constant

    def supervisor_of(request: Request) -> Supervisor:
        return request.app.state.supervisor

    def bundler_of(request: Request) -> Bundler:
        return request.app.state.bundler

    def find_row(request: Request, deployment_id: str) -> dict:
        row = supervisor_of(request).store.get_deployment(deployment_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no deployment {deployment_id!r}")
        return row

    def find_org(request: Request, org_id: str) -> dict:
        org = supervisor_of(request).store.get_org(org_id)
        if org is None:
            raise HTTPException(status_code=404, detail=f"no organization {org_id!r}")
        return org

    @app.exception_handler(DeploymentError)
    async def _deployment_error(_: Request, exc: DeploymentError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(BundleError)
    async def _bundle_error(_: Request, exc: BundleError) -> JSONResponse:
        # Same reading as DeploymentError: a request the caller can correct.
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(StoreError)
    async def _store_error(_: Request, exc: StoreError) -> JSONResponse:
        # Duplicate org name / org still owning deployments: a conflict with existing
        # state rather than a malformed request.
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    # --- create ----------------------------------------------------------
    async def _accept(request: Request, hocon: bytes, options: DeployOptions) -> DeploymentView:
        supervisor = supervisor_of(request)
        dep = supervisor.create(hocon, options)
        supervisor.start(dep)
        return _view(dep)

    @app.post("/deployments", status_code=202, response_model=DeploymentView,
              dependencies=AUTH, summary="Deploy a HOCON (multipart upload)")
    # pylint: disable-next=too-many-arguments,too-many-positional-arguments,too-many-locals  # one per form field
    async def deploy(
        request: Request,
        response: Response,
        file: Annotated[UploadFile, File(description="the agent-network .hocon")],
        org_id: Annotated[Optional[str], Form(
            description="owning organization by id; omit to attribute to 'Unattributed'")] = None,
        # ORG_NAME_MAX, because this field had no bound and creates a row on first use.
        # A deployment arrived with the service's own API token pasted in here — 48
        # characters, which then rendered as an organization in the directory, the
        # filter dropdown and the map's hover callout, and stretched the filter until
        # the control bar wrapped. The limit stops the layout damage and the junk rows;
        # it is NOT a secret-detection measure, and a shorter credential would still
        # pass.
        org_name: Annotated[Optional[str], Form(
            max_length=ORG_NAME_MAX, pattern=ORG_NAME_PATTERN,
            description="owning organization by name, created on first use; ignored "
                        "when org_id is given. Letters, digits and & ' ( ) . , - / + # "
                        f"only, {ORG_NAME_MAX} characters maximum")] = None,
        name: Annotated[Optional[str], Form()] = None,
        upstream: Annotated[Optional[str], Form()] = None,
        theme: Annotated[Optional[bool], Form()] = None,
        theme_model: Annotated[Optional[str], Form()] = None,
        theme_refresh: Annotated[Optional[bool], Form()] = None,
        theme_prompt: Annotated[Optional[str], Form(max_length=4000)] = None,
        cruse: Annotated[Optional[bool], Form()] = None,
        ttl_seconds: Annotated[Optional[int], Form(ge=0)] = None,
    ) -> DeploymentView:
        # An explicit name is validated verbatim so a bad one is rejected, not renamed.
        # An upload filename may legitimately arrive as a full path from older clients,
        # so basename that — but only that, and only here where it is intended.
        candidate = name.strip() if name and name.strip() else PurePosixPath(
            (file.filename or "network").replace("\\", "/")).name
        options = DeployOptions(
            name=candidate, org_id=org_id, org_name=org_name,
            upstream=upstream, theme=theme, theme_model=theme_model,
            theme_refresh=theme_refresh, theme_prompt=theme_prompt,
            cruse=cruse, ttl_seconds=ttl_seconds,
        )
        view = await _accept(request, await file.read(), options)
        response.headers["Location"] = f"/deployments/{view.id}"
        return view

    @app.post("/deployments/raw", status_code=202, response_model=DeploymentView,
              dependencies=AUTH, summary="Deploy a HOCON posted as a raw request body")
    # pylint: disable-next=too-many-arguments,too-many-positional-arguments  # one parameter per form field
    async def deploy_raw(
        request: Request,
        response: Response,
        name: Annotated[str, Query(description="network name (becomes the HOCON filename stem)")],
        org_id: Annotated[Optional[str], Query()] = None,
        org_name: Annotated[Optional[str], Query(
            max_length=ORG_NAME_MAX, pattern=ORG_NAME_PATTERN,
            description="owning organization by name, created on first use. Letters, "
                        "digits and & ' ( ) . , - / + # only, "
                        f"{ORG_NAME_MAX} characters maximum")] = None,
        upstream: Annotated[Optional[str], Query()] = None,
        theme: Annotated[Optional[bool], Query()] = None,
        theme_model: Annotated[Optional[str], Query()] = None,
        cruse: Annotated[Optional[bool], Query()] = None,
        ttl_seconds: Annotated[Optional[int], Query(ge=0)] = None,
    ) -> DeploymentView:
        options = DeployOptions(name=name, org_id=org_id, org_name=org_name,
                                upstream=upstream, theme=theme,
                                theme_model=theme_model, cruse=cruse,
                                ttl_seconds=ttl_seconds)
        view = await _accept(request, await request.body(), options)
        response.headers["Location"] = f"/deployments/{view.id}"
        return view

    # --- organizations ----------------------------------------------------
    @app.post("/orgs", status_code=201, response_model=OrgView, dependencies=AUTH,
              summary="Create an organization profile")
    async def create_org(request: Request, payload: OrgCreate) -> OrgView:
        store = supervisor_of(request).store
        row = store.create_org(payload.name, payload.address, payload.contact)
        return _org_view({**row, "deployment_count": 0, "live_count": 0})

    @app.get("/orgs", response_model=OrgList, dependencies=AUTH,
             summary="List organizations with deployment counts")
    async def list_orgs(request: Request) -> OrgList:
        rows = supervisor_of(request).store.list_orgs()
        return OrgList(organizations=[_org_view(row) for row in rows])

    @app.get("/orgs/{org_id}", response_model=OrgView, dependencies=AUTH,
             summary="One organization")
    async def get_org(request: Request, org_id: str) -> OrgView:
        return _org_view(find_org(request, org_id))

    @app.patch("/orgs/{org_id}", response_model=OrgView, dependencies=AUTH,
               summary="Update an organization profile")
    async def update_org(request: Request, org_id: str, payload: OrgUpdate) -> OrgView:
        store = supervisor_of(request).store
        find_org(request, org_id)
        updated = store.update_org(org_id, **payload.model_dump(exclude_none=True))
        if updated is None:
            raise HTTPException(status_code=404, detail=f"no organization {org_id!r}")
        return _org_view(updated)

    @app.delete("/orgs/{org_id}", status_code=204, dependencies=AUTH,
                summary="Delete an organization that owns no deployment records")
    async def delete_org(request: Request, org_id: str) -> Response:
        find_org(request, org_id)
        supervisor_of(request).store.delete_org(org_id)
        return Response(status_code=204)

    @app.get("/orgs/{org_id}/deployments", response_model=DeploymentList, dependencies=AUTH,
             summary="One organization's deployments")
    async def org_deployments(request: Request, org_id: str) -> DeploymentList:
        find_org(request, org_id)
        return _deployment_list(request, org_id=org_id)

    # --- directory --------------------------------------------------------
    @app.get("/directory", response_model=DirectoryView, dependencies=AUTH,
             summary="Every organization and the agent networks it has deployed")
    async def directory(
        request: Request,
        live_only: Annotated[bool, Query(description="hide stopped and failed records")] = False,
    ) -> DirectoryView:
        supervisor = supervisor_of(request)
        orgs = supervisor.store.list_orgs()
        rows = supervisor.store.list_deployments()
        grouped: dict = {org["id"]: [] for org in orgs}
        for row in rows:
            view = _row_view(row, settings)
            if live_only and view.status not in (
                    DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.READY):
                continue
            grouped.setdefault(row["org_id"], []).append(view)
        entries = [
            DirectoryOrg(organization=_org_view(org), deployments=grouped.get(org["id"], []))
            for org in orgs
        ]
        return DirectoryView(
            organizations=entries,
            totals={
                "organizations": len(entries),
                "deployments": sum(len(e.deployments) for e in entries),
                "ready": sum(1 for e in entries for d in e.deployments
                             if d.status is DeploymentStatus.READY),
            },
        )

    # --- map --------------------------------------------------------------
    def _origin_of(url: str) -> str:
        """Scheme+host+port of a URL, for matching a link target back to a node."""
        parsed = urlsplit(url)
        return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme else ""

    @app.get("/graph", response_model=GraphView, dependencies=AUTH,
             summary="Deployed networks and the links between them, as a map")
    async def graph(  # pylint: disable=too-many-locals; builds nodes and edges in one pass
        request: Request,
        org_id: Annotated[Optional[str], Query(description="filter to one organization")] = None,
        # pylint: disable-next=unused-argument  # accepted so existing /graph callers do not break
        live_only: Annotated[bool, Query(description="hide stopped and failed nodes")] = False,
        suggest: Annotated[bool, Query(
            description="also infer suggested relations (slow on a large map)")] = False,
    ) -> GraphView:
        supervisor = supervisor_of(request)
        if org_id:
            find_org(request, org_id)
        rows = supervisor.store.list_deployments(org_id=org_id)

        # A link target is an absolute URL; map it back to whichever node serves that
        # origin. Targets outside this service (a peer run elsewhere) cannot become an
        # edge, so they are counted on the source node instead of silently dropped.
        by_origin = {
            _origin_of(row["url"]): row["id"]
            for row in rows if row.get("url")
        }

        nodes: List[GraphNode] = []
        edges: List[GraphEdge] = []
        placed: List[dict] = []
        visible: List[dict] = []
        for row in rows:
            status = DeploymentStatus(row["status"])
            # The map shows published networks that finished building — see
            # MAP_STATUSES above for why queued and building are held back at event
            # scale, and why the launch dialog rather than the map covers the wait.
            #
            # Terminal records also stay off. A stopped one is a deliberate
            # withdrawal, and a failed build has no site at all, so its pin would
            # lead nowhere; the launch screen reports that failure with the build log
            # instead. Restarting puts the pin back without publishing again.
            # `live_only` is subsumed by this and kept only so existing callers of
            # /graph do not break.
            if not row.get("published_at") or status not in MAP_STATUSES:
                continue
            visible.append(row)
            summary = row.get("network") or {}
            # Both ways of calling a peer count as an edge. A slot-bound link arrives
            # as `links`; a URL written straight into an agent's `tools` arrives as
            # `peer_urls`, because nsdeploy reports those as external_networks and
            # never as linking.imports. Treating only the first as real left a
            # network that was wired up with plain URLs looking unconnected.
            links = list(summary.get("links") or []) + list(summary.get("peer_urls") or [])
            external = 0
            for link in links:
                target_id = by_origin.get(_origin_of(link.get("target", "")))
                if target_id and target_id != row["id"]:
                    edges.append(GraphEdge(
                        source=row["id"], target=target_id,
                        reference=link.get("reference", ""),
                        callers=link.get("callers") or [],
                    ))
                else:
                    external += 1

            # Positions are backfilled at startup, so a stored one is the norm. The
            # fallback only covers a record written between backfill and now; it is
            # not persisted here because GET must not mutate.
            position = row.get("position") or next_position(placed)
            placed.append(position)
            nodes.append(GraphNode(
                id=row["id"], name=row["name"],
                org_id=row["org_id"], org_name=row.get("org_name", ""),
                status=status, url=row.get("url"),
                x=position["x"], y=position["y"],
                front_man=summary.get("front_man", ""),
                agent_count=summary.get("agent_count", 0),
                description=summary.get("description", ""),
                hosted_tools=len(summary.get("hostable_tools") or []),
                open_slots=len(summary.get("link_slots") or []),
                external_links=external,
                warnings=len(row.get("warnings") or []),
            ))

        # OFF BY DEFAULT, because it dominates the response and nothing in the console
        # reads the result. Measured on a 100-network map: list_deployments 3ms,
        # identities_from_rows 686ms, suggest_relations 3686ms — so ~4.4s of a ~4.4s
        # request went on 300 suggestions that views/map.js discards
        # (SHOW_SUGGESTED_EDGES is false, and the admin panel's show_suggested_edges
        # only injects CSS to hide what was never drawn). The scorer is pairwise, so
        # the cost grows with the square of the map and this is exactly the scale an
        # event runs at.
        #
        # Still available on request — `?suggest=true` — and GET /relations is
        # unchanged, including its deliberate one-off LLM strategy. Inference here is
        # the deterministic scorer only even when asked for: a provider call must
        # never land on a path the map polls.
        suggested: List = []
        if suggest:
            suggested, _ = suggest_relations(
                identities_from_rows(visible),
                max_per_network=settings.relations_max_per_network,
            )

        return GraphView(
            nodes=nodes,
            edges=edges,
            suggested_edges=[_suggested_edge(item) for item in suggested],
            organizations=[_org_view(org) for org in supervisor.store.list_orgs()],
            refresh_seconds=settings.map_refresh_seconds,
            totals={
                "nodes": len(nodes),
                "edges": len(edges),
                "suggested_edges": len(suggested),
                "ready": sum(1 for node in nodes if node.status is DeploymentStatus.READY),
                "organizations": len({node.org_id for node in nodes}),
            },
            generated_at=_iso(_utcnow()) or "",
        )

    @app.get("/relations", response_model=RelationsView, dependencies=AUTH,
             summary="Relations between deployed networks, inferred from their descriptions")
    async def relations(
        request: Request,
        org_id: Annotated[Optional[str], Query(description="filter to one organization")] = None,
        live_only: Annotated[bool, Query(description="ignore stopped and failed records")] = False,
        strategy: Annotated[str, Query(
            description="heuristic (default, deterministic, no key) or llm "
                        "(needs RELATIONS_LLM and OPENAI_API_KEY; falls back to "
                        "heuristic on any failure)")] = "heuristic",
    ) -> RelationsView:
        supervisor = supervisor_of(request)
        if org_id:
            find_org(request, org_id)
        rows = supervisor.store.list_deployments(org_id=org_id)
        if live_only:
            rows = [row for row in rows
                    if DeploymentStatus(row["status"]) in (DeploymentStatus.QUEUED,
                                                           DeploymentStatus.BUILDING,
                                                           DeploymentStatus.READY)]
        chat = _relations_chat(settings) if strategy == "llm" else None

        def infer():
            # Loading identities reads each bundle from disk and the LLM strategy is a
            # network call, so both stay off the event loop.
            identities = identities_from_rows(rows)
            suggested, used = suggest_relations(
                identities, chat=chat,
                max_per_network=settings.relations_max_per_network)
            return identities, suggested, used

        identities, suggested, used = await asyncio.to_thread(infer)
        return RelationsView(
            edges=[_suggested_edge(item) for item in suggested],
            strategy=used,
            networks=len(identities),
            generated_at=_iso(_utcnow()) or "",
        )

    # --- read ------------------------------------------------------------
    def _deployment_list(request: Request, org_id: Optional[str] = None) -> DeploymentList:
        supervisor = supervisor_of(request)
        rows = supervisor.store.list_deployments(org_id=org_id)
        return DeploymentList(
            deployments=[_row_view(row, settings) for row in rows],
            capacity={
                "live": sum(1 for d in supervisor.list() if d.is_live),
                "max_deployments": settings.max_deployments,
                "ports_reserved": sorted(supervisor.ports.reserved()),
                "port_range": f"{settings.port_start}-{settings.port_end}",
            },
        )

    @app.get("/deployments", response_model=DeploymentList, dependencies=AUTH,
             summary="List deployments")
    async def list_deployments(
        request: Request,
        org_id: Annotated[Optional[str], Query(description="filter to one organization")] = None,
    ) -> DeploymentList:
        if org_id:
            find_org(request, org_id)
        return _deployment_list(request, org_id=org_id)

    @app.get("/deployments/{deployment_id}", response_model=DeploymentView,
             dependencies=AUTH, summary="Poll one deployment")
    async def get_deployment(request: Request, deployment_id: str) -> DeploymentView:
        # Read from the store so records survive a restart of this service.
        row = supervisor_of(request).store.get_deployment(deployment_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no deployment {deployment_id!r}")
        return _row_view(row, settings)

    @app.get("/deployments/{deployment_id}/wait", response_model=DeploymentView,
             dependencies=AUTH, summary="Block until the deployment is ready or failed")
    async def wait_deployment(
        request: Request,
        deployment_id: str,
        timeout: Annotated[int, Query(ge=1, le=1800)] = 600,
    ) -> DeploymentView:
        dep = supervisor_of(request).get(deployment_id)
        if dep is None:
            # Not in memory: either unknown, or a record from before a restart — in
            # which case reconciliation already settled it, so there is nothing to await.
            return _row_view(find_row(request, deployment_id), settings)

        async def settled() -> None:
            while dep.is_live and dep.status is not DeploymentStatus.READY:
                await asyncio.sleep(WAIT_POLL_SECONDS)

        try:
            await asyncio.wait_for(settled(), timeout=timeout)
        except asyncio.TimeoutError:
            # Not an error: the build may still be running. Report current state.
            return JSONResponse(status_code=504, content=_view(dep).model_dump(mode="json"))
        return _view(dep)

    @app.get("/deployments/{deployment_id}/logs", response_model=LogView,
             dependencies=AUTH, summary="nsdeploy's build and serve output")
    async def get_logs(
        request: Request,
        deployment_id: str,
        tail: Annotated[Optional[int], Query(
            ge=0, le=5000,
            description="last N lines; 0 for the whole log; omit for the service default",
        )] = None,
    ) -> LogView:
        # The log path is persisted, so a previous run's build output stays readable.
        row = find_row(request, deployment_id)
        # Omitted is distinct from 0: omitted means "the service default", 0 means
        # "everything". A failed build's log can run to thousands of lines, so the
        # default is deliberately bounded.
        limit = settings.log_tail_default if tail is None else tail
        lines, truncated = read_log(Path(row["log_path"]), limit)
        return LogView(id=row["id"], status=DeploymentStatus(row["status"]),
                       lines=lines, truncated=truncated)

    @app.get("/deployments/{deployment_id}/graph", response_model=AgentGraphView,
             dependencies=AUTH, summary="This network's own agent call graph")
    async def get_network_graph(request: Request, deployment_id: str) -> AgentGraphView:
        # Read from the generated bundle, same as the build summary — nothing here
        # re-parses the original HOCON, and the topology outlives the build process.
        row = find_row(request, deployment_id)
        network = row.get("network") or {}
        front_man = network.get("front_man", "")
        out_dir = Path(row["work_dir"]) / "site"
        nodes, edges = network_topology(out_dir, row["name"], front_man)
        if not nodes:
            raise HTTPException(
                status_code=409,
                detail="no agent topology yet — the build has not produced one",
            )
        return AgentGraphView(
            id=row["id"], name=row["name"], front_man=front_man, nodes=nodes, edges=edges,
        )

    @app.post("/deployments/{deployment_id}/restart", status_code=202,
              response_model=DeploymentView, dependencies=AUTH,
              summary="Relaunch a stopped or failed deployment from its stored HOCON")
    async def restart_deployment(request: Request, deployment_id: str) -> DeploymentView:
        supervisor = supervisor_of(request)
        find_row(request, deployment_id)
        # Same record id and, where possible, the same port — so the site's URL
        # survives the relaunch. Options are replayed from the original deploy.
        dep = supervisor.restart(deployment_id)
        supervisor.start(dep)
        return _view(dep)

    @app.post("/deployments/{deployment_id}/theme", status_code=202,
              response_model=DeploymentView, dependencies=AUTH,
              summary="Edit this deployment's theme options and relaunch it with them")
    async def update_theme(
        request: Request, deployment_id: str, body: ThemeUpdate,
    ) -> DeploymentView:
        supervisor = supervisor_of(request)
        find_row(request, deployment_id)
        # Unlike plain restart, this one is meant to work on a network that is
        # currently live — "change the theme" implies it already has one — so stop
        # it first rather than making the edit refuse with "already ready", same as
        # DELETE does above.
        live = supervisor.get(deployment_id)
        if live is not None:
            await supervisor.stop(live, "restarting with edited theme")
        # Same mechanism as a plain restart — see Supervisor.restart — except the
        # edited fields are folded into the replayed options first and, since a
        # restart persists whatever options it ends up running with, they stick for
        # every restart after this one too.
        dep = supervisor.restart(deployment_id, overrides=body.model_dump(exclude_none=True))
        supervisor.start(dep)
        return _view(dep)

    @app.get("/deployments/{deployment_id}/theme-spec", response_model=ThemeSpecView,
             dependencies=AUTH, summary="This deployment's editable theme tokens")
    async def get_theme_spec(request: Request, deployment_id: str) -> ThemeSpecView:
        row = find_row(request, deployment_id)
        work_dir = Path(row["work_dir"])
        spec, source = themespec.read_spec(work_dir)
        out_dir, _ = themespec.site_paths(work_dir)
        return ThemeSpecView(
            current=_tokens(spec),
            defaults=ThemeTokens(**themespec.defaults()),
            source=source,
            has_custom_layout=themespec.has_custom_layout(work_dir),
            built=(out_dir / "theme.css").is_file(),
            live=supervisor_of(request).get(deployment_id) is not None,
        )

    @app.post("/deployments/{deployment_id}/theme-spec", response_model=ThemeSpecApplied,
              dependencies=AUTH,
              summary="Restyle this deployment in place — no model call, no rebuild")
    async def apply_theme_spec(
        request: Request, deployment_id: str, body: ThemeTokens,
    ) -> ThemeSpecApplied:
        # Deliberately not 202 and deliberately not a relaunch: this rewrites the
        # built stylesheet and manifest, and a deployed site reads both off disk
        # per request, so the work is already done when this returns. The record
        # is untouched — nothing to poll, nothing to wait for.
        row = find_row(request, deployment_id)
        spec, applied = themespec.apply_tokens(
            Path(row["work_dir"]), body.model_dump(exclude_none=True),
        )
        return ThemeSpecApplied(current=_tokens(spec), applied_live=applied)

    # --- publish ---------------------------------------------------------
    @app.post("/deployments/{deployment_id}/publish", response_model=DeploymentView,
              dependencies=AUTH, summary="Put a tested network on the map")
    async def publish_deployment(request: Request, deployment_id: str) -> DeploymentView:
        # Deploying no longer puts a network on the map: it is built and testable at
        # its own URL first, and appears only once its owner publishes it. Idempotent,
        # and refuses anything that is not ready.
        find_row(request, deployment_id)
        return _row_view(supervisor_of(request).publish(deployment_id), settings)

    @app.post("/deployments/{deployment_id}/unpublish", response_model=DeploymentView,
              dependencies=AUTH, summary="Take a network off the map")
    async def unpublish_deployment(request: Request, deployment_id: str) -> DeploymentView:
        # The deployment keeps running; only its pin goes away. Idempotent.
        find_row(request, deployment_id)
        return _row_view(supervisor_of(request).unpublish(deployment_id), settings)

    # --- delete ----------------------------------------------------------
    @app.delete("/deployments/{deployment_id}", response_model=DeploymentView,
                dependencies=AUTH, summary="Tear down a deployment and free its port")
    async def delete_deployment(
        request: Request,
        deployment_id: str,
        purge: Annotated[bool, Query(
            description="also remove the record from the directory")] = False,
    ) -> DeploymentView:
        supervisor = supervisor_of(request)
        row = find_row(request, deployment_id)
        # Checked before stopping, not after: otherwise this method would stop the
        # site as a side effect of a request it is about to reject, and "cannot
        # remove a running deployment" would have already taken it down.
        if purge and DeploymentStatus(row["status"]) in (
                DeploymentStatus.QUEUED, DeploymentStatus.BUILDING, DeploymentStatus.READY):
            raise DeploymentError(
                f"{row['name']} is {row['status']}. Stop it before removing it — "
                f"removal also discards its logs and its uploaded HOCON.")
        dep = supervisor.get(deployment_id)
        if dep is not None:
            await supervisor.stop(dep)
            row = find_row(request, deployment_id)
        view = _row_view(row, settings)
        if purge:
            await supervisor.forget(deployment_id)
        return view

    # --- static bundles --------------------------------------------------
    # A separate resource from a deployment, because a static bundle is a build
    # product and not a process: it has no port, no lifecycle, no place on the map
    # and no record. It is built, handed over and forgotten, so everything here is
    # answered on the open connection and nothing reaches the store.
    # pylint: disable-next=invalid-name  # route-level constant
    BUNDLE_MEDIA_TYPE = "application/gzip"
    # pylint: disable-next=invalid-name  # route-level constant
    BUNDLE_RESPONSES = {
        200: {"content": {BUNDLE_MEDIA_TYPE: {"schema": {"type": "string",
                                                         "format": "binary"}}},
              "description": "the bundle, as a gzipped tar with the files at its root"},
    }
    # Which deployments can be bundled. A network does not stop being worth
    # packaging when its process is torn down: the HOCON and the editable source
    # outlive the site, so taking a deployment down and then wanting it as a
    # static site is an ordinary order of events, not a mistake.
    #
    # The three left out have nothing finished to offer. `queued` and `building`
    # have not produced a site yet, and `failed` tried and could not.
    # pylint: disable-next=invalid-name  # route-level constant
    BUNDLE_STATUSES = (DeploymentStatus.READY, DeploymentStatus.STOPPED)

    @app.post("/bundles", dependencies=AUTH, response_class=Response,
              responses=BUNDLE_RESPONSES,
              summary="Build a HOCON into a static bundle and return it (multipart)")
    # pylint: disable-next=too-many-arguments,too-many-positional-arguments  # one parameter per form field
    async def build_bundle(
        request: Request,
        file: Annotated[UploadFile, File(description="the agent-network .hocon")],
        name: Annotated[Optional[str], Form()] = None,
        site_url: Annotated[Optional[str], Form(
            description="where the client will host this bundle; baked into the "
                        "manifest and cannot be changed afterwards")] = None,
        upstream: Annotated[Optional[str], Form()] = None,
        theme: Annotated[bool, Form()] = False,
        theme_model: Annotated[Optional[str], Form()] = None,
        theme_refresh: Annotated[bool, Form()] = False,
        theme_prompt: Annotated[Optional[str], Form(max_length=4000)] = None,
        cruse: Annotated[Optional[bool], Form()] = None,
    ) -> Response:
        # Same naming rule as POST /deployments: an explicit name is validated
        # verbatim, and only an upload filename is basenamed.
        candidate = name.strip() if name and name.strip() else PurePosixPath(
            (file.filename or "network").replace("\\", "/")).name
        options = BundleOptions(
            name=candidate, site_url=site_url, upstream=upstream, theme=theme,
            theme_model=theme_model, theme_refresh=theme_refresh,
            theme_prompt=theme_prompt, cruse=cruse,
        )
        result = await bundler_of(request).build(await file.read(), options)
        return Response(content=result.archive, media_type=BUNDLE_MEDIA_TYPE,
                        headers=_bundle_headers(result))

    @app.post("/bundles/raw", dependencies=AUTH, response_class=Response,
              responses=BUNDLE_RESPONSES,
              summary="Build a HOCON posted as a raw request body into a static bundle")
    # pylint: disable-next=too-many-arguments,too-many-positional-arguments  # one parameter per form field
    async def build_bundle_raw(
        request: Request,
        name: Annotated[str, Query(description="network name (becomes the HOCON "
                                               "filename stem and names the archive)")],
        site_url: Annotated[Optional[str], Query()] = None,
        upstream: Annotated[Optional[str], Query()] = None,
        theme: Annotated[bool, Query()] = False,
        theme_model: Annotated[Optional[str], Query()] = None,
        theme_refresh: Annotated[bool, Query()] = False,
        theme_prompt: Annotated[Optional[str], Query(max_length=4000)] = None,
        cruse: Annotated[Optional[bool], Query()] = None,
    ) -> Response:
        options = BundleOptions(
            name=name, site_url=site_url, upstream=upstream, theme=theme,
            theme_model=theme_model, theme_refresh=theme_refresh,
            theme_prompt=theme_prompt, cruse=cruse,
        )
        result = await bundler_of(request).build(await request.body(), options)
        return Response(content=result.archive, media_type=BUNDLE_MEDIA_TYPE,
                        headers=_bundle_headers(result))

    # A bundle for a network which is already deployed. Filed under /deployments
    # because it names one, but a bundle all the same: nothing is written, nothing
    # is recorded, and the deployment it describes is untouched.
    #
    # This REBUILDS from the deployment's own HOCON rather than exporting the site
    # it is serving. A deployed site is generated for a server — absolute asset
    # paths, a live MCP facade, tool URLs on its own origin, a links endpoint — and
    # static_bundle=True changes every one of those, so the served tree cannot be
    # repacked into a bundle. What is replayed is the deployment's own choices.
    @app.get("/deployments/{deployment_id}/bundle", dependencies=AUTH,
             response_class=Response, responses=BUNDLE_RESPONSES,
             summary="Build a static bundle from a ready deployment and return it")
    async def build_deployment_bundle(
        request: Request,
        deployment_id: str,
        site_url: Annotated[Optional[str], Query(
            description="where the client will host this bundle; baked into the "
                        "manifest and cannot be changed afterwards. Empty addresses "
                        "the bundle relative to wherever it is served, which only "
                        "works at a domain root. Never defaults to the deployment's "
                        "own URL, which is this service's loopback port")] = None,
        upstream: Annotated[Optional[str], Query(
            description="BYOK upstream for this bundle only; defaults to the "
                        "deployment's own")] = None,
    ) -> Response:
        row = find_row(request, deployment_id)
        status = DeploymentStatus(row.get("status"))
        if status not in BUNDLE_STATUSES:
            raise HTTPException(
                status_code=409,
                detail=f"{row.get('name')} is {status.value}; a bundle is built "
                       f"from a ready or a stopped deployment")
        hocon_path = Path(row.get("hocon_path") or "")
        if not hocon_path.is_file():
            # The record outlived its files: a WORK_ROOT that moved between runs, or
            # a work dir removed by hand. Gone rather than Not Found, because the
            # deployment is real and it is its source which is missing.
            raise HTTPException(
                status_code=410,
                detail=f"the HOCON for {row.get('name')} is no longer on disk at "
                       f"{hocon_path}, so this deployment cannot be rebuilt")
        options = Bundler.deployment_options(row, site_url, upstream)
        result = await bundler_of(request).build_from_deployment(row, options)
        headers = _bundle_headers(result)
        # Built fresh on every call and kept nowhere, so nothing may hold a copy.
        # A GET is cacheable by default, and the deployment's look can change under
        # it at any time through POST /deployments/{id}/theme-spec.
        headers["Cache-Control"] = "no-store"
        return Response(content=result.archive, media_type=BUNDLE_MEDIA_TYPE,
                        headers=headers)

    # --- ops -------------------------------------------------------------
    @app.get("/health", response_model=HealthView, summary="Service health and capacity")
    async def health(request: Request) -> HealthView:
        supervisor = supervisor_of(request)
        warnings: List[str] = []
        if not settings.api_token and settings.host not in ("127.0.0.1", "localhost", "::1"):
            warnings.append(
                f"the API is bound to {settings.host} with no API_TOKEN set; an uploaded HOCON "
                f"can execute arbitrary Python on this host (see nsdeploy_service/README.md)"
            )
        # "*" is not a hole while a token is set — an unauthenticated caller still
        # gets a 401. With no token it is, and in a way the check above does not
        # cover: any page a user visits can drive this service from their browser,
        # loopback included, because the browser reaches 127.0.0.1 for them.
        if "*" in settings.cors_origins and not settings.api_token:
            warnings.append(
                "CORS_ORIGINS is '*' with no API_TOKEN set; any web page a user "
                "visits can drive this service from their browser, including over "
                "loopback. Set API_TOKEN, or name the origins that may call this."
            )
        # A deployed site is handed out as <scheme>://<host>:<port> unless a subdomain
        # template is set. Over https that is almost always unreachable: the platforms
        # people put this behind (Azure Container Apps, App Service) publish a single
        # port, and the origin is baked into the generated bundle, so a wrong one
        # cannot be corrected afterwards — the deployment comes up `ready` and its URL
        # answers nothing. Worth saying out loud rather than leaving to be discovered.
        # TLS_TERMINATED_EXTERNALLY suppresses this: the check reads configuration only
        # and cannot see a reverse proxy listening with a certificate on every port of
        # the pool, so on a host where that has been provided the warning is wrong.
        if (settings.public_scheme == "https" and not settings.subdomain_template
                and not settings.tls_terminated_externally):
            warnings.append(
                f"deployed sites will be published as https://{settings.public_host}:<port> "
                f"from the pool {settings.port_start}-{settings.port_end}. A single-port "
                f"ingress serves only 443, so those URLs will not resolve unless something "
                f"terminates TLS on each port in that range. Host where the range is "
                f"reachable, or set SUBDOMAIN_TEMPLATE (see nsdeploy_service/README.md)."
            )
        # Reconciliation is routine housekeeping at startup, not a fault, and it is a
        # one-off event rather than an ongoing condition — so it is reported as a
        # plain count, never in `warnings`. Putting it in `warnings` made every
        # /health poll re-raise it forever. The affected records already say
        # "did not survive a service restart" in the directory, where each one has a
        # Restart button; that is the actionable place for it.
        return HealthView(
            status="ok",
            version=__version__,
            build=settings.build_version or __version__,
            # Read per request rather than cached at startup: during development the
            # files change under a running service, which is exactly when a stale
            # console is most likely and most confusing.
            ui_version=read_ui_version(settings.ui_dir),
            python=sys.version.split()[0],
            platform=platform.platform(),
            # Persisted totals, so terminal records from earlier runs are included.
            deployments=supervisor.store.count_by_status(),
            reconciled_at_startup=len(supervisor.orphaned),
            port_pool={
                "range": f"{settings.port_start}-{settings.port_end}",
                "capacity": supervisor.ports.capacity,
                "reserved": sorted(supervisor.ports.reserved()),
            },
            # Live, not persisted: only this process can have a queue, and a
            # deployment waiting for a slot is invisible in every other field.
            build_queue=supervisor.build_queue(),
            warnings=warnings,
        )

    # Maps the console's field names to the environment variables that actually
    # govern them, so /settings and .env stay in lockstep with require_token,
    # _relations_chat and supervisor.py's _command() rather than inventing a
    # parallel name for the same thing. The secrets are masked on the way out; the
    # rest are the same deploy defaults Settings already reads at startup
    # (config.py) — upstream/theme_model as plain text, theme/theme_refresh as bools.
    # pylint: disable-next=invalid-name  # route-level constant
    SETTINGS_SECRET_KEYS = {
        "nsdeploy_api_token": "NSDEPLOY_SERVICE_API_TOKEN",
        "openai_api_key": "OPENAI_API_KEY",
    }
    # pylint: disable-next=invalid-name  # route-level constant
    SETTINGS_TEXT_KEYS = {
        "upstream": "NSDEPLOY_SERVICE_UPSTREAM",
        "theme_model": "NSDEPLOY_SERVICE_THEME_MODEL",
        "theme_prompt": "NSDEPLOY_SERVICE_THEME_PROMPT",
    }
    # pylint: disable-next=invalid-name  # route-level constant
    SETTINGS_BOOL_KEYS = {
        "theme": "NSDEPLOY_SERVICE_THEME",
        "theme_refresh": "NSDEPLOY_SERVICE_THEME_REFRESH",
    }

    # Which of the two credentials the admin panel holds a default for, if the panel
    # is installed at all. Asked of the panel rather than inferred, and entirely
    # optional: a checkout without the folder, or one where the panel has not
    # mounted yet, simply reports neither as managed.
    # pylint: disable-next=invalid-name  # route-level constant
    SETTINGS_PANEL_KIND = {"nsdeploy_api_token": "app", "openai_api_key": "llm"}

    def _panel_managed() -> set:
        context = getattr(app.state, "admin_panel", None)
        if context is None:
            return set()
        try:
            return {
                field for field, kind in SETTINGS_PANEL_KIND.items()
                if context.store.default_key(kind) is not None
            }
        except Exception:  # pylint: disable=broad-exception-caught; the panel's faults stay out of the host
            # The panel's own store is its business; a fault there must not take
            # out the host's settings dialog.
            return set()

    def _settings_view() -> SettingsView:
        stored = envfile.read_env_file()
        managed = _panel_managed()
        fields = {}
        for field_name, env_key in SETTINGS_SECRET_KEYS.items():
            if field_name == "nsdeploy_api_token":
                # The enforced value, not the environment's. `require_token` compares
                # against `settings.api_token`, and the admin panel's apply_app_key
                # rewrites that live without touching os.environ — so reading the
                # environment here reports a token that is no longer in force. The
                # console shows this field read-only as a way to confirm *which*
                # token the service is honouring, which is only true if it is read
                # from the same place the check reads.
                value = str(settings.api_token or "")
            else:
                # The environment is correct for the LLM key: supervisor._spawn copies
                # os.environ into every build subprocess, so that is literally what
                # deploy-time theming will use.
                value = os.environ.get(env_key) or stored.get(env_key, "")
            fields[field_name] = {
                "is_set": bool(value), "last4": value[-4:] if value else "",
                "managed_by_admin_panel": field_name in managed,
            }
        # Read from the live Settings object, not the environment again: it already
        # holds the resolved value (env var, then .env, then default) and is the
        # same object every deploy actually uses (see supervisor.py's `opts.x or
        # s.x`), so this can never disagree with what Launch will get.
        return SettingsView(
            **fields, upstream=settings.upstream, theme=settings.theme,
            theme_model=settings.theme_model, theme_refresh=settings.theme_refresh,
            theme_prompt=settings.theme_prompt,
        )

    @app.get("/settings", response_model=SettingsView, dependencies=AUTH,
             summary="The local API credentials (masked) and deploy defaults")
    async def get_settings() -> SettingsView:
        return _settings_view()

    @app.post("/settings", response_model=SettingsView, dependencies=AUTH,
              summary="Save API credentials and deploy defaults to this checkout's .env")
    async def update_settings(body: SettingsUpdate) -> SettingsView:
        payload = body.model_dump(exclude_none=True)
        updates = {
            SETTINGS_SECRET_KEYS[field]: value.strip()
            for field, value in payload.items() if field in SETTINGS_SECRET_KEYS
        }
        updates.update({
            SETTINGS_TEXT_KEYS[field]: value.strip()
            for field, value in payload.items() if field in SETTINGS_TEXT_KEYS
        })
        updates.update({
            SETTINGS_BOOL_KEYS[field]: "true" if value else "false"
            for field, value in payload.items() if field in SETTINGS_BOOL_KEYS
        })

        if updates:
            envfile.write_env_values(updates)
            os.environ.update(updates)
            # Mutated on the same `settings` object require_token/supervisor close
            # over, so a change gates or governs the very next request rather than
            # only the next restart.
            if "NSDEPLOY_SERVICE_API_TOKEN" in updates:
                settings.api_token = updates["NSDEPLOY_SERVICE_API_TOKEN"]
            if "NSDEPLOY_SERVICE_UPSTREAM" in updates:
                settings.upstream = updates["NSDEPLOY_SERVICE_UPSTREAM"]
            if "NSDEPLOY_SERVICE_THEME_MODEL" in updates:
                settings.theme_model = updates["NSDEPLOY_SERVICE_THEME_MODEL"]
            if "NSDEPLOY_SERVICE_THEME_PROMPT" in updates:
                settings.theme_prompt = updates["NSDEPLOY_SERVICE_THEME_PROMPT"]
            if "theme" in payload:
                settings.theme = payload["theme"]
            if "theme_refresh" in payload:
                settings.theme_refresh = payload["theme_refresh"]
        return _settings_view()

    # --- UI ---------------------------------------------------------------
    # Served same-origin: no CORS needed for it, no second deployment unit, no token
    # to plumb across origins. It lives in its own top-level ui/ folder and talks to
    # this service only through the documented JSON API, so lifting it to a CDN or a
    # separate origin costs its origin in CORS_ORIGINS and a base URL in client.js —
    # nothing structural.
    #
    # html=True makes /app/ serve index.html, which keeps the page's relative asset
    # paths (assets/js/main.js) resolving under /app/.
    if settings.ui_dir.is_dir():
        app.mount("/app", ConsoleFiles(directory=settings.ui_dir, html=True), name="ui")

        @app.get("/", include_in_schema=False)
        async def root() -> Response:
            return RedirectResponse(url="/app/")
    else:
        @app.get("/", response_class=HTMLResponse, include_in_schema=False)
        async def root_console() -> str:
            return _console_html()

    # The dependency-free inline console stays available as a fallback for debugging
    # the API without the UI's assets.
    @app.get("/console", response_class=HTMLResponse, include_in_schema=False)
    async def console() -> str:
        return _console_html()

    # --- admin panel -------------------------------------------------------
    # A drop-in folder that owns its own routes, UI, database and settings. This is
    # the entire integration: nothing above is aware of it. See
    # nsdeploy_service/adminPanel/INTEGRATION.md.
    #
    # It must come before the SiteProxy wrap below: that object is not a FastAPI,
    # so there would be nothing to mount onto.
    if install_admin_panel is not None:
        install_admin_panel(app, settings)

    # Serve deployed sites on their own hostnames through this one listener. Wrapped
    # around the finished app rather than added with add_middleware() so the
    # hostname decision happens before any routing: on a site's hostname `GET /`
    # must reach the site, while the service's own `GET /` is the console redirect.
    # Inert unless SUBDOMAIN_TEMPLATE is set, so the port-per-deployment default is
    # untouched.
    if settings.subdomain_template:
        return SiteProxy(app, settings)  # type: ignore[return-value]
    return app


# A single-file console so a HOCON can be deployed and watched without curl.
#
# %PRODUCT% is substituted from PRODUCT_NAME when the page is served (see the
# /console route). A placeholder rather than an f-string because this literal is
# mostly CSS and JS, and every `{` in it would have to be doubled.
_CONSOLE_HTML = """<!doctype html>
<html lang="en"><meta charset="utf-8"><title>%PRODUCT% — fallback console</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--fg:#1a1d21;--bg:#f7f8fa;--mut:#5b6472;--line:#d8dde5;--acc:#2f6feb}
@media(prefers-color-scheme:dark){:root{--fg:#e8eaed;--bg:#14171a;--mut:#9aa4b2;--line:#2b3138}}
*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;
color:var(--fg);background:var(--bg)}
main{max-width:52rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .25rem}p.sub{color:var(--mut);margin:0 0 1.5rem}
fieldset{border:1px solid var(--line);border-radius:10px;padding:1rem 1.15rem;margin:0 0 1.25rem}
legend{padding:0 .4rem;color:var(--mut);font-size:.85rem}
label{display:block;margin:.6rem 0 .2rem;font-size:.85rem;color:var(--mut)}
input[type=text],input[type=number]{width:100%;padding:.5rem .6rem;border:1px solid var(--line);
border-radius:7px;background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:.9rem;flex-wrap:wrap}.row>div{flex:1 1 12rem}
button{margin-top:1rem;padding:.55rem 1.1rem;border:0;border-radius:7px;background:var(--acc);
color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.55;cursor:progress}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{text-align:left;padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600}
code{font:13px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
.s{font-weight:600}.s-ready{color:#1a7f4b}.s-failed{color:#c0392b}.s-building,.s-queued{color:#b3730c}
.s-stopped{color:var(--mut)}
pre{margin:.5rem 0 0;padding:.75rem;background:rgba(127,127,127,.12);border-radius:8px;
overflow:auto;max-height:18rem;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap}
a{color:var(--acc)}
</style>
<main>
<h1>%PRODUCT%</h1>
<p class="sub">Upload an agent-network HOCON; get a live site URL.</p>

<form id="f">
<fieldset><legend>deploy</legend>
  <label for="file">network .hocon</label>
  <input type="file" id="file" accept=".hocon,.conf,text/plain" required>
  <div class="row">
    <div><label for="name">name (optional)</label><input type="text" id="name" placeholder="from filename"></div>
    <div><label for="ttl">ttl seconds (0 = never)</label><input type="number" id="ttl" min="0"
      placeholder="service default"></div>
  </div>
  <button type="submit" id="go">Deploy</button>
</fieldset>
</form>

<fieldset><legend>deployments</legend>
  <table><thead><tr><th>name</th><th>status</th><th>url</th><th></th></tr></thead>
  <tbody id="rows"><tr><td colspan="4" style="color:var(--mut)">none yet</td></tr></tbody></table>
  <pre id="log" hidden></pre>
</fieldset>
</main>
<script>
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let watching = null;

async function api(path, init) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 504) throw new Error(body.detail || `${r.status} ${r.statusText}`);
  return body;
}

$('#f').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#go'); btn.disabled = true; btn.textContent = 'Deploying…';
  try {
    const fd = new FormData();
    fd.append('file', $('#file').files[0]);
    if ($('#name').value.trim()) fd.append('name', $('#name').value.trim());
    if ($('#ttl').value !== '') fd.append('ttl_seconds', $('#ttl').value);
    const dep = await api('/deployments', {method: 'POST', body: fd});
    watching = dep.id;
    await refresh();
  } catch (err) {
    alert('Deploy rejected: ' + err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Deploy';
  }
});

async function showLog(id) {
  watching = id;
  const log = await api(`/deployments/${id}/logs?tail=200`);
  const el = $('#log'); el.hidden = false;
  el.textContent = log.lines.join('\\n') || '(no output yet)';
  el.scrollTop = el.scrollHeight;
}

function row(d) {
  const url = d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : '—';
  const warn = d.warnings?.length ? ` <span title="${esc(d.warnings.join('\\n'))}">⚠︎${d.warnings.length}</span>` : '';
  const err = d.error ? `<div style="color:#c0392b;font-size:.8rem">${esc(d.error.split('\\n')[0])}</div>` : '';
  return `<tr><td><code>${esc(d.name)}</code><div style="color:var(--mut);font-size:.78rem">${esc(d.id)}</div></td>
    <td class="s s-${esc(d.status)}">${esc(d.status)}${warn}${err}</td><td>${url}</td>
    <td><button style="margin:0;padding:.25rem .55rem;font-size:.8rem;background:transparent;color:var(--acc)"
      onclick="showLog('${esc(d.id)}')">logs</button>
      ${['queued','building','ready'].includes(d.status)
        ? `<button style="margin:0;padding:.25rem .55rem;font-size:.8rem;background:transparent;color:#c0392b"
            onclick="stopDep('${esc(d.id)}')">stop</button>` : ''}</td></tr>`;
}

// Not named stop(): window.stop is a built-in, and inline handlers resolve globally.
async function stopDep(id) {
  if (!confirm('Tear down this deployment?')) return;
  await api(`/deployments/${id}`, {method: 'DELETE'});
  await refresh();
}

async function refresh() {
  try {
    const {deployments} = await api('/deployments');
    $('#rows').innerHTML = deployments.length
      ? deployments.map(row).join('')
      : '<tr><td colspan="4" style="color:var(--mut)">none yet</td></tr>';
    if (watching && deployments.some(d => d.id === watching &&
        ['queued','building'].includes(d.status))) await showLog(watching);
  } catch (err) { /* service restarting — next tick retries */ }
}

window.stopDep = stopDep; window.showLog = showLog;
refresh(); setInterval(refresh, 2000);
</script>
</html>
"""


def _console_html() -> str:
    """The fallback console, with the product name filled in.

    Substituted at serve time rather than at import so the one constant in
    nsdeploy_service/__init__.py stays the only place the product is named.
    """
    return _CONSOLE_HTML.replace("%PRODUCT%", PRODUCT_NAME)


app = create_app()
