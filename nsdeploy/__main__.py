"""
nsdeploy — take a neuro-san(-studio) agent-network HOCON, check its dependencies,
host its tools as MCP servers, generate a static site, and serve the network as a
website. No neuro-san server; the browser runtime runs the agents.

By default the tool files it needs (aaosa.hocon, toolbox_info.hocon, coded-tool
sources, …) are pulled from the public neuro-san-studio GitHub repo — no local studio
checkout required. Use --studio to point at a local checkout instead.

Usage:
    python -m nsdeploy <network.hocon> [--repo R --ref REF | --studio DIR]
                       [--port N] [--out DIR] [--no-serve] [--upstream URL]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from nsdeploy.generate import generate_site
from nsdeploy.linker import load_deploy_links, run_link_command
from nsdeploy.launcher import serve
from nsdeploy.resolve import build_plan, format_report, load_toolbox_info, resolve_hocon
from nsdeploy.studio import DEFAULT_REF, DEFAULT_REPO, GithubStudio, LocalStudio
from nsdeploy.theme import load_theme_file, propose_theme


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "link":
        return run_link_command(sys.argv[2:])

    ap = argparse.ArgumentParser(prog="nsdeploy", description=__doc__)
    ap.add_argument("hocon", help="path to the agent-network HOCON")
    ap.add_argument("--studio", default=None, help="local neuro-san-studio checkout (overrides GitHub)")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo for tool files (default {DEFAULT_REPO})")
    ap.add_argument("--ref", default=DEFAULT_REF, help=f"git ref/branch/tag (default {DEFAULT_REF})")
    ap.add_argument("--port", type=int, default=8080, help="site port (default 8080)")
    ap.add_argument("--site-url", default=None,
                    help="public site origin used in manifests/links (default: local --port URL)")
    ap.add_argument("--out", default=None, help="output site dir (default: ./.nsdeploy/<name>)")
    ap.add_argument("--upstream", default="https://api.openai.com/v1",
                    help="RUNTIME BYOK proxy upstream — where the page's key is forwarded (default OpenAI)")
    ap.add_argument("--runtime-dir", default=None, help="neuro-san-web runtime dir (default: vendored ./runtime)")
    ap.add_argument("--links", default=None, help="link sidecar JSON (default: <hocon>.links.json when present)")
    ap.add_argument("--link", action="append", default=[], metavar="REF=URL",
                    help="bind a dangling agent reference to a remote nsDeploy network (repeatable)")
    ap.add_argument("--no-cruse", action="store_true",
                    help="don't inject the CRUSE generative-UI directive into agents")
    # Tier-1 LLM theming (opt-in, DEPLOY-TIME only — independent of the runtime BYOK).
    ap.add_argument("--theme", action="store_true",
                    help="polish index.html via an LLM (needs $OPENAI_API_KEY or --theme-key)")
    ap.add_argument("--theme-model", default="gpt-4o-mini", help="model for --theme (default gpt-4o-mini)")
    ap.add_argument("--theme-upstream", default=None,
                    help="endpoint for the --theme call (defaults to OpenAI; set this when "
                         "theming via a different provider, e.g. a local Ollama)")
    ap.add_argument("--theme-key", default=None, help="API key for --theme (else $OPENAI_API_KEY)")
    ap.add_argument("--theme-file", default=None, help="use a pinned theme.json (no LLM, no key)")
    ap.add_argument("--theme-refresh", action="store_true", help="ignore the theme cache and re-ask the LLM")
    ap.add_argument("--no-serve", action="store_true", help="generate the site but don't launch")
    args = ap.parse_args()

    hocon_path = Path(args.hocon).resolve()
    if not hocon_path.is_file():
        print(f"error: HOCON not found: {hocon_path}", file=sys.stderr)
        return 2

    if args.studio:
        source = LocalStudio(args.studio)
        print(f"▶ Resolving {hocon_path.name} (studio: {source.root}) …\n")
    else:
        source = GithubStudio(args.repo, args.ref)
        print(f"▶ Resolving {hocon_path.name} (tools from github:{args.repo}@{args.ref}) …\n")

    network_name = hocon_path.stem
    config, missing_includes = resolve_hocon(hocon_path, source)
    try:
        links_path = Path(args.links).resolve() if args.links else None
        if links_path is not None and not links_path.is_file():
            raise ValueError(f"link file not found: {links_path}")
        deploy_links = load_deploy_links(hocon_path, network_name, links_path, args.link)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if deploy_links:
        configured = dict(config.get("links", {}) or {})
        configured.update(deploy_links)
        config["links"] = configured
    toolbox_info = load_toolbox_info(source)
    plan = build_plan(config, toolbox_info, network_name, missing_includes, source)

    print(format_report(plan))
    print()

    if not plan.front_man:
        print("error: no front-man agent (an agent with `instructions` and no class/toolbox).", file=sys.stderr)
        return 1

    # Resolve the theme (Tier 1). Default look unless pinned (--theme-file) or LLM
    # theming (--theme) with a key; any failure falls back to the default.
    theme = None
    if args.theme_file:
        theme = load_theme_file(Path(args.theme_file))
        print(f"   theme: using pinned {args.theme_file}")
    elif args.theme:
        key = args.theme_key or os.environ.get("OPENAI_API_KEY", "")
        if not key:
            print("   theme: --theme set but no key ($OPENAI_API_KEY / --theme-key) — using the default look")
        else:
            theme_upstream = args.theme_upstream or "https://api.openai.com/v1"
            theme = propose_theme(plan, model=args.theme_model, api_key=key,
                                  upstream=theme_upstream, refresh=args.theme_refresh)
            print(f"   theme: proposed via {args.theme_model} (brand: {theme.brand or '—'})")

    out_dir = Path(args.out).resolve() if args.out else (Path.cwd() / ".nsdeploy" / network_name)
    site_base = (args.site_url or f"http://127.0.0.1:{args.port}").rstrip("/")
    mock_router = f"{site_base}/v1"
    byok_router = f"{site_base}/byok/v1"
    generate_site(plan, out_dir, mock_router, byok_router, site_base, cruse=not args.no_cruse, theme=theme)
    print(f"✅ Generated site → {out_dir}" + ("" if args.no_cruse else "  (+CRUSE generative UI)"))

    if args.no_serve:
        print("   (--no-serve: not launching)")
        return 0

    runtime_dir = Path(args.runtime_dir).resolve() if args.runtime_dir else None
    # source.root holds the (materialized) coded-tool sources the MCP hosts import.
    serve(out_dir, plan, source.root, port=args.port, upstream=args.upstream,
          runtime_dir=runtime_dir, ext_mcps=plan.external_mcps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
