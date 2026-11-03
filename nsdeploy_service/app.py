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
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Annotated, List, Optional
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from nsdeploy_service import PRODUCT_NAME, __version__
from nsdeploy_service import envfile, themespec
from nsdeploy_service.config import Settings
from nsdeploy_service.models import (
    ORG_NAME_MAX,
    ORG_NAME_PATTERN,
    AgentGraphView,
    DeploymentList,
    DeploymentStatus,
    DeploymentView,
    DeployOptions,
    DirectoryOrg,
    DirectoryView,
    GraphEdge,
    GraphNode,
    GraphView,
    HealthView,
    LogView,
    NetworkSummary,
    OrgCreate,
    OrgList,
    OrgUpdate,
    OrgView,
    SettingsUpdate,
    SettingsView,
    ThemeSpecApplied,
    ThemeSpecView,
    ThemeTokens,
    ThemeUpdate,
)
from nsdeploy_service.layout import next_position
from nsdeploy_service.models import RelationsView, SuggestedEdge
from nsdeploy_service.relations import (
    ChatFn,
    SuggestedRelation,
    identities_from_rows,
    suggest_relations,
)
from nsdeploy_service.siteproxy import SiteProxy
from nsdeploy_service.store import StoreError
from nsdeploy_service.supervisor import (
    Deployment,
    DeploymentError,
    Supervisor,
    _iso,
    _tail as read_log,
    is_publishable,
    network_topology,
    publish_refusal,
)

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


def _row_view(row: dict, settings: Settings) -> DeploymentView:
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


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    # Configure TLS trust here rather than only in __main__, so an ASGI server
    # importing `app` directly (uvicorn/gunicorn in a container) gets it too.
    # Service-owned, so this works against an unmodified nsdeploy; the build
    # subprocesses get it via _bootstrap/sitecustomize.py instead.
    from nsdeploy_service.trust import ensure_ca_bundle

    ensure_ca_bundle()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        # Built inside the loop so the build semaphore binds to the right one.
        app.state.settings = settings
        app.state.supervisor = Supervisor(settings)
        if app.state.supervisor.orphaned:
            print(f"reconciled {len(app.state.supervisor.orphaned)} deployment record(s) "
                  f"left live by a previous run", file=sys.stderr)
        if app.state.supervisor.resummarized:
            print(f"rebuilt the network summary for {len(app.state.supervisor.resummarized)} "
                  f"deployment record(s) from their generated bundle", file=sys.stderr)
        reaper = asyncio.create_task(_reaper(app.state.supervisor), name="ttl-reaper")
        try:
            yield
        finally:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            # Never leave orphaned site/tool/facade processes holding ports.
            await app.state.supervisor.shutdown()

    async def _reaper(supervisor: Supervisor) -> None:
        interval = max(5, supervisor.settings.reap_interval_seconds)
        while True:
            await asyncio.sleep(interval)
            with contextlib.suppress(Exception):
                await supervisor.reap_expired()

    app = FastAPI(
        title=PRODUCT_NAME,
        version=__version__,
        summary="Deploy a neuro-san agent-network HOCON as a live website over HTTP.",
        lifespan=lifespan,
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
    AUTH = [Depends(require_token)]

    def supervisor_of(request: Request) -> Supervisor:
        return request.app.state.supervisor

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
    async def graph(
        request: Request,
        org_id: Annotated[Optional[str], Query(description="filter to one organization")] = None,
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
            # wait_for rather than asyncio.timeout so this still runs on Python 3.10,
            # which is what nsdeploy's pyproject declares as the floor.
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
            warnings=warnings,
        )

    # Maps the console's field names to the environment variables that actually
    # govern them, so /settings and .env stay in lockstep with require_token,
    # _relations_chat and supervisor.py's _command() rather than inventing a
    # parallel name for the same thing. The secrets are masked on the way out; the
    # rest are the same deploy defaults Settings already reads at startup
    # (config.py) — upstream/theme_model as plain text, theme/theme_refresh as bools.
    SETTINGS_SECRET_KEYS = {
        "nsdeploy_api_token": "NSDEPLOY_SERVICE_API_TOKEN",
        "openai_api_key": "OPENAI_API_KEY",
    }
    SETTINGS_TEXT_KEYS = {
        "upstream": "NSDEPLOY_SERVICE_UPSTREAM",
        "theme_model": "NSDEPLOY_SERVICE_THEME_MODEL",
        "theme_prompt": "NSDEPLOY_SERVICE_THEME_PROMPT",
    }
    SETTINGS_BOOL_KEYS = {
        "theme": "NSDEPLOY_SERVICE_THEME",
        "theme_refresh": "NSDEPLOY_SERVICE_THEME_REFRESH",
    }

    # Which of the two credentials the admin panel holds a default for, if the panel
    # is installed at all. Asked of the panel rather than inferred, and entirely
    # optional: a checkout without the folder, or one where the panel has not
    # mounted yet, simply reports neither as managed.
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
        except Exception:
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
    # Served same-origin: no CORS to configure, no second deployment unit, no token
    # to plumb across origins. It lives in its own top-level ui/ folder and talks to
    # this service only through the documented JSON API, so lifting it to a CDN or a
    # separate origin later costs a CORS policy and a base URL — nothing structural.
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
    # the entire integration: nothing above is aware of it, and it is imported
    # lazily so a checkout without the folder still runs. See
    # nsdeploy_service/adminPanel/INTEGRATION.md.
    #
    # It must come before the SiteProxy wrap below: that object is not a FastAPI,
    # so there would be nothing to mount onto.
    try:
        from nsdeploy_service.adminPanel import install as install_admin_panel
    except ImportError:
        pass
    else:
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
    <div><label for="ttl">ttl seconds (0 = never)</label><input type="number" id="ttl" min="0" placeholder="service default"></div>
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
