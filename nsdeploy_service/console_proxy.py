from __future__ import annotations

import re
from typing import Any
from typing import Awaitable
from typing import Callable
from typing import Dict
from typing import List
from typing import Pattern
from typing import Tuple

from fastapi.responses import JSONResponse

from nsdeploy_service.config import Settings

Scope = Dict[str, Any]
Message = Dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
AsgiApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class ConsoleProxy:
    """
    ASGI middleware that lets the console call the API without holding the API token.

    The console sends its requests to `/console-api/<path>`. A request on `ALLOWED_REQUESTS` is passed on to
    `/<path>`, and when `console_proxy` is on, its Authorization header is replaced with the server's token. Any other
    `/console-api` request gets a 403. This is the console's equivalent of neuro-san-ui's `/api/publish` proxy: the
    token stays on the server, and visitors can only make the requests the console makes. `POST /settings` and
    `/bundles` are not on the list, so they still need the caller's own token.
    """

    PREFIX: str = "/console-api"

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

    def __init__(self, app: AsgiApp, settings: Settings) -> None:
        """
        Wrap an ASGI app.

        :param app: The app that serves the API.
        :param settings: The service settings. `api_token` is read per request, because POST /settings can
            replace it.
        """
        self.app: AsgiApp = app
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
        method: str = scope.get("method", "")
        if not self.is_allowed(method, api_path):
            refusal = JSONResponse({"detail": f"{method} {api_path} isn't a console request"}, status_code=403)
            await refusal(scope, receive, send)
            return

        forwarded: Scope = dict(scope)
        forwarded["path"] = api_path
        forwarded["raw_path"] = self.strip_prefix(scope.get("raw_path"), api_path)
        if self.settings.console_proxy:
            forwarded["headers"] = self.with_token(scope.get("headers", []))
        await self.app(forwarded, receive, send)

    def is_allowed(self, method: str, api_path: str) -> bool:
        """
        Check whether a request is one the console makes.

        :param method: The HTTP method.
        :param api_path: The path after `/console-api`.
        :return: True if the method and path are on `ALLOWED_REQUESTS`.
        """
        # Look for an entry with this method whose pattern matches the whole path.
        allowed_method: str
        allowed_path: Pattern[str]
        for allowed_method, allowed_path in self.ALLOWED_REQUESTS:
            if allowed_method == method and allowed_path.fullmatch(api_path):
                return True
        return False

    def strip_prefix(self, raw_path: Any, api_path: str) -> bytes:
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
        :return: The headers without the caller's Authorization, plus the server's token when one is set.
        """
        result: List[Tuple[bytes, bytes]] = []
        # Drop the caller's Authorization so only the server's token is checked.
        name: bytes
        value: bytes
        for name, value in headers:
            if name.lower() != b"authorization":
                result.append((name, value))
        if self.settings.api_token:
            result.append((b"authorization", b"Bearer " + self.settings.api_token.encode("latin-1")))
        return result
