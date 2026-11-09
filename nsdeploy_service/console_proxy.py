from __future__ import annotations

import re
from typing import Dict
from typing import List
from typing import Optional
from typing import Pattern
from typing import Tuple
from urllib.parse import urlsplit

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

from nsdeploy_service.config import Settings


class ConsoleProxy:
    """
    ASGI middleware that lets the console call the API without holding the API token.

    The console sends its requests to `/console-api/<path>`, which is passed on to `/<path>`. With `console_proxy`
    off, that is all it does, so the API's own token check and CORS apply as on any other route. With it on, only a
    same-origin request on `ALLOWED_REQUESTS` is passed on, its Authorization header is replaced with the server's
    token, and the request is marked in `scope["state"]` under `STATE_KEY`. Any other `/console-api` request gets a
    403. This is the console's equivalent of neuro-san-ui's `/api/publish` proxy: the token stays on the server, and
    visitors can only make the requests the console makes. `POST /settings` and `/bundles` are not on the list, so
    they still need the caller's own token.
    """

    PREFIX: str = "/console-api"

    # The `request.state` attribute that is True on a request the proxy passed on with the server's token.
    STATE_KEY: str = "console_proxy"

    # Sec-Fetch-Site values for a request from the console's own page, or typed into the address bar.
    SAME_ORIGIN_FETCH_SITES: Tuple[str, ...] = ("same-origin", "none")

    # Every request the console makes (ui/assets/js/api/client.js) except POST /settings. A segment is `[\w-]+`,
    # so an encoded "/" or "." cannot reach another route.
    ALLOWED_REQUESTS: Tuple[Tuple[str, Pattern[str]], ...] = (
        ("GET", re.compile(r"/health")),
        ("GET", re.compile(r"/settings")),
        ("GET", re.compile(r"/orgs")),
        ("POST", re.compile(r"/orgs")),
        ("PATCH", re.compile(r"/orgs/[\w-]+")),
        ("DELETE", re.compile(r"/orgs/[\w-]+")),
        ("GET", re.compile(r"/graph")),
        ("GET", re.compile(r"/directory")),
        ("GET", re.compile(r"/deployments")),
        ("POST", re.compile(r"/deployments")),
        ("GET", re.compile(r"/deployments/[\w-]+")),
        ("DELETE", re.compile(r"/deployments/[\w-]+")),
        ("GET", re.compile(r"/deployments/[\w-]+/(wait|logs|graph|theme-spec)")),
        ("POST", re.compile(r"/deployments/[\w-]+/(restart|theme|theme-spec|publish|unpublish)")),
    )

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        """
        Wrap an ASGI app.

        :param app: The app that serves the API.
        :param settings: The service settings. `api_token` is read per request, because POST /settings can
            replace it.
        """
        self.app: ASGIApp = app
        self.settings: Settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """
        Pass a console request on to the API, refuse it, or pass any other request through unchanged.

        :param scope: The ASGI connection scope.
        :param receive: The ASGI receive channel.
        :param send: The ASGI send channel.
        """
        path: str = scope.get("path", "")
        if scope.get("type") != "http" or not path.startswith(self.PREFIX + "/"):
            await self.app(scope, receive, send)
            return

        api_path: str = path[len(self.PREFIX):]
        forwarded: Scope = dict(scope)
        forwarded["path"] = api_path
        forwarded["raw_path"] = self.strip_prefix(scope.get("raw_path"), api_path)
        if not self.settings.console_proxy:
            await self.app(forwarded, receive, send)
            return

        method: str = scope.get("method", "")
        headers: List[Tuple[bytes, bytes]] = scope.get("headers", [])
        detail: Optional[str] = None
        if self.is_cross_site(headers):
            detail = f"{self.PREFIX} refuses requests from another site"
        elif not self.is_allowed(method, api_path):
            detail = f"{method} {api_path} isn't a console request"
        if detail is not None:
            refusal = JSONResponse({"detail": detail}, status_code=403)
            await refusal(scope, receive, send)
            return

        forwarded["headers"] = self.with_token(headers)
        state: Dict[str, object] = dict(scope.get("state") or {})
        state[self.STATE_KEY] = True
        forwarded["state"] = state
        await self.app(forwarded, receive, send)

    def is_allowed(self, method: str, api_path: str) -> bool:
        """
        Check whether a request is one the console makes.

        :param method: The HTTP method. HEAD is treated as GET.
        :param api_path: The path after `/console-api`.
        :return: True if the method and path are on `ALLOWED_REQUESTS`.
        """
        if method == "HEAD":
            method = "GET"
        # Look for an entry with this method whose pattern matches the whole path.
        allowed_method: str
        allowed_path: Pattern[str]
        for allowed_method, allowed_path in self.ALLOWED_REQUESTS:
            if allowed_method == method and allowed_path.fullmatch(api_path):
                return True
        return False

    def is_cross_site(self, headers: List[Tuple[bytes, bytes]]) -> bool:
        """
        Check whether a browser sent the request from a page on another origin.

        A request without `Sec-Fetch-Site` or `Origin`, such as one from curl, is not cross-site: it gets nothing it
        could not get by calling the service itself. A browser sends at least one of them on a cross-site request,
        including the form posts that need no CORS preflight.

        :param headers: The request headers as ASGI byte pairs.
        :return: True if `Sec-Fetch-Site` names another origin or `Origin` does not match `Host`.
        """
        fetch_site: Optional[str] = self.header(headers, b"sec-fetch-site")
        if fetch_site is not None and fetch_site.lower() not in self.SAME_ORIGIN_FETCH_SITES:
            return True
        origin: Optional[str] = self.header(headers, b"origin")
        if origin is None:
            return False
        host: str = (self.header(headers, b"host") or "").lower()
        return urlsplit(origin.lower()).netloc != host

    @staticmethod
    def header(headers: List[Tuple[bytes, bytes]], name: bytes) -> Optional[str]:
        """
        Read one request header.

        :param headers: The request headers as ASGI byte pairs, with lowercase names.
        :param name: The lowercase header name.
        :return: The first value of the header, or None if the request does not have it.
        """
        # Return the first header with this name.
        header_name: bytes
        value: bytes
        for header_name, value in headers:
            if header_name == name:
                return value.decode("latin-1")
        return None

    def strip_prefix(self, raw_path: object, api_path: str) -> bytes:
        """
        Remove `/console-api` from the undecoded request path.

        :param raw_path: The scope's `raw_path`, which a server may leave out.
        :param api_path: The decoded path after `/console-api`, used when `raw_path` is missing or encoded differently.
        :return: The undecoded path after `/console-api`.
        """
        prefix: bytes = self.PREFIX.encode("ascii")
        if isinstance(raw_path, bytes) and raw_path.startswith(prefix + b"/"):
            return raw_path[len(prefix):]
        return api_path.encode("utf-8")

    def with_token(self, headers: List[Tuple[bytes, bytes]]) -> List[Tuple[bytes, bytes]]:
        """
        Replace the request's Authorization header with the server's API token.

        :param headers: The request headers as ASGI byte pairs.
        :return: The headers without the caller's Authorization, plus the server's token when one is set. The token
            is printable ASCII, which `Settings.validate` and POST /settings check.
        """
        result: List[Tuple[bytes, bytes]] = []
        # Drop the caller's Authorization so only the server's token is checked.
        name: bytes
        value: bytes
        for name, value in headers:
            if name.lower() != b"authorization":
                result.append((name, value))
        if self.settings.api_token:
            result.append((b"authorization", b"Bearer " + self.settings.api_token.encode("ascii")))
        return result
