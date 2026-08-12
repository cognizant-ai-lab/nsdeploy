"""MCP facade for a deployed public nsDeploy network.

The browser runtime remains the primary execution path.  This small server-side
runner gives private stewards a machine-facing path with the same network JSON,
using an OpenAI-compatible server key when configured and a deterministic mode
when it is not.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_text(item.get("text", item)) if isinstance(item, dict) else _text(item) for item in value)
    return json.dumps(value, default=str)


def _safe_name(value: str) -> str:
    return "mcp_" + hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


class NetworkRunner:
    def __init__(self, config: Dict[str, Any], site_base: str, upstream: str, api_key: str,
                 max_steps: int = 8):
        self.config = config
        self.site_base = site_base.rstrip("/")
        self.upstream = upstream.rstrip("/")
        self.api_key = api_key
        self.max_steps = max_steps
        self.agents = {
            item.get("name"): item for item in config.get("tools", []) or []
            if item.get("name") and "instructions" in item
        }
        self.mcp_cache: Dict[str, List[Dict[str, Any]]] = {}

    async def run(self, request: str, front_man: str) -> str:
        if front_man not in self.agents:
            return "Error: the deployed network has no front-man agent."
        return await self._run_agent(front_man, request, 0)

    async def _run_agent(self, name: str, request: str, depth: int) -> str:
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
                result = await self._call_tool(tool_name, arguments, tools, depth)
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

            async with streamable_http_client(endpoint) as (read, write, _):
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

    async def _call_tool(self, name: str, arguments: Dict[str, Any], tools: List[Dict[str, Any]], depth: int) -> str:
        spec = next((item for item in tools if item["name"] == name), None)
        if not spec:
            return f"Unknown public-network tool: {name}"
        if spec["kind"] == "agent":
            request = arguments.get("request") or arguments.get("inquiry") or next(iter(arguments.values()), "")
            return await self._run_agent(name, _text(request), depth + 1)
        try:
            from mcp import ClientSession
            from mcp.client.streamable_http import streamable_http_client

            async with streamable_http_client(spec["endpoint"]) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(spec["remote_name"], arguments)
            return _text([getattr(item, "text", str(item)) for item in result.content])
        except Exception as exc:
            return f"MCP tool call failed: {exc}"

    async def _complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Dict[str, Any]:
        if self.upstream.startswith("mock://"):
            called = {item.get("name") for item in messages if item.get("role") == "tool"}
            available = [item for item in tools if item["name"] not in called]
            if available:
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
        body = {"model": os.environ.get("NSDEPLOY_FACADE_MODEL", "gpt-4o-mini"),
                "messages": messages, "stream": False}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": item["name"],
                          "description": item.get("description", item["name"]),
                          "parameters": item.get("parameters") or {"type": "object"}}} for item in tools]
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(self.upstream + "/chat/completions", data=json.dumps(body).encode(),
                                     method="POST", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return {"message": payload.get("choices", [{}])[0].get("message", {})}
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
            return {"message": {"role": "assistant", "content": f"Facade LLM failed: {exc}"}}


async def _serve(config: Dict[str, Any], site_base: str, upstream: str, api_key: str, port: int,
                 front_man: str):
    from mcp.server.fastmcp import FastMCP
    import uvicorn
    from starlette.middleware.cors import CORSMiddleware

    runner = NetworkRunner(config, site_base, upstream, api_key)
    mcp = FastMCP("nsdeploy-public-facade", port=port)

    async def invoke_network(request: str) -> str:
        return await runner.run(request, front_man)

    mcp.tool(name="invoke_network", description="Invoke this public agent network on behalf of a caller.")(invoke_network)
    app = mcp.streamable_http_app()
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
    parser.add_argument("--api-key", default="")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    asyncio.run(_serve(config, args.site_base, args.upstream, args.api_key, args.port, args.front_man))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
