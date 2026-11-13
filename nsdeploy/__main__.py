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
from types import ModuleType
from typing import TYPE_CHECKING
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

from nsdeploy.action_discovery import prepare_actions
from nsdeploy.form_actions import action_discovery_config
from nsdeploy.generate import generate_site
from nsdeploy.gateway import run_gateway_command
from nsdeploy.linker import load_deploy_links
from nsdeploy.linker import run_link_command
from nsdeploy.launcher import serve
from nsdeploy.resolve import DeploymentPlan
from nsdeploy.resolve import build_plan
from nsdeploy.resolve import format_report
from nsdeploy.resolve import load_toolbox_info
from nsdeploy.resolve import resolve_hocon
from nsdeploy.site_source import load_site_theme
from nsdeploy.site_source import seed_site_source
from nsdeploy.site_source import site_source_exists
from nsdeploy.studio import DEFAULT_REF
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio
from nsdeploy.studio import StudioSource
from nsdeploy.theme import DEFAULT_THEME_MODEL
from nsdeploy.theme import ThemeSpec
from nsdeploy.theme import load_theme_file
from nsdeploy.theme import propose_theme

# cailville is optional (see the try/except below), so a runtime import would break installs without it.
# CommunityDraft only appears in annotations, which are never evaluated, so import it for type checkers only.
if TYPE_CHECKING:
    from nsdeploy.cailville import CommunityDraft

# Optional module: a plain deploy must not fail to start when it is absent from an install.
try:
    from nsdeploy import cailville as _cailville
    _CAILVILLE_IMPORT_ERROR: Optional[ImportError] = None
except ImportError as _exc:
    _cailville = None
    _CAILVILLE_IMPORT_ERROR = _exc


def _load_cailville() -> Optional[ModuleType]:
    """Return the Cailville community helpers, or None when they are unavailable.

    Only `nsdeploy cailville ...` and --add-to-cailville need them; a plain deploy must
    not fail to start when that module is absent from an install.
    """
    if _cailville is None:
        print(f"error: Cailville support is unavailable in this install: {_CAILVILLE_IMPORT_ERROR}",
              file=sys.stderr)
    return _cailville


