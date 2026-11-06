"""Caller-owned LLM credentials propagated across public MCP facade hops."""
from __future__ import annotations

import contextvars
from dataclasses import dataclass
from typing import Any, Mapping, Optional


BYOK_AUTH_HEADER = "X-Nsdeploy-BYOK-Authorization"
BYOK_MODEL_HEADER = "X-Nsdeploy-BYOK-Model"


@dataclass(frozen=True, repr=False)
class ByokCredentials:
    """
    Caller-owned LLM credentials whose authorization value is redacted from repr.
    """

    authorization: str = ""
    model: str = ""

    @property
    def available(self) -> bool:
        """
        Report whether an authorization value is present.

        :return: True when the credentials carry an authorization value.
        """
        return bool(self.authorization)

    def __repr__(self) -> str:
        auth = "<redacted>" if self.authorization else ""
        return f"ByokCredentials(authorization={auth!r}, model={self.model!r})"


_CURRENT_BYOK: contextvars.ContextVar[Optional[ByokCredentials]] = contextvars.ContextVar(
    "nsdeploy_current_byok", default=None
)


def authorization_for_key(api_key: str) -> str:
    """
    Convert an API key into an HTTP Bearer authorization value.

    :param api_key: The raw API key, optionally already prefixed with "Bearer ".
    :return: The authorization value, or an empty string when no key is given.
    """
    value = str(api_key or "").strip()
    if not value:
        return ""
    if value.lower().startswith("bearer "):
        return value
    return f"Bearer {value}"


def byok_headers(api_key: str, model: str = "") -> dict[str, str]:
    """
    Build the BYOK request headers for an API key and optional model.

    :param api_key: The caller's API key.
    :param model: The optional model name.
    :return: The BYOK headers, or an empty dict when no key is given.
    """
    authorization = authorization_for_key(api_key)
    if not authorization:
        return {}
    headers = {BYOK_AUTH_HEADER: authorization}
    if model.strip():
        headers[BYOK_MODEL_HEADER] = model.strip()
    return headers


def forwarding_headers(credentials: Optional[ByokCredentials] = None) -> dict[str, str]:
    """
    Build the BYOK headers that forward credentials to the next facade hop.

    :param credentials: The credentials to forward; defaults to those bound to the current context.
    :return: The BYOK headers, or an empty dict when no credentials are available.
    """
    credentials = credentials or current_byok_credentials()
    if not credentials or not credentials.available:
        return {}
    headers = {BYOK_AUTH_HEADER: credentials.authorization}
    if credentials.model:
        headers[BYOK_MODEL_HEADER] = credentials.model
    return headers


def current_byok_credentials() -> Optional[ByokCredentials]:
    """
    Return the BYOK credentials bound to the current context.

    :return: The bound credentials, or None when none are bound.
    """
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
