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

from nsdeploy.coded_tool_module import CodedToolModule
from nsdeploy.hosted_tool_function import HostedToolFunction


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
    fn = HostedToolFunction(coded, spec["name"], spec.get("description") or spec["name"], spec.get("parameters") or {})
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
