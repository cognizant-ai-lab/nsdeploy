"""MCP facade for a deployed public nsDeploy network.

The browser runtime remains the primary execution path.  This small server-side
runner gives private stewards a machine-facing path with the same network JSON,
using caller-owned credentials propagated over MCP or a deterministic mock mode.
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
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from nsdeploy.byok import (
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


class NetworkRunner:
    """Runs the deployed network for MCP callers. There is deliberately no server-side
    LLM credential here: every real completion uses the caller's BYOK headers
    (see `_complete`), and the launcher starts this process with provider credentials
    scrubbed from its environment."""

    def __init__(self, config: Dict[str, Any], site_base: str, upstream: str, max_steps: int = 8):
        self.config = config
        self.site_base = site_base.rstrip("/")
        self.upstream = upstream.rstrip("/")
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

    async def run(self, request: str, front_man: str) -> str:
        if front_man not in self.agents:
            return "Error: the deployed network has no front-man agent."
        credentials = current_byok_credentials()
        if not self.upstream.startswith("mock://") and not (credentials and credentials.available):
            return (
                "Error: caller BYOK credentials are required for this public agent site. "
                "The private steward must provide them on the MCP transport."
            )
        clean_request, visited_sites, remaining_calls = _unpack_context(request)
        current_site = _site_key(self.site_base)
        if current_site:
            visited_sites.add(current_site)
        budget = {"remaining": remaining_calls}
        return await self._run_agent(front_man, clean_request, 0, visited_sites, budget)

    async def _run_agent(self, name: str, request: str, depth: int,
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
            endpoint = self._mcp_endpoint(ref)
            if not endpoint:
                continue
            if _is_public_site_ref(str(ref)):
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
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client

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
        except Exception:
            self.mcp_cache[endpoint] = []
            return []

    async def _call_tool(self, name: str, arguments: Dict[str, Any], tools: List[Dict[str, Any]],
                         depth: int, visited_sites: set[str], budget: Dict[str, int]) -> str:
        spec = next((item for item in tools if item["name"] == name), None)
        if not spec:
            return f"Unknown public-network tool: {name}"
        if spec["kind"] == "agent":
            request = arguments.get("request") or arguments.get("inquiry") or next(iter(arguments.values()), "")
            return await self._run_agent(name, _text(request), depth + 1,
                                         visited_sites, budget)
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
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client

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
        except Exception as exc:
            return f"MCP tool call failed: {exc}"

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
        credentials = current_byok_credentials()
        if not credentials or not credentials.available:
            return {"message": {"role": "assistant", "content":
                    "Facade LLM failed: caller BYOK credentials are required."}}
        body = {"model": credentials.model or self.model,
                "messages": messages, "stream": False}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": item["name"],
                          "description": item.get("description", item["name"]),
                          "parameters": item.get("parameters") or {"type": "object"}}} for item in tools]
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
    from mcp.server.fastmcp import FastMCP
    import uvicorn
    from starlette.middleware.cors import CORSMiddleware

    runner = NetworkRunner(config, site_base, upstream)
    mcp = FastMCP("nsdeploy-public-facade", port=port)

    async def invoke_network(request: str) -> str:
        return await runner.run(request, front_man)

    mcp.tool(name="invoke_network", description="Invoke this public agent network on behalf of a caller.")(invoke_network)
    app = mcp.streamable_http_app()
    app.add_middleware(ByokContextMiddleware)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["Mcp-Session-Id", "mcp-session-id"])
    server = uvicorn.Server(uvicorn.Config(app, host=mcp.settings.host, port=port, log_level="warning"))
    await server.serve()


def main() -> int:
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