# pylint: disable-next=too-many-locals,too-many-return-statements,too-many-branches,too-many-statements  # flat CLI flow
def main() -> int:
    """
    Run the nsdeploy command line: dispatch subcommands, or resolve, generate and serve a network.

    :return: The process exit code.
    """
    if len(sys.argv) > 1 and sys.argv[1] == "gateway":
        return run_gateway_command(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "link":
        return run_link_command(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "cailville":
        cailville: Optional[ModuleType] = _load_cailville()
        return cailville.run_cailville_command(sys.argv[2:]) if cailville else 2

    ap: argparse.ArgumentParser = argparse.ArgumentParser(prog="nsdeploy", description=__doc__)
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
    ap.add_argument("--action-page", action="append", default=None, metavar="PATH",
                    help="discover native HTML forms on this same-origin page at runtime (repeatable; "
                         "no implicit page default)")
    ap.add_argument("--action-host-page", action="store_true",
                    help="discover native forms in the page embedding the widget (local only)")
    ap.add_argument("--action-site", metavar="URL",
                    help="discover public native forms and linked JSON OpenAPI 3 descriptions while bundling")
    ap.add_argument("--action-spec", metavar="FILE_OR_URL",
                    help="explicit OpenAPI 3 JSON description for --action-site")
    ap.add_argument("--action-lock", metavar="FILE",
                    help="reviewed discovery lock (default: <site-dir>/discovered-actions.json)")
    ap.add_argument("--action-refresh", action="store_true", help="rediscover actions; reset selections for review")
    ap.add_argument("--action-allow", action="append", default=[], metavar="NAME",
                    help="enable a discovered operation by exact name (repeatable)")
    ap.add_argument("--action-include-all", action="store_true",
                    help="enable every supported discovered operation; intended for public test sites")
    ap.add_argument("--action-max-pages", type=int, default=6,
                    help="maximum documentation/form pages to inspect (1–20, default 6)")
    ap.add_argument("--no-action-discovery", action="store_true",
                    help="disable automatic native-form discovery")
    ap.add_argument("--action-module", action="append", default=[], metavar="PATH",
                    help="existing same-origin module exporting registerActions (repeatable; not copied)")
    ap.add_argument("--action-caller-origin", action="append", default=[], metavar="ORIGIN",
                    help="allow this caller origin to use discovered forms remotely (repeatable)")
    ap.add_argument("--upstream", default="https://api.openai.com/v1",
                    help="RUNTIME BYOK proxy upstream — where the page's key is forwarded (default OpenAI)")
    ap.add_argument("--facade-upstream", default=None,
                    help="server-side facade LLM endpoint (default: $NSDEPLOY_FACADE_UPSTREAM or --upstream)")
    ap.add_argument("--facade-key", default=None,
                    help="accepted for backward compatibility and IGNORED: a served site never uses a "
                         "host-side LLM key; the facade only uses the caller's BYOK credentials")
    ap.add_argument("--runtime-dir", default=None,
                    help="neuro-san-web runtime dir (default: vendored nsdeploy/runtime)")
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
                    help="emit a self-contained static webroot (direct-CORS "
                         "BYOK/MCP, no Python tools or public MCP facade)")
    ap.add_argument("--mock-llm", action="store_true",
                    help="developer mode: make the deterministic keyless mock LLM the default")
    args: argparse.Namespace = ap.parse_args()
    if args.actions and not Path(args.actions).is_file():
        ap.error("--actions must name an existing JavaScript adapter")
    # pylint: disable-next=too-many-boolean-expressions  # flat list of conflicting options
    if args.no_action_discovery and (args.action_page or args.action_host_page or args.action_caller_origin
                                     or args.action_site or args.action_spec or args.action_lock
                                     or args.action_refresh or args.action_allow or args.action_include_all):
        ap.error("--no-action-discovery cannot be combined with form discovery options")
    action_pages: List[str] = args.action_page or []
    try:
        # The conventional discovery lock can also supply these capabilities.
        action_discovery_config(action_pages, args.action_module, args.action_caller_origin, args.action_host_page,
                                discovered=True)
    except ValueError as exc:
        ap.error(str(exc))

    if args.cailville_base_map and not args.add_to_cailville:
        ap.error("--cailville-base-map requires --add-to-cailville")
    if args.facade_key:
        print("warning: --facade-key is ignored; the public facade only uses caller BYOK credentials",
              file=sys.stderr)

    hocon_path: Path = Path(args.hocon).resolve()
    if not hocon_path.is_file():
        print(f"error: HOCON not found: {hocon_path}", file=sys.stderr)
        return 2

    source: StudioSource
    if args.studio:
        source = LocalStudio(args.studio)
        print(f"▶ Resolving {hocon_path.name} (studio: {args.studio}) …\n")
    else:
        source = GithubStudio(args.repo, args.ref)
        print(f"▶ Resolving {hocon_path.name} (tools from github:{args.repo}@{args.ref}) …\n")

    network_name: str = hocon_path.stem
    site_dir: Path = (Path(args.site_dir).resolve() if args.site_dir
                      else hocon_path.parent / "sites" / network_name)
    action_lock: Path = Path(args.action_lock) if args.action_lock else site_dir / "discovered-actions.json"
    discovered_actions: Optional[Dict[str, Any]] = None
    # pylint: disable-next=too-many-boolean-expressions  # flat list of discovery triggers
    if not args.no_action_discovery and (args.action_site or args.action_spec or args.action_lock
                                         or args.action_refresh or args.action_allow or args.action_include_all
                                         or action_lock.exists()):
        try:
            discovered_actions = prepare_actions(action_lock, args.action_site, args.action_spec,
                                                 args.site_url or "", args.action_refresh, args.action_include_all,
                                                 args.action_allow, args.action_max_pages)
        except (ValueError, OSError) as exc:
            ap.error(str(exc))
    try:
        action_discovery_config(action_pages, args.action_module, args.action_caller_origin, args.action_host_page,
                                bool(discovered_actions))
    except ValueError as exc:
        ap.error(str(exc))
    config: Dict[str, Any]
    missing_includes: List[str]
    config, missing_includes = resolve_hocon(hocon_path, source)
    cailville_draft: Optional[CommunityDraft] = None
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
        links_path: Optional[Path] = Path(args.links).resolve() if args.links else None
        if links_path is not None and not links_path.is_file():
            raise ValueError(f"link file not found: {links_path}")
        deploy_links: Dict[str, str] = load_deploy_links(hocon_path, network_name, links_path, args.link)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if deploy_links:
        configured: Dict[str, Any] = dict(config.get("links", {}) or {})
        configured.update(deploy_links)
        config["links"] = configured
    private_steward_sites: Dict[str, str] = {}
    if args.steward_sites:
        try:
            steward_data: Any = json.loads(Path(args.steward_sites).read_text(encoding="utf-8"))
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
    toolbox_info: Dict[str, Any] = {} if args.static_bundle else load_toolbox_info(source)
    plan: DeploymentPlan = build_plan(
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
    theme: Optional[ThemeSpec] = None
    has_site_source: bool = site_source_exists(site_dir)
    refresh_site_source: bool = False
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
            key: str = args.theme_key or os.environ.get("OPENAI_API_KEY", "")
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
                theme_upstream: str = args.theme_upstream or "https://api.openai.com/v1"
                proposed: ThemeSpec = propose_theme(plan, model=args.theme_model, api_key=key,
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
        brand: str = theme.brand or network_name.replace("_", " ").replace("-", " ").title()
        brand_display: str = f"{theme.icon} {brand}".strip() if theme.icon else brand
        seed_site_source(site_dir, theme, brand_display, overwrite_theme=refresh_site_source)
        action: str = "refreshed" if refresh_site_source else "created"
        print(f"   editable site source {action} → {site_dir}")
        theme = load_site_theme(site_dir)

    out_dir: Path
    if args.out:
        out_dir = Path(args.out).resolve()
    else:
        bundle_parent: Path = Path.cwd() / ".nsdeploy" / hocon_path.parent.name
        out_dir = bundle_parent / network_name
    site_base: str = ((args.site_url or "") if args.static_bundle
                      else (args.site_url or f"http://127.0.0.1:{args.port}")).rstrip("/")
    mock_router: str = "browser://mock" if args.static_bundle else f"{site_base}/v1"
    byok_router: str = args.upstream.rstrip("/") if args.static_bundle else f"{site_base}/byok/v1"
    runtime_dir: Optional[Path] = Path(args.runtime_dir).resolve() if args.runtime_dir else None
    generate_site(plan, out_dir, mock_router, byok_router, site_base, cruse=not args.no_cruse,
                  theme=theme, site_source_dir=site_dir,
                  private_steward_sites=private_steward_sites or None,
                  static_bundle=args.static_bundle, runtime_dir=runtime_dir,
                  actions_file=Path(args.actions).resolve() if args.actions else None,
                  action_pages=action_pages, action_modules=args.action_module,
                  action_host_page=args.action_host_page,
                  action_caller_origins=args.action_caller_origin,
                  discovered_actions=discovered_actions,
                  mock_llm=args.mock_llm)
    bundle_label: str = "static bundle" if args.static_bundle else "site"
    print(f"✅ Generated {bundle_label} → {out_dir}" + ("" if args.no_cruse else "  (+CRUSE generative UI)"))
    if args.static_bundle:
        omitted_tools: List[str] = sorted({tool.name for tool in plan.hostable_tools} | set(plan.omitted_tools))
        if omitted_tools:
            omitted: str = ", ".join(omitted_tools)
            print(f"   static bundle: omitted Python tools: {omitted}")
        if plan.external_mcps:
            print("   static bundle: external MCP servers will be called directly and must allow CORS")
        print("   static bundle: public MCP facade and private steward are not included")
    else:
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
          facade_upstream=args.facade_upstream, mock_llm=args.mock_llm)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
