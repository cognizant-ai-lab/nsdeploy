"""
Generic MCP host: run a single neuro-san-studio coded/toolbox tool as a standalone
MCP server (FastMCP, streamable-http) — so the browser agent network can call it via
the MCP protocol with no neuro-san server involved.

Run as a subprocess:
    python -m nsdeploy.mcp_host --studio <studio_root> --spec <spec.json>

where spec.json is:
    {"name", "module", "class_name", "description", "parameters", "port"}

`module`/`class_name` import the studio CodedTool (e.g. coded_tools.ddgs_search.
DdgsSearch). Its `invoke(args, sly_data)` (or `async_invoke`) is exposed as one MCP
tool whose input schema is built from the tool's JSON-Schema `parameters`. sly_data
is intentionally empty here — these public tools get no host secrets.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Any
from typing import Dict

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.cors import CORSMiddleware

# Optional so the host still runs tools when neuro_san is absent.
try:
    from neuro_san.interfaces.coded_tool import CodedTool
except ImportError:
    CodedTool = None

_JSON_TO_PY = {"string": "str", "integer": "int", "number": "float",
               "boolean": "bool", "array": "list", "object": "dict"}


def _make_tool_function(coded: Any, parameters: Dict[str, Any]):  # pylint: disable=too-many-locals; codegen state
    """Build an async function whose signature mirrors the tool's JSON-Schema params,
    so FastMCP advertises a correct inputSchema, and which forwards to the coded tool.
    """
    try:
        use_async = type(coded).async_invoke is not CodedTool.async_invoke
    # Any attribute failure, including an absent neuro_san, falls back to duck typing on the tool instance.
    except Exception:  # pylint: disable=broad-exception-caught
        use_async = hasattr(coded, "async_invoke") and not hasattr(coded, "invoke")

    async def _run(args: Dict[str, Any]) -> str:
        args = {k: v for k, v in args.items() if v is not None}
        if use_async:
            result = await coded.async_invoke(args, {})
        else:
            result = coded.invoke(args, {})
        return result if isinstance(result, str) else json.dumps(result, default=str)

    props = (parameters or {}).get("properties", {}) or {}
    required = set((parameters or {}).get("required", []) or [])
    sig_parts, collect_parts = [], []
    for pname, pdef in props.items():
        ann = _JSON_TO_PY.get((pdef or {}).get("type"), "str")
        sig_parts.append(f"{pname}: {ann}" if pname in required else f"{pname}: {ann} = None")
        collect_parts.append(f"{pname!r}: {pname}")
    sig = ", ".join(sig_parts)
    collect = "{" + ", ".join(collect_parts) + "}"
    src = f"async def _toolfn({sig}):\n    return await _run({collect})\n"
    namespace: Dict[str, Any] = {"_run": _run}
    exec(src, namespace)  # noqa: S102 pylint: disable=exec-used; controlled codegen from a resolved schema
    return namespace["_toolfn"]


def main() -> int:
    """
    Host one studio coded tool as a streamable-http MCP server.

    :return: The process exit code.
    """
    parser = argparse.ArgumentParser(description="Host one studio tool as an MCP server.")
    parser.add_argument("--studio", required=True)
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()

    studio_root = str(Path(args.studio).resolve())
    if studio_root not in sys.path:
        sys.path.insert(0, studio_root)

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))

    module = importlib.import_module(spec["module"])
    tool_class = getattr(module, spec["class_name"])
    coded = tool_class()

    mcp = FastMCP(spec["name"], port=int(spec["port"]))
    fn = _make_tool_function(coded, spec.get("parameters") or {})
    fn.__name__ = spec["name"]
    fn.__doc__ = spec.get("description") or spec["name"]
    mcp.tool(name=spec["name"], description=spec.get("description") or spec["name"])(fn)

    # The browser calls this MCP server cross-origin (different port from the site),
    # so it must send CORS headers and expose the MCP session header to JS.

    app = mcp.streamable_http_app()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Mcp-Session-Id", "mcp-session-id"],
    )
    print(f"[mcp_host] {spec['name']} ({spec['module']}.{spec['class_name']}) on :{spec['port']}/mcp", flush=True)
    uvicorn.run(app, host=mcp.settings.host, port=int(spec["port"]), log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
