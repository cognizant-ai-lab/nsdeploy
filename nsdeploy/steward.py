"""Private Neuro-SAN coded tool for reaching public nsDeploy agent sites.

This is intentionally a deny-list gateway.  A steward is an operator-owned
network, so its policy belongs to the operator's server environment rather than
to the public site's published links.
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.parse
import urllib.request
from typing import Any, Dict

from neuro_san.interfaces.coded_tool import CodedTool

from nsdeploy.byok import byok_headers


PUBLIC_SITE_REQUEST_TIMEOUT_SECONDS = float(
    os.environ.get("NSDEPLOY_STEWARD_SITE_TIMEOUT_SECONDS", "720")
)


def _origin(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""


def _mcp_http_timeout(seconds: float):
    import httpx

    short = min(30.0, seconds)
    return httpx.Timeout(seconds, connect=short, pool=short)


class PublicAgentMcpGateway(CodedTool):
    """Discover and invoke a public nsDeploy site's streamable HTTP MCP facade."""

    async def async_invoke(self, args: Dict[str, Any], sly_data: Dict[str, Any]) -> str:
        site_url = str(args.get("site_url", "")).strip()
        request = str(args.get("request", "")).strip()
        if not site_url or not request:
            return "Error: site_url and request are required."
        site_parsed = urllib.parse.urlparse(site_url)
        if site_parsed.scheme not in ("http", "https") or not site_parsed.netloc:
            return "Error: site_url must resolve to an http(s) public agent site."
        denied = {
            item.strip().rstrip("/")
            for item in os.environ.get("NSDEPLOY_STEWARD_DENY_ORIGINS", "").split(",")
            if item.strip()
        }
        if _origin(site_url).rstrip("/") in denied:
            return "Denied by the steward's NSDEPLOY_STEWARD_DENY_ORIGINS policy."
        endpoint = await asyncio.to_thread(self._endpoint_for, site_url)
        parsed = urllib.parse.urlparse(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return "Error: site_url must resolve to an http(s) public agent site."
        if _origin(endpoint).rstrip("/") in denied:
            return "Denied by the steward's NSDEPLOY_STEWARD_DENY_ORIGINS policy."
        api_key = (
            os.environ.get("NSDEPLOY_STEWARD_BYOK_API_KEY", "").strip()
            or os.environ.get("OPENAI_API_KEY", "").strip()
        )
        model = os.environ.get("NSDEPLOY_STEWARD_BYOK_MODEL", "gpt-4o").strip()
        caller_headers = byok_headers(api_key, model)
        if not caller_headers:
            return (
                "Error: caller BYOK credentials are required. Set "
                "NSDEPLOY_STEWARD_BYOK_API_KEY (or OPENAI_API_KEY) on the private Neuro-SAN server."
            )

        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client
            import httpx

            # Do not wait indefinitely for a remote public network. Disabling
            # automatic DELETE on context exit also lets cancellation interrupt
            # a long-lived SSE stream immediately; a timed-out request must not
            # hold the private steward's whole execution open.
            async with asyncio.timeout(PUBLIC_SITE_REQUEST_TIMEOUT_SECONDS):
                timeout = _mcp_http_timeout(PUBLIC_SITE_REQUEST_TIMEOUT_SECONDS)
                async with httpx.AsyncClient(
                    timeout=timeout, follow_redirects=True, headers=caller_headers
                ) as client:
                    async with streamable_http_client(
                        endpoint, http_client=client, terminate_on_close=False
                    ) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            tools = (await session.list_tools()).tools
                            if not tools:
                                return "Error: the public site exposed no MCP tools."
                            tool = next((item for item in tools if item.name == "invoke_network"), tools[0])
                            fields = (tool.inputSchema or {}).get("properties", {}) or {}
                            argument_name = "request" if "request" in fields else (next(iter(fields), "request"))
                            result = await session.call_tool(tool.name, {argument_name: request})
            return " ".join(getattr(item, "text", str(item)) for item in (result.content or []))
        except TimeoutError:
            return (
                f"Public agent site timed out after {PUBLIC_SITE_REQUEST_TIMEOUT_SECONDS:g} seconds; "
                "do not retry it in this turn."
            )
        except Exception as exc:
            return f"Public agent site call failed: {exc}"

    @staticmethod
    def _endpoint_for(site_url: str) -> str:
        parsed = urllib.parse.urlparse(site_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return ""
        if parsed.path.rstrip("/").endswith("/mcp"):
            return site_url.rstrip("/")
        root = f"{parsed.scheme}://{parsed.netloc}"
        try:
            with urllib.request.urlopen(root + "/.well-known/nsdeploy-agent.json", timeout=40) as response:
                descriptor = json.loads(response.read().decode("utf-8"))
            endpoint = descriptor.get("endpoint")
            if isinstance(endpoint, str) and endpoint:
                return urllib.parse.urljoin(root + "/", endpoint)
        except Exception:
            pass
        return root + "/mcp"
