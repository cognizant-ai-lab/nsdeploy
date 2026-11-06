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
import inspect
import json
import sys
from pathlib import Path
from typing import Any, Dict

from nsdeploy.coded_tool_module import CodedToolModule

_JSON_TO_PY = {"string": str, "integer": int, "number": float,
               "boolean": bool, "array": list, "object": dict}


def _make_tool_function(coded: Any, parameters: Dict[str, Any]):
    """Build an async function whose signature mirrors the tool's JSON-Schema params,
    so FastMCP advertises a correct inputSchema, and which forwards to the coded tool.
    The signature is built with `inspect`, so parameter names must be identifiers.
    """
    try:
        from neuro_san.interfaces.coded_tool import CodedTool
        use_async = type(coded).async_invoke is not CodedTool.async_invoke
    except Exception:
        use_async = hasattr(coded, "async_invoke") and not hasattr(coded, "invoke")

    async def _toolfn(**args: Any) -> str:
        args = {k: v for k, v in args.items() if v is not None}
        if use_async:
            result = await coded.async_invoke(args, {})
        else:
            result = coded.invoke(args, {})
        return result if isinstance(result, str) else json.dumps(result, default=str)

    props = (parameters or {}).get("properties", {}) or {}
    required = set((parameters or {}).get("required", []) or [])
    sig_params = []
    # Add one keyword-only parameter per schema property.
    for pname, pdef in props.items():
        ann = _JSON_TO_PY.get((pdef or {}).get("type"), str)
        default = inspect.Parameter.empty if pname in required else None
        # inspect.Parameter raises ValueError for a name that is not an identifier.
        sig_params.append(inspect.Parameter(pname, inspect.Parameter.KEYWORD_ONLY, default=default, annotation=ann))
    _toolfn.__signature__ = inspect.Signature(sig_params, return_annotation=str)
    return _toolfn


def main() -> int:
    parser = argparse.ArgumentParser(description="Host one studio tool as an MCP server.")
    parser.add_argument("--studio", required=True)
    parser.add_argument("--spec", required=True)
    args = parser.parse_args()

    studio_root = str(Path(args.studio).resolve())
    if studio_root not in sys.path:
        sys.path.insert(0, studio_root)

    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    from mcp.server.fastmcp import FastMCP

    module_name = CodedToolModule.find_dotted(Path(studio_root), spec.get("module"))
    class_name = spec.get("class_name")
    if module_name is None or not isinstance(class_name, str) or not class_name.isidentifier():
        raise SystemExit(f"[mcp_host] spec does not name a studio coded tool: {spec.get('module')}.{class_name}")
    module = importlib.import_module(module_name)
    tool_class = getattr(module, class_name)
    coded = tool_class()

    mcp = FastMCP(spec["name"], port=int(spec["port"]))
    fn = _make_tool_function(coded, spec.get("parameters") or {})
    fn.__name__ = spec["name"]
    fn.__doc__ = spec.get("description") or spec["name"]
    mcp.tool(name=spec["name"], description=spec.get("description") or spec["name"])(fn)

    # The browser calls this MCP server cross-origin (different port from the site),
    # so it must send CORS headers and expose the MCP session header to JS.
    import uvicorn
    from starlette.middleware.cors import CORSMiddleware

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
