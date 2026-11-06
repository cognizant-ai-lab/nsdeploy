"""Data-only runner and MCP facade for deployed public nsDeploy networks.

The browser runtime remains the primary execution path.  This small server-side
runner can execute the same published network JSON inside a private steward or
expose it through MCP, using caller-owned credentials or a deterministic mock mode.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import json
import os
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from nsdeploy.byok import (
    ByokCredentials,
    ByokContextMiddleware,
    current_byok_credentials,
    forwarding_headers,
)


PUBLIC_SITE_CALL_BUDGET = 12
PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS = float(
    os.environ.get("NSDEPLOY_FACADE_SITE_TIMEOUT_SECONDS", "480")
)
MOCK_TOOL_CALLS_PER_AGENT = 1
_CONTEXT_MARKER = "\n\n__NSDEPLOY_PUBLIC_CONTEXT__:"
MAX_PUBLISHED_NETWORK_BYTES = 2 * 1024 * 1024


@dataclass
class PublishedNetwork:
    """
    A validated public network fetched from a deployed nsDeploy site.
    """
    site_base: str
    network: str
    front_man: str
    config: Dict[str, Any]

    @property
    def key(self) -> str:
        """
        Return the case-insensitive identity of this network.

        :return: The "<site_base>::<network>" key in lowercase.
        """
        return f"{self.site_base}::{self.network}".lower()


def _published_target(site_url: str) -> Tuple[str, str]:
    parsed = urllib.parse.urlparse(str(site_url).strip())
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("public agent site URL must use http or https")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    path = parsed.path.rstrip("/")
    if path:
        parent, _, requested = path.rpartition("/")
        site_base = origin + parent
    else:
        site_base, requested = origin, ""
    return site_base, requested


# pylint: disable-next=too-many-locals,too-many-branches  # sequential validation of the published payload
async def load_published_network(site_url: str) -> PublishedNetwork:
    """Fetch and validate one public network without executing publisher code."""
    site_base, requested = _published_target(site_url)
    timeout = _mcp_http_timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        manifest_url = f"{site_base}/agent-manifest.json"
        manifest_response = await client.get(manifest_url)
        manifest_response.raise_for_status()
        if _site_key(str(getattr(manifest_response, "url", manifest_url))) != _site_key(site_base):
            raise ValueError("published agent manifest redirected to another origin")
        if len(manifest_response.content) > MAX_PUBLISHED_NETWORK_BYTES:
            raise ValueError("published agent manifest is too large")
        manifest = manifest_response.json()
        networks = manifest.get("networks") if isinstance(manifest, dict) else None
        if not isinstance(networks, list) or not all(isinstance(item, dict) for item in networks):
            raise ValueError("published agent manifest has an invalid network list")
        if requested:
            entry = next((item for item in networks if item.get("name") == requested), None)
        else:
            entry = networks[0] if len(networks) == 1 else None
        if not entry:
            names = ", ".join(str(item.get("name", "")) for item in networks) or "none"
            raise ValueError(
                f"no unique published network matching '{requested or '(site root)'}'; available: {names}"
            )
        network = str(entry.get("name") or "")
        hocon = entry.get("hocon")
        if not network or not isinstance(hocon, str) or not hocon:
            raise ValueError("published network entry is incomplete")
        config_url = urllib.parse.urljoin(site_base + "/", hocon)
        if _site_key(config_url) != _site_key(site_base):
            raise ValueError("published network definition must stay on the site's origin")
        config_response = await client.get(config_url)
        config_response.raise_for_status()
        if _site_key(str(getattr(config_response, "url", config_url))) != _site_key(site_base):
            raise ValueError("published network definition redirected to another origin")
        if len(config_response.content) > MAX_PUBLISHED_NETWORK_BYTES:
            raise ValueError("published network definition is too large")
        config = config_response.json()
    tools = config.get("tools") if isinstance(config, dict) else None
    if not isinstance(tools, list) or len(tools) > 200:
        raise ValueError("published network has an invalid tool list")
    # Public definitions are data, never import instructions. A static/deployed
    # network should contain agents only; Python class/toolbox entries fail closed.
    if any(not isinstance(item, dict) or "class" in item or "toolbox" in item for item in tools):
        raise ValueError("published network contains executable server-side tool definitions")
    agents = [item for item in tools if item.get("name") and "instructions" in item]
    if not agents:
        raise ValueError("published network contains no runnable agents")
    front_man = str(entry.get("front_man") or agents[0]["name"])
    if not any(item.get("name") == front_man for item in agents):
        raise ValueError(f"published front-man agent '{front_man}' was not found")
    return PublishedNetwork(site_base, network, front_man, config)


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_text(item.get("text", item)) if isinstance(item, dict) else _text(item) for item in value)
    return json.dumps(value, default=str)


def _safe_name(value: str) -> str:
    return "mcp_" + hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def _site_key(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}".rstrip("/").lower()


def _is_public_site_ref(value: str) -> bool:
    parsed = urllib.parse.urlparse(str(value))
    path = parsed.path.rstrip("/")
    return (
        parsed.scheme in ("http", "https")
        and bool(parsed.netloc)
        and not path.endswith("/mcp")
        and "/_mcp/" not in path
        and "/ext-mcp/" not in path
    )


def _mcp_http_timeout(seconds: float) -> httpx.Timeout:
    short = min(30.0, seconds)
    return httpx.Timeout(seconds, connect=short, pool=short)


def _pack_context(request: str, visited_sites: set[str], remaining_calls: int) -> str:
    context = {
        "visited_sites": sorted(visited_sites),
        "remaining_calls": max(0, remaining_calls),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(context, separators=(",", ":")).encode()).decode()
    return f"{request}{_CONTEXT_MARKER}{encoded}"


def _unpack_context(request: str) -> Tuple[str, set[str], int]:
    if _CONTEXT_MARKER not in request:
        return request, set(), PUBLIC_SITE_CALL_BUDGET
    clean_request, encoded = request.rsplit(_CONTEXT_MARKER, 1)
    try:
        context = json.loads(base64.urlsafe_b64decode(encoded.encode()).decode())
    except (ValueError, UnicodeError, binascii.Error):
        return request, set(), PUBLIC_SITE_CALL_BUDGET
    if not isinstance(context, dict):
        return request, set(), PUBLIC_SITE_CALL_BUDGET
    visited = {str(item) for item in context.get("visited_sites", []) if isinstance(item, str)}
    try:
        remaining = max(0, int(context.get("remaining_calls", PUBLIC_SITE_CALL_BUDGET)))
    except (TypeError, ValueError):
        remaining = PUBLIC_SITE_CALL_BUDGET
    return clean_request, visited, remaining


class NetworkRunner:  # pylint: disable=too-many-instance-attributes
    """Run published network data for a private steward or public MCP caller.

    The public facade deliberately has no server-owned LLM credential. Private
    fetch-and-run supplies explicit steward credentials, while facade execution uses
    the caller's BYOK context. The launcher scrubs provider credentials from the
    public facade process.
    """

    # pylint: disable-next=too-many-arguments  # keyword-only options
    def __init__(self, config: Dict[str, Any], site_base: str, upstream: str, max_steps: int = 8,
                 *, credentials: Optional[ByokCredentials] = None,
                 public_network_mode: str = "mcp", network_name: str = "",
                 denied_origins: Optional[set[str]] = None):
        self.config = config
        self.site_base = site_base.rstrip("/")
        self.upstream = upstream.rstrip("/")
        self.credentials = credentials
        self.public_network_mode = public_network_mode
        self.network_name = network_name or "network"
        self.network_key = f"{self.site_base}::{self.network_name}".lower()
        self.denied_origins = {
            origin for origin in (_site_key(item) for item in (denied_origins or set())) if origin
        }
        self.model = (
            os.environ.get("NSDEPLOY_FACADE_MODEL")
            or (config.get("llm_config", {}) or {}).get("model_name")
            or "gpt-4o"
        )
        self.max_steps = max_steps
        self.agents = {
            item.get("name"): item for item in config.get("tools", []) or []
            if item.get("name") and "instructions" in item
        }
        self.mcp_cache: Dict[str, List[Dict[str, Any]]] = {}

    @classmethod
    async def from_public_site(cls, site_url: str, upstream: str, *,
                               credentials: Optional[ByokCredentials] = None,
                               denied_origins: Optional[set[str]] = None,
                               max_steps: int = 8) -> Tuple["NetworkRunner", PublishedNetwork]:
        """
        Fetch a public network and build a runner for it.

        :param site_url: The public site or network URL.
        :param upstream: The LLM endpoint base URL.
        :param credentials: The caller BYOK credentials, or None to use the request context.
        :param denied_origins: Origins the private web policy refuses.
        :param max_steps: The maximum LLM steps per agent.
        :return: The runner and the published network it runs.
        :raises PermissionError: If the site origin is denied.
        :raises ValueError: If the site URL or published network is invalid.
        """
        denied = {
            origin for origin in (_site_key(item) for item in (denied_origins or set())) if origin
        }
        if _site_key(site_url) in denied:
            raise PermissionError(f"origin {_site_key(site_url)} is denied by the private web policy")
        published = await load_published_network(site_url)
        if _site_key(published.site_base) in denied:
            raise PermissionError(f"origin {published.site_base} is denied by the private web policy")
        runner = cls(
            published.config, published.site_base, upstream, max_steps=max_steps,
            credentials=credentials, public_network_mode="fetch",
            network_name=published.network, denied_origins=denied_origins,
        )
        return runner, published

    def _active_credentials(self) -> Optional[ByokCredentials]:
        return self.credentials or current_byok_credentials()

    async def run(self, request: str, front_man: str) -> str:
        """
        Run a request through the network starting at its front-man agent.

        :param request: The caller request, optionally carrying packed public context.
        :param front_man: The name of the front-man agent.
        :return: The network's final text answer or an error message.
        """
        if front_man not in self.agents:
            return "Error: the deployed network has no front-man agent."
        credentials = self._active_credentials()
        if not self.upstream.startswith("mock://") and not (credentials and credentials.available):
            return (
                "Error: caller BYOK credentials are required for this public agent site. "
                "The private steward must provide them for local execution."
            )
        clean_request, visited_sites, remaining_calls = _unpack_context(request)
        current_site = self.network_key if self.public_network_mode == "fetch" else _site_key(self.site_base)
        if current_site:
            visited_sites.add(current_site)
        budget = {"remaining": remaining_calls}
        return await self._run_agent(front_man, clean_request, 0, visited_sites, budget)

    async def _run_agent(self, name: str, request: str, depth: int,  # pylint: disable=too-many-locals
                         visited_sites: set[str], budget: Dict[str, int]) -> str:
        if depth > 5:
            return "The public network reached its delegation depth limit."
        agent = self.agents[name]
        tools = await self._tools_for(agent)
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": str(agent.get("instructions", ""))},
            {"role": "user", "content": request},
        ]
        for _ in range(self.max_steps):
            reply = await self._complete(messages, tools)
            message = reply.get("message", {})
            calls = message.get("tool_calls") or []
            if not calls:
                return _text(message.get("content", "")) or "The public network returned no text."
            assistant = {"role": "assistant", "content": message.get("content"), "tool_calls": calls}
            messages.append(assistant)
            for call in calls:
                function = call.get("function", {})
                tool_name = function.get("name", "")
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                except json.JSONDecodeError:
                    arguments = {"request": function.get("arguments", "")}
                result = await self._call_tool(tool_name, arguments, tools, depth,
                                               visited_sites, budget)
                messages.append({"role": "tool", "tool_call_id": call.get("id", tool_name),
                                 "name": tool_name, "content": result})
        return "The public network reached its tool-step limit without a final answer."

    async def _tools_for(self, agent: Dict[str, Any]) -> List[Dict[str, Any]]:
        result: List[Dict[str, Any]] = []
        for ref in agent.get("tools", []) or []:
            if ref in self.agents:
                spec = self.agents[ref]
                function = spec.get("function", {}) or {}
                result.append({"name": ref, "description": function.get("description", ref),
                               "parameters": function.get("parameters") or {
                                   "type": "object", "properties": {"request": {"type": "string"}},
                                   "required": ["request"]
                               }, "kind": "agent"})
                continue
            if _site_key(str(ref)) in self.denied_origins:
                continue
            endpoint = self._mcp_endpoint(ref)
            if not endpoint:
                continue
            if _is_public_site_ref(str(ref)):
                if self.public_network_mode == "fetch":
                    result.append({
                        "name": f"{_safe_name(str(ref))}__invoke_network",
                        "description": "Run the linked public agent network locally.",
                        "parameters": {
                            "type": "object",
                            "properties": {"request": {"type": "string"}},
                            "required": ["request"],
                        },
                        "kind": "network",
                        "endpoint": str(ref),
                    })
                    continue
                result.append({
                    "name": f"{_safe_name(endpoint)}__invoke_network",
                    "description": "Invoke the linked public agent site.",
                    "parameters": {
                        "type": "object",
                        "properties": {"request": {"type": "string"}},
                        "required": ["request"],
                    },
                    "kind": "mcp",
                    "endpoint": endpoint,
                    "remote_name": "invoke_network",
                })
                continue
            for item in await self._discover_mcp(endpoint):
                result.append(item)
        return result

    def _mcp_endpoint(self, ref: str) -> str:
        parsed = urllib.parse.urlparse(str(ref))
        if parsed.scheme not in ("http", "https"):
            return ""
        if parsed.path.rstrip("/").endswith("/mcp"):
            return str(ref).rstrip("/")
        return f"{parsed.scheme}://{parsed.netloc}/mcp"

    async def _discover_mcp(self, endpoint: str) -> List[Dict[str, Any]]:
        if endpoint in self.mcp_cache:
            return self.mcp_cache[endpoint]
        try:
            # Deferred so importing the runner does not load the MCP client stack.
            from mcp import ClientSession  # pylint: disable=import-outside-toplevel
            from mcp.client.streamable_http import streamable_http_client  # pylint: disable=import-outside-toplevel

            async with asyncio.timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(
                    timeout=_mcp_http_timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS),
                    follow_redirects=True,
                ) as client:
                    async with streamable_http_client(
                        endpoint, http_client=client, terminate_on_close=False
                    ) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            response = await session.list_tools()
            items = []
            for tool in response.tools:
                name = f"{_safe_name(endpoint)}__{tool.name}"
                items.append({"name": name, "description": tool.description or tool.name,
                              "parameters": tool.inputSchema or {"type": "object"},
                              "kind": "mcp", "endpoint": endpoint, "remote_name": tool.name})
            self.mcp_cache[endpoint] = items
            return items
        except Exception:  # pylint: disable=broad-exception-caught; an unreachable server contributes no tools
            self.mcp_cache[endpoint] = []
            return []

    # One dispatcher per tool kind.
    # pylint: disable-next=too-many-arguments,too-many-positional-arguments,too-many-locals,too-many-branches
    async def _call_tool(self, name: str, arguments: Dict[str, Any],  # pylint: disable=too-many-return-statements
                         tools: List[Dict[str, Any]],
                         depth: int, visited_sites: set[str], budget: Dict[str, int]) -> str:
        spec = next((item for item in tools if item["name"] == name), None)
        if not spec:
            return f"Unknown public-network tool: {name}"
        if spec["kind"] == "agent":
            request = arguments.get("request") or arguments.get("inquiry") or next(iter(arguments.values()), "")
            return await self._run_agent(name, _text(request), depth + 1,
                                         visited_sites, budget)
        if spec["kind"] == "network":
            request = arguments.get("request") or arguments.get("inquiry") or next(iter(arguments.values()), "")
            if budget["remaining"] <= 0:
                return "Public-site call budget exhausted for this request."
            try:
                child, published = await self.from_public_site(
                    spec["endpoint"], self.upstream, credentials=self._active_credentials(),
                    denied_origins=self.denied_origins, max_steps=self.max_steps,
                )
                if published.key in visited_sites:
                    return f"Skipped recursive call to public network {published.key}."
                budget["remaining"] -= 1
                next_visited = set(visited_sites)
                next_visited.add(published.key)
                return await child._run_agent(  # pylint: disable=protected-access; same class
                    published.front_man, _text(request), depth + 1, next_visited, budget,
                )
            except PermissionError as exc:
                return f"Public network denied: {exc}"
            except Exception as exc:  # pylint: disable=broad-exception-caught; tool returns any failure as text
                return f"Public network call failed: {exc}"
        target_site = _site_key(spec.get("endpoint", ""))
        if spec.get("remote_name") == "invoke_network":
            if target_site in visited_sites:
                return f"Skipped recursive call to public site {target_site}."
            if budget["remaining"] <= 0:
                return "Public-site call budget exhausted for this request."
            budget["remaining"] -= 1
            next_visited = set(visited_sites)
            next_visited.add(target_site)
            arguments = dict(arguments)
            if "request" in arguments:
                arguments["request"] = _pack_context(
                    _text(arguments["request"]), next_visited, budget["remaining"]
                )
        try:
            # Deferred so importing the runner does not load the MCP client stack.
            from mcp import ClientSession  # pylint: disable=import-outside-toplevel
            from mcp.client.streamable_http import streamable_http_client  # pylint: disable=import-outside-toplevel

            async with asyncio.timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS):
                client_headers = (
                    forwarding_headers()
                    if spec.get("remote_name") == "invoke_network"
                    else {}
                )
                async with httpx.AsyncClient(
                    timeout=_mcp_http_timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS),
                    follow_redirects=True,
                    headers=client_headers,
                ) as client:
                    async with streamable_http_client(
                        spec["endpoint"], http_client=client, terminate_on_close=False
                    ) as (read, write, _):
                        async with ClientSession(read, write) as session:
                            await session.initialize()
                            result = await session.call_tool(spec["remote_name"], arguments)
            return _text([getattr(item, "text", str(item)) for item in result.content])
        except TimeoutError:
            return (f"MCP tool call timed out after {PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS} seconds: "
                    f"{spec.get('endpoint', '')}")
        except Exception as exc:  # pylint: disable=broad-exception-caught; tool returns any failure as text
            return f"MCP tool call failed: {exc}"

    # pylint: disable-next=too-many-locals
    async def _complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
        if self.upstream.startswith("mock://"):
            called = {item.get("name") for item in messages if item.get("role") == "tool"}
            available = [item for item in tools if item["name"] not in called]
            if available and len(called) < MOCK_TOOL_CALLS_PER_AGENT:
                first = available[0]
                text = _text(next((item.get("content") for item in reversed(messages)
                                   if item.get("role") == "user"), ""))
                required = (first.get("parameters") or {}).get("required") or ["request"]
                args = {key: text for key in required}
                return {"message": {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "facade_call_" + first["name"], "type": "function",
                    "function": {"name": first["name"], "arguments": json.dumps(args)},
                }]}}
            results = [_text(item.get("content", "")) for item in messages if item.get("role") == "tool"]
            return {"message": {"role": "assistant", "content":
                                "(facade mock) " + " ".join(results)[:4000]}}
        credentials = self._active_credentials()
        if not credentials or not credentials.available:
            return {"message": {"role": "assistant", "content":
                    "Facade LLM failed: caller BYOK credentials are required."}}
        body = {"model": credentials.model or self.model,
                "messages": messages, "stream": False}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": item["name"],
                                                               "description": item.get("description", item["name"]),
                                                               "parameters": item.get("parameters")
                                                               or {"type": "object"}}} for item in tools]
        headers = {
            "Content-Type": "application/json",
            "Authorization": credentials.authorization,
        }
        try:
            async with asyncio.timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(
                    timeout=_mcp_http_timeout(PUBLIC_MCP_REQUEST_TIMEOUT_SECONDS),
                    follow_redirects=True,
                ) as client:
                    response = await client.post(
                        self.upstream + "/chat/completions",
                        content=json.dumps(body).encode(),
                        headers=headers,
                    )
                    response.raise_for_status()
                    payload = response.json()
            return {"message": payload.get("choices", [{}])[0].get("message", {})}
        except (httpx.HTTPError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
            return {"message": {"role": "assistant", "content": f"Facade LLM failed: {exc}"}}


async def _serve(config: Dict[str, Any], site_base: str, upstream: str, port: int, front_man: str):
    # Deferred so the runner can be imported without the MCP server stack.
    from mcp.server.fastmcp import FastMCP  # pylint: disable=import-outside-toplevel
    import uvicorn  # pylint: disable=import-outside-toplevel
    from starlette.middleware.cors import CORSMiddleware  # pylint: disable=import-outside-toplevel

    runner = NetworkRunner(config, site_base, upstream)
    mcp = FastMCP("nsdeploy-public-facade", port=port)

    async def invoke_network(request: str) -> str:
        return await runner.run(request, front_man)

    mcp.tool(name="invoke_network",
             description="Invoke this public agent network on behalf of a caller.")(invoke_network)
    app = mcp.streamable_http_app()
    app.add_middleware(ByokContextMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Mcp-Session-Id", "mcp-session-id"])
    server = uvicorn.Server(uvicorn.Config(app, host=mcp.settings.host, port=port, log_level="warning"))
    await server.serve()


def main() -> int:
    """
    Run the public MCP facade from command-line arguments.

    :return: The process exit code.
    """
    parser = argparse.ArgumentParser(description="Run the nsDeploy public MCP facade.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--site-base", required=True)
    parser.add_argument("--front-man", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--upstream", default="mock://nsdeploy")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    asyncio.run(_serve(config, args.site_base, args.upstream, args.port, args.front_man))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
