"""Serve every deployed site through the service's single ingress, by hostname.

A deployed site owns a whole port and every route it generates is root-absolute
(`/runtime/*`, `/agent-manifest.json`, `/v1`, `/byok/v1`, `/_mcp/<i>/mcp`, `/mcp`),
so sites cannot share an origin on a path prefix. What they *can* share is a port:
a browser origin is scheme + host + port, so one TLS listener plus a hostname per
deployment gives each site its own origin and the root-absolute paths resolve.

That is what makes a single-port ingress — Azure Container Apps, App Service —
workable, and it needs no change to nsdeploy: `launcher.make_handler` ignores the
Host header, so the site is happy to be reached over loopback.

**Middleware, not a route.** The choice is made by hostname before any path
matching: on a site's hostname `GET /` must reach the site, but the service's own
`GET /` is the console redirect. A catch-all route would be consulted after those,
and never see it.

**Unauthenticated by design.** Deployed sites are public; only the management API
carries the token gate. A visitor of a published network must not need the
operator's credentials.

`X-Forwarded-Host` is honoured ahead of `Host` so the same build works behind Azure
Front Door — which rewrites Host to the origin's own FQDN so Container Apps ingress
accepts the request, and preserves the caller's hostname in the forwarded header —
and behind an nginx/Caddy that simply passes Host through.
"""
from __future__ import annotations

import time
from typing import Any
from typing import Dict
from typing import FrozenSet
from typing import List
from typing import Optional
from typing import Tuple
from urllib.parse import urlsplit

import httpx
from starlette.types import ASGIApp
from starlette.types import Message
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.store import Store

# Hop-by-hop headers belong to one connection and must not be relayed. Content
# length is dropped too: responses are streamed, so the framing is re-derived.
_DROP_REQUEST: FrozenSet[str] = frozenset({
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
})
_DROP_RESPONSE: FrozenSet[str] = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
})

# A site serves many small assets per page, so the hostname lookup is cached
# briefly rather than hitting SQLite for every request. Short enough that a stop
# or a restart takes effect promptly.
HOST_CACHE_SECONDS: float = 2.0
# No read timeout: /v1 and /byok/v1 are long-lived SSE streams and an MCP GET can
# stay open for a whole session.
PROXY_TIMEOUT: httpx.Timeout = httpx.Timeout(None, connect=10.0)


def site_hostname(settings: Settings, row: dict) -> Optional[str]:
    """The hostname this deployment answers on, or None when it has no hostname.

    Derived from the recorded URL when there is one, and from the settings plus the
    record otherwise — a queued or stopped deployment has no `url`, but the service
    still needs to recognise its hostname to answer usefully instead of 404ing.
    """
    url: Optional[str] = row.get("url")
    if url:
        host: Optional[str] = urlsplit(url).hostname
        if host:
            return host.lower()
    if not settings.subdomain_template:
        return None  # port-per-deployment: nothing to route by name
    label: str = settings.subdomain_label(row["id"], row.get("port") or 0, row.get("name", ""))
    return f"{label}.{settings.public_host}".lower()


