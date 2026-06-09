"""
nsdeploy — take a neuro-san(-studio) agent-network HOCON, check its dependencies,
host its tools as MCP servers, generate a static site, and serve the network as a
website. No neuro-san server; the browser runtime runs the agents.

Usage:
    python -m nsdeploy <network.hocon> [--studio DIR] [--port N] [--out DIR]
                       [--no-serve] [--upstream URL]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from nsdeploy.generate import generate_site
from nsdeploy.launcher import serve
from nsdeploy.resolve import build_plan, format_report, load_toolbox_info, resolve_hocon

# Studio (tool source) defaults to $NEURO_SAN_STUDIO; otherwise --studio is required.
DEFAULT_STUDIO = os.environ.get("NEURO_SAN_STUDIO", "")


def main() -> int:
    ap = argparse.ArgumentParser(prog="nsdeploy", description=__doc__)
    ap.add_argument("hocon", help="path to the agent-network HOCON")
    ap.add_argument("--studio", default=DEFAULT_STUDIO, help="neuro-san-studio root (tool source)")
    ap.add_argument("--port", type=int, default=8080, help="site port (default 8080)")
    ap.add_argument("--out", default=None, help="output site dir (default: ./.nsdeploy/<name>)")
    ap.add_argument("--upstream", default="https://api.openai.com/v1", help="BYOK proxy upstream")
    ap.add_argument("--runtime-dir", default=None, help="neuro-san-web runtime dir (default: vendored ./runtime)")
    ap.add_argument("--no-serve", action="store_true", help="generate the site but don't launch")
    args = ap.parse_args()

    hocon_path = Path(args.hocon).resolve()
    if not hocon_path.is_file():
        print(f"error: HOCON not found: {hocon_path}", file=sys.stderr)
        return 2
    if not args.studio:
        print("error: --studio is required (or set NEURO_SAN_STUDIO) — the neuro-san-studio "
              "checkout that provides the tools.", file=sys.stderr)
        return 2
    studio_root = Path(args.studio).resolve()
    if not studio_root.is_dir():
        print(f"error: studio root not found: {studio_root}", file=sys.stderr)
        return 2

    # The studio root must be importable so coded tools (coded_tools.*) resolve here
    # and in the spawned MCP hosts.
    if str(studio_root) not in sys.path:
        sys.path.insert(0, str(studio_root))

    network_name = hocon_path.stem
    print(f"▶ Resolving {hocon_path.name} (studio: {studio_root}) …\n")
    config, missing_includes = resolve_hocon(hocon_path, studio_root)
    toolbox_info = load_toolbox_info(studio_root)
    plan = build_plan(config, toolbox_info, network_name, missing_includes)

    print(format_report(plan))
    print()

    if not plan.front_man:
        print("error: no front-man agent (an agent with `instructions` and no class/toolbox).", file=sys.stderr)
        return 1

    out_dir = Path(args.out).resolve() if args.out else (Path.cwd() / ".nsdeploy" / network_name)
    mock_router = f"http://127.0.0.1:{args.port}/v1"
    byok_router = f"http://127.0.0.1:{args.port}/byok/v1"
    generate_site(plan, out_dir, mock_router, byok_router)
    print(f"✅ Generated site → {out_dir}")

    if args.no_serve:
        print("   (--no-serve: not launching)")
        return 0

    runtime_dir = Path(args.runtime_dir).resolve() if args.runtime_dir else None
    serve(out_dir, plan, studio_root, port=args.port, upstream=args.upstream, runtime_dir=runtime_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
