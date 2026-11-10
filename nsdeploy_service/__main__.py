"""Run Agentic City, the deployment service.

    python -m nsdeploy_service --port 9000

Every setting is also an NSDEPLOY_SERVICE_* environment variable (see config.py);
the flags below just cover the ones worth typing.
"""
from __future__ import annotations

import argparse
import os
import sys
import textwrap
from pathlib import Path

import uvicorn

from nsdeploy_service import PRODUCT_NAME
from nsdeploy_service.app import create_app
from nsdeploy_service.config import Settings
from nsdeploy_service.envfile import load_into_environ
from nsdeploy_service.site_env import SiteEnv


def main(argv: list[str] | None = None) -> int:
    """
    Parse command-line flags, build the service settings and run the uvicorn server.

    :param argv: Command-line arguments, or None to read sys.argv.
    :return: The process exit code.
    """
    defaults = Settings()
    ap = argparse.ArgumentParser(prog="nsdeploy_service", description=__doc__)
    ap.add_argument("--host", default=None, help=f"API bind address (default {defaults.host})")
    ap.add_argument("--port", type=int, default=None, help=f"API port (default {defaults.port})")
    ap.add_argument("--port-start", type=int, default=None,
                    help=f"first port of the deployment pool (default {defaults.port_start})")
    ap.add_argument("--port-end", type=int, default=None,
                    help=f"last port of the deployment pool (default {defaults.port_end})")
    ap.add_argument("--work-root", default=None,
                    help="where per-deployment HOCONs, bundles and logs are written")
    ap.add_argument("--upstream", default=None,
                    help=f"BYOK proxy upstream for deployed sites (default {defaults.upstream})")
    ap.add_argument("--studio", default=None,
                    help="local neuro-san-studio checkout; avoids per-build GitHub fetches")
    ap.add_argument("--ttl-seconds", type=int, default=None,
                    help=f"auto-stop deployments after N seconds, 0 to disable "
                         f"(default {defaults.ttl_seconds})")
    ap.add_argument("--max-deployments", type=int, default=None,
                    help=f"live-deployment ceiling (default {defaults.max_deployments})")
    ap.add_argument("--theme", action="store_true",
                    help="enable deploy-time LLM theming for every build (needs OPENAI_API_KEY, "
                         "listed in NSDEPLOY_SERVICE_SITE_ENV_ALLOW)")
    ap.add_argument("--api-token", default=None,
                    help="require this bearer token on every endpoint except /health")
    ap.add_argument("--reload", action="store_true", help="uvicorn autoreload (development)")
    args = ap.parse_args(argv)

    # Settings saved from the console's API-settings dialog (POST /settings) land in
    # this checkout's own .env, not the shell — so they must be folded into the
    # process environment before Settings.from_env() reads it, on every run after
    # the one that saved them.
    load_into_environ()

    try:
        settings = Settings.from_env()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    for flag, attr in (("host", "host"), ("port", "port"), ("port_start", "port_start"),
                       ("port_end", "port_end"), ("upstream", "upstream"), ("studio", "studio"),
                       ("ttl_seconds", "ttl_seconds"), ("max_deployments", "max_deployments"),
                       ("api_token", "api_token")):
        value = getattr(args, flag)
        if value is not None:
            setattr(settings, attr, value)
    if args.work_root:
        settings.work_root = Path(args.work_root).resolve()
    if args.theme:
        settings.theme = True

    try:
        settings.validate()
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(f"{PRODUCT_NAME} on http://{settings.host}:{settings.port}")
    print(f"  console   http://{settings.host}:{settings.port}/")
    print(f"  api docs  http://{settings.host}:{settings.port}/docs")
    print(f"  deployment ports  {settings.port_start}-{settings.port_end}"
          f"  (max {settings.max_deployments} live)")
    print(f"  work root         {settings.work_root}")
    print(f"  site BYOK upstream {settings.upstream}")
    print(f"  theming           {'on' if settings.theme else 'off'}"
          f"   TTL {settings.ttl_seconds or 'disabled'}"
          f"   auth {'bearer token' if settings.api_token else 'open'}"
          f"{'   console proxy on' if settings.console_proxy else ''}")
    if settings.console_proxy:
        print(f"\n  WARNING: {settings.CONSOLE_PROXY_WARNING}\n", file=sys.stderr)
    if not settings.api_token and settings.host not in ("127.0.0.1", "localhost", "::1"):
        print("\n  WARNING: bound off-loopback with no --api-token. An uploaded HOCON can "
              "execute\n           arbitrary Python on this host. See nsdeploy_service/README.md.\n",
              file=sys.stderr)
    # Theming runs in each site's build, which receives the key only when SITE_ENV_ALLOW lists it, and
    # SITE_ENV_ALLOW can never pass the service's own credentials.
    site_env_warnings: list[str | None] = [
        SiteEnv.theme_key_warning(settings.theme, os.environ, settings.site_env_allow),
        SiteEnv.allow_list_warning(settings.site_env_allow),
    ]
    warning: str | None
    # Print each warning that applies, wrapped to the banner's width.
    for warning in site_env_warnings:
        if warning:
            text: str = textwrap.fill(warning, width=88, initial_indent="  WARNING: ", subsequent_indent=" " * 11)
            print(f"\n{text}\n", file=sys.stderr)

    if args.reload:
        uvicorn.run("nsdeploy_service.app:app", host=settings.host, port=settings.port, reload=True)
    else:
        uvicorn.run(create_app(settings), host=settings.host, port=settings.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
