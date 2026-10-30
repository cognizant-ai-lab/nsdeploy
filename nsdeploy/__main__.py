"""
nsdeploy — take a neuro-san(-studio) agent-network HOCON, check its dependencies,
host its tools as MCP servers, generate a static site, and serve the network as a
website. No neuro-san server; the browser runtime runs the agents.

By default the tool files it needs (aaosa.hocon, toolbox_info.hocon, coded-tool
sources, …) are pulled from the public neuro-san-studio GitHub repo — no local studio
checkout required. Use --studio to point at a local checkout instead.

Usage:
    python -m nsdeploy <network.hocon> [--repo R --ref REF | --studio DIR]
                       [--port N] [--out DIR] [--site-dir DIR] [--no-serve]
                       [--upstream URL]
    python -m nsdeploy gateway --base-domain DOMAIN --route NETWORK=URL [...]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from nsdeploy.generate import generate_site
from nsdeploy.gateway import run_gateway_command
from nsdeploy.linker import load_deploy_links, run_link_command
from nsdeploy.launcher import serve
from nsdeploy.resolve import build_plan, format_report, load_toolbox_info, resolve_hocon
from nsdeploy.site_source import load_site_theme, seed_site_source, site_source_exists
from nsdeploy.studio import DEFAULT_REF, DEFAULT_REPO, GithubStudio, LocalStudio
from nsdeploy.theme import DEFAULT_THEME_MODEL, ThemeSpec, load_theme_file, propose_theme


def _load_cailville():
    """Import the Cailville community helpers on demand.

    Only `nsdeploy cailville ...` and --add-to-cailville need them; a plain deploy must
    not fail to start when that module is absent from an install.
    """
    try:
        from nsdeploy import cailville
    except ImportError as exc:
        print(f"error: Cailville support is unavailable in this install: {exc}", file=sys.stderr)
        return None
    return cailville


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "gateway":
        return run_gateway_command(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "link":
        return run_link_command(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "cailville":
        cailville = _load_cailville()
        return cailville.run_cailville_command(sys.argv[2:]) if cailville else 2

    ap = argparse.ArgumentParser(prog="nsdeploy", description=__doc__)
    ap.add_argument("hocon", help="path to the agent-network HOCON")
    ap.add_argument("--studio", default=None, help="local neuro-san-studio checkout (overrides GitHub)")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repo for tool files (default {DEFAULT_REPO})")
    ap.add_argument("--ref", default=DEFAULT_REF, help=f"git ref/branch/tag (default {DEFAULT_REF})")
    ap.add_argument("--port", type=int, default=8080, help="site port (default 8080)")
    ap.add_argument("--site-url", default=None,
                    help="public site origin used in manifests/links (default: local --port URL)")
    ap.add_argument("--out", default=None,
                    help="output site dir (default: ./.nsdeploy/<source-dir>/<name>)")
    ap.add_argument("--site-dir", default=None,
                    help="editable site source dir (default: <hocon-dir>/sites/<name>)")
    ap.add_argument("--actions", default=None, metavar="FILE",
                    help="site-owned JavaScript action adapter (otherwise <site-dir>/actions.js)")
    ap.add_argument("--upstream", default="https://api.openai.com/v1",
                    help="RUNTIME BYOK proxy upstream — where the page's key is forwarded (default OpenAI)")
    ap.add_argument("--facade-upstream", default=None,
                    help="server-side facade LLM endpoint (default: $NSDEPLOY_FACADE_UPSTREAM or --upstream)")
    ap.add_argument("--facade-key", default=None,
                    help="accepted for backward compatibility and IGNORED: a served site never uses a "
                         "host-side LLM key; the facade only uses the caller's BYOK credentials")
    ap.add_argument("--runtime-dir", default=None, help="neuro-san-web runtime dir (default: vendored nsdeploy/runtime)")
    ap.add_argument("--links", default=None, help="link sidecar JSON (default: <hocon>.links.json when present)")
    ap.add_argument("--link", action="append", default=[], metavar="REF=URL",
                    help="bind a dangling agent reference to a remote nsDeploy network (repeatable)")
    ap.add_argument("--add-to-cailville", action="store_true",
                    help="add this public site and sensible peer links to the Cailville community")
    ap.add_argument("--cailville-base-map", action="store_true",
                    help="with --add-to-cailville, start from the original 13-site map")
    ap.add_argument("--cailville-no-ai-connections", action="store_true",
                    help="with --add-to-cailville, use deterministic local connection inference")
    ap.add_argument("--cailville-dir", default=None, help=argparse.SUPPRESS)
    ap.add_argument("--steward-sites", default=None,
                    help="JSON map of public site names to URLs known by the private steward")
    ap.add_argument("--no-cruse", action="store_true",
                    help="don't inject the CRUSE generative-UI directive into agents")
    # Tier-1 LLM theming (opt-in, DEPLOY-TIME only — independent of the runtime BYOK).
    ap.add_argument("--theme", action="store_true",
                    help="polish index.html via an LLM (needs $OPENAI_API_KEY or --theme-key)")
    ap.add_argument("--theme-model", default=DEFAULT_THEME_MODEL,
                    help=f"model for --theme (default {DEFAULT_THEME_MODEL})")
    ap.add_argument("--theme-upstream", default=None,
                    help="endpoint for the --theme call (defaults to OpenAI; set this when "
                         "theming via a different provider, e.g. a local Ollama)")
    ap.add_argument("--theme-key", default=None, help="API key for --theme (else $OPENAI_API_KEY)")
    ap.add_argument("--theme-prompt", default=None,
                    help="additional design instructions (use --theme-refresh for an existing theme)")
    ap.add_argument("--theme-file", default=None, help="use a pinned theme.json (no LLM, no key)")
    ap.add_argument("--theme-refresh", action="store_true",
                    help="re-ask the LLM and replace editable layout/CSS/theme metadata")
    ap.add_argument("--no-serve", action="store_true", help="generate the site but don't launch")
    ap.add_argument("--static-bundle", action="store_true",
                    help="emit a self-contained static webroot (browser mock, direct-CORS "
                         "BYOK/MCP, no Python tools or public MCP facade)")
    args = ap.parse_args()
    if args.actions and not Path(args.actions).is_file():
        ap.error("--actions must name an existing JavaScript adapter")

    if args.cailville_base_map and not args.add_to_cailville:
        ap.error("--cailville-base-map requires --add-to-cailville")
    if args.facade_key:
        print("warning: --facade-key is ignored; the public facade only uses caller BYOK credentials",
              file=sys.stderr)

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
    site_dir = (Path(args.site_dir).resolve() if args.site_dir
                else hocon_path.parent / "sites" / network_name)
    config, missing_includes = resolve_hocon(hocon_path, source)
    cailville_draft = None
    cailville = None
    if args.add_to_cailville:
        cailville = _load_cailville()
        if cailville is None:
            return 2
        try:
            cailville_draft = cailville.plan_addition(
                config, hocon_path, port=args.port, site_dir=site_dir,
                cailville_dir=Path(args.cailville_dir).resolve() if args.cailville_dir else None,
                base_map=args.cailville_base_map, model=args.theme_model,
                api_key=args.theme_key or os.environ.get("OPENAI_API_KEY", ""),
                upstream=args.theme_upstream or "https://api.openai.com/v1",
                use_model=not args.cailville_no_ai_connections,
                studio=args.studio, repo=args.repo, ref=args.ref,
            )
            config = cailville_draft.augmented_config
        except (OSError, ValueError) as exc:
            print(f"error: cannot add site to Cailville: {exc}", file=sys.stderr)
            return 2
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
    private_steward_sites = {}
    if args.steward_sites:
        try:
            steward_data = json.loads(Path(args.steward_sites).read_text(encoding="utf-8"))
            if not isinstance(steward_data, dict) or not all(
                isinstance(name, str) and isinstance(url, str)
                for name, url in steward_data.items()
            ):
                raise ValueError("expected a JSON object containing name-to-URL strings")
            private_steward_sites.update(steward_data)
        except (OSError, ValueError) as exc:
            print(f"error: cannot load private steward sites: {exc}", file=sys.stderr)
            return 2
    if cailville_draft is not None:
        private_steward_sites.update(cailville.public_site_directory(cailville_draft.community))
    toolbox_info = {} if args.static_bundle else load_toolbox_info(source)
    plan = build_plan(
        config, toolbox_info, network_name, missing_includes, source,
        include_python_tools=not args.static_bundle,
    )

    print(format_report(plan, static_bundle=args.static_bundle))
    print()

    if not plan.front_man:
        print("error: no front-man agent (an agent with `instructions` and no class/toolbox).", file=sys.stderr)
        return 1

    # Resolve the theme (Tier 1). Default look unless pinned (--theme-file) or LLM
    # theming (--theme) with a key; any failure falls back to the default.
    theme = None
    has_site_source = site_source_exists(site_dir)
    refresh_site_source = False
    if args.theme_file:
        theme = load_theme_file(Path(args.theme_file))
        print(f"   theme: using pinned {args.theme_file}")
    elif args.theme:
        if has_site_source and not args.theme_refresh:
            try:
                theme = load_site_theme(site_dir)
            except (OSError, ValueError) as exc:
                print(f"error: cannot load editable site source: {exc}", file=sys.stderr)
                return 2
            print(f"   theme: using editable source → {site_dir}")
        else:
            key = args.theme_key or os.environ.get("OPENAI_API_KEY", "")
            if not key:
                if has_site_source:
                    print("   theme: no key ($OPENAI_API_KEY / --theme-key); refresh skipped")
                    try:
                        theme = load_site_theme(site_dir)
                    except (OSError, ValueError) as exc:
                        print(f"error: cannot load editable site source: {exc}", file=sys.stderr)
                        return 2
                    print(f"   theme: editable source preserved → {site_dir}")
                else:
                    print("   theme: --theme set but no key ($OPENAI_API_KEY / --theme-key) — using the default look")
            else:
                theme_upstream = args.theme_upstream or "https://api.openai.com/v1"
                proposed = propose_theme(plan, model=args.theme_model, api_key=key,
                                         upstream=theme_upstream, refresh=args.theme_refresh,
                                         theme_prompt=args.theme_prompt)
                if has_site_source and args.theme_refresh and not proposed.body:
                    try:
                        theme = load_site_theme(site_dir)
                    except (OSError, ValueError) as exc:
                        print(f"error: cannot load editable site source: {exc}", file=sys.stderr)
                        return 2
                    print("   theme: refresh did not produce a valid layout; editable source preserved")
                else:
                    theme = proposed
                    refresh_site_source = has_site_source and args.theme_refresh
                    print(f"   theme: proposed via {args.theme_model} (brand: {theme.brand or '—'})")
    elif has_site_source:
        try:
            theme = load_site_theme(site_dir)
        except (OSError, ValueError) as exc:
            print(f"error: cannot load editable site source: {exc}", file=sys.stderr)
            return 2
        print(f"   theme: using editable source → {site_dir}")

    theme = theme or ThemeSpec()
    if not has_site_source or refresh_site_source:
        brand = theme.brand or network_name.replace("_", " ").replace("-", " ").title()
        brand_display = f"{theme.icon} {brand}".strip() if theme.icon else brand
        seed_site_source(site_dir, theme, brand_display, overwrite_theme=refresh_site_source)
        action = "refreshed" if refresh_site_source else "created"
        print(f"   editable site source {action} → {site_dir}")
        theme = load_site_theme(site_dir)

    if args.out:
        out_dir = Path(args.out).resolve()
    else:
        bundle_parent = Path.cwd() / ".nsdeploy" / hocon_path.parent.name
        out_dir = bundle_parent / network_name
    site_base = ((args.site_url or "") if args.static_bundle
                 else (args.site_url or f"http://127.0.0.1:{args.port}")).rstrip("/")
    mock_router = "browser://mock" if args.static_bundle else f"{site_base}/v1"
    byok_router = args.upstream.rstrip("/") if args.static_bundle else f"{site_base}/byok/v1"
    runtime_dir = Path(args.runtime_dir).resolve() if args.runtime_dir else None
    generate_site(plan, out_dir, mock_router, byok_router, site_base, cruse=not args.no_cruse,
                  theme=theme, site_source_dir=site_dir,
                  private_steward_sites=private_steward_sites or None,
                  static_bundle=args.static_bundle, runtime_dir=runtime_dir,
                  actions_file=Path(args.actions).resolve() if args.actions else None)
    bundle_label = "static bundle" if args.static_bundle else "site"
    print(f"✅ Generated {bundle_label} → {out_dir}" + ("" if args.no_cruse else "  (+CRUSE generative UI)"))
    if args.static_bundle:
        omitted_tools = sorted({tool.name for tool in plan.hostable_tools} | set(plan.omitted_tools))
        if omitted_tools:
            omitted = ", ".join(omitted_tools)
            print(f"   static bundle: omitted Python tools: {omitted}")
        if plan.external_mcps:
            print("   static bundle: external MCP servers will be called directly and must allow CORS")
        print("   static bundle: public MCP facade unavailable; private stewards use fetch-and-run")
    print(f"   private steward manifest → {out_dir.parent / 'manifest.hocon'}")

    if cailville_draft is not None:
        try:
            cailville.commit_addition(cailville_draft)
        except (OSError, ValueError) as exc:
            print(f"error: site generated but Cailville map update failed: {exc}", file=sys.stderr)
            return 2

    if args.no_serve or args.static_bundle:
        print("   (static output: not launching)" if args.static_bundle else "   (--no-serve: not launching)")
        return 0

    # source.root holds the (materialized) coded-tool sources the MCP hosts import.
    serve(out_dir, plan, source.root, port=args.port, site_base=site_base,
          upstream=args.upstream,
          runtime_dir=runtime_dir, ext_mcps=plan.external_mcps,
          facade_upstream=args.facade_upstream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