class SiteProxy:
    """ASGI middleware routing site hostnames to their loopback port."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app: ASGIApp = app
        self.settings: Settings = settings
        self._cache: Dict[str, Tuple[Optional[dict], float]] = {}
        self._client: Optional[httpx.AsyncClient] = None

    # --- resolution -------------------------------------------------------
    def _store(self) -> Optional[Store]:
        supervisor: Any = getattr(self.app, "state", None)
        # The middleware is installed around the app, so reach the supervisor the
        # same way the routes do. It does not exist until lifespan startup.
        return getattr(getattr(supervisor, "supervisor", None), "store", None)

    def _lookup(self, host: str) -> Optional[dict]:
        cached: Optional[Tuple[Optional[dict], float]] = self._cache.get(host)
        now: float = time.monotonic()
        if cached and cached[1] > now:
            return cached[0]
        store: Optional[Store] = self._store()
        row: Optional[dict] = None
        if store is not None:
            candidate: Dict[str, Any]
            for candidate in store.list_deployments():
                if site_hostname(self.settings, candidate) == host:
                    row = candidate
                    break
        self._cache[host] = (row, now + HOST_CACHE_SECONDS)
        return row

    def _requested_host(self, scope: Scope) -> str:
        headers: Dict[str, str] = {k.decode("latin-1").lower(): v.decode("latin-1")
                                   for k, v in scope.get("headers", [])}
        # First entry only: X-Forwarded-Host is a comma-separated list when proxies
        # chain, and the client-facing name is the one that matters.
        forwarded: str = headers.get("x-forwarded-host", "").split(",")[0].strip()
        host: str = forwarded or headers.get("host", "")
        return host.split(":")[0].strip().lower()

    # --- ASGI -------------------------------------------------------------
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "lifespan":
            # The upstream client is created lazily and pooled for the process, so
            # it has to be closed with the app or its connections are leaked.
            try:
                await self.app(scope, receive, send)
            finally:
                if self._client is not None:
                    await self._client.aclose()
                    self._client = None
            return
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        host: str = self._requested_host(scope)
        if not host or host == self.settings.public_host.lower():
            await self.app(scope, receive, send)
            return
        row: Optional[dict] = self._lookup(host)
        if row is None:
            await self.app(scope, receive, send)  # not a site: the API owns it
            return
        status: DeploymentStatus = DeploymentStatus(row["status"])
        if status is not DeploymentStatus.READY or not row.get("port"):
            await self._plain(send, 503,
                              f"{row['name']} is {status.value}. "
                              f"Restart it from the deployment console.")
            return
        await self._proxy(scope, receive, send, int(row["port"]))

    async def _plain(self, send: Send, code: int, text: str) -> None:
        body: bytes = text.encode("utf-8")
        await send({"type": "http.response.start", "status": code,
                    "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                                (b"content-length", str(len(body)).encode()),
                                (b"cache-control", b"no-store")]})
        await send({"type": "http.response.body", "body": body})

    async def _proxy(self, scope: Scope, receive: Receive, send: Send, port: int) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=PROXY_TIMEOUT, follow_redirects=False)
        path: bytes = scope.get("raw_path") or scope["path"].encode()
        query: bytes = scope.get("query_string") or b""
        url: str = f"http://127.0.0.1:{port}{path.decode('latin-1')}"
        if query:
            url = f"{url}?{query.decode('latin-1')}"

        headers: List[Tuple[str, str]] = [(k.decode("latin-1"), v.decode("latin-1"))
                                          for k, v in scope.get("headers", [])
                                          if k.decode("latin-1").lower() not in _DROP_REQUEST]

        # The request body is buffered, not streamed. A deployed site is served by
        # http.server's BaseHTTPRequestHandler (launcher.make_handler), which reads
        # Content-Length and has no support for a chunked request body — streaming
        # here made httpx use chunked encoding and the site saw an empty payload.
        # Passing bytes lets httpx set a correct Content-Length. Safe because
        # requests *to* a site are small: chat completions and MCP JSON-RPC. Uploads
        # go to the management API, which is not proxied.
        body: bytes = await _read_body(receive)
        request: httpx.Request = self._client.build_request(
            scope["method"], url, headers=headers, content=body)
        try:
            upstream: httpx.Response = await self._client.send(request, stream=True)
        except httpx.HTTPError as exc:
            await self._plain(send, 502, f"the deployed site did not answer: {exc}")
            return
        try:
            out: List[Tuple[bytes, bytes]] = [(k.encode("latin-1"), v.encode("latin-1"))
                                              for k, v in upstream.headers.multi_items()
                                              if k.lower() not in _DROP_RESPONSE]
            await send({"type": "http.response.start",
                        "status": upstream.status_code, "headers": out})
            # Streamed rather than buffered: /v1 and /byok/v1 are SSE, and holding
            # the whole response would break token-by-token delivery.
            chunk: bytes
            async for chunk in upstream.aiter_raw():
                await send({"type": "http.response.body", "body": chunk,
                            "more_body": True})
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        finally:
            await upstream.aclose()


async def _read_body(receive: Receive) -> bytes:
    """Collect the whole request body. See the note at the call site on why."""
    chunks: List[bytes] = []
    while True:
        message: Message = await receive()
        if message["type"] == "http.disconnect":
            break
        chunks.append(message.get("body") or b"")
        if not message.get("more_body"):
            break
    return b"".join(chunks)
