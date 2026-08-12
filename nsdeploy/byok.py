"""Caller-owned LLM credentials propagated across public MCP facade hops."""
from __future__ import annotations

import contextvars
from dataclasses import dataclass
from typing import Any, Mapping, Optional


BYOK_AUTH_HEADER = "X-Nsdeploy-BYOK-Authorization"
BYOK_MODEL_HEADER = "X-Nsdeploy-BYOK-Model"


@dataclass(frozen=True, repr=False)
class ByokCredentials:
    authorization: str = ""
    model: str = ""

    @property
    def available(self) -> bool:
        return bool(self.authorization)

    def __repr__(self) -> str:
        auth = "<redacted>" if self.authorization else ""
        return f"ByokCredentials(authorization={auth!r}, model={self.model!r})"


_CURRENT_BYOK: contextvars.ContextVar[Optional[ByokCredentials]] = contextvars.ContextVar(
    "nsdeploy_current_byok", default=None
)


def authorization_for_key(api_key: str) -> str:
    value = str(api_key or "").strip()
    if not value:
        return ""
    if value.lower().startswith("bearer "):
        return value
    return f"Bearer {value}"


def byok_headers(api_key: str, model: str = "") -> dict[str, str]:
    authorization = authorization_for_key(api_key)
    if not authorization:
        return {}
    headers = {BYOK_AUTH_HEADER: authorization}
    if model.strip():
        headers[BYOK_MODEL_HEADER] = model.strip()
    return headers


def forwarding_headers(credentials: Optional[ByokCredentials] = None) -> dict[str, str]:
    credentials = credentials or current_byok_credentials()
    if not credentials or not credentials.available:
        return {}
    headers = {BYOK_AUTH_HEADER: credentials.authorization}
    if credentials.model:
        headers[BYOK_MODEL_HEADER] = credentials.model
    return headers


def current_byok_credentials() -> Optional[ByokCredentials]:
    return _CURRENT_BYOK.get()


def _credentials_from_scope(scope: Mapping[str, Any]) -> ByokCredentials:
    values: dict[str, str] = {}
    for raw_name, raw_value in scope.get("headers", []) or []:
        try:
            name = raw_name.decode("latin-1").lower()
            value = raw_value.decode("latin-1")
        except (AttributeError, UnicodeDecodeError):
            continue
        values[name] = value
    return ByokCredentials(
        authorization=values.get(BYOK_AUTH_HEADER.lower(), "").strip(),
        model=values.get(BYOK_MODEL_HEADER.lower(), "").strip(),
    )


class ByokContextMiddleware:
    """Bind caller BYOK headers to each stateful FastMCP session task."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        token = _CURRENT_BYOK.set(_credentials_from_scope(scope))
        try:
            await self.app(scope, receive, send)
        finally:
            _CURRENT_BYOK.reset(token)
