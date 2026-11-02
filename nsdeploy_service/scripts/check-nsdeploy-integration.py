#!/usr/bin/env python3
"""Verify this service still works against the nsdeploy it has been dropped into.

`nsdeploy_service/` needs no patches to nsdeploy, so upgrading it is "replace
everything, drop this folder back in". What has to survive an upgrade is the contract
between the two, which has three parts. Two of them fail *silently*:

* the service scrapes nsdeploy's human-readable stdout for tool and agent names
  (`summarize_build`). A reworded section header empties those fields with no error
  — a network then shows 0 agents and no warnings while running perfectly;
* it reads keys out of the generated bundle. A renamed key or file does the same.

The third is the names `themespec.py` and `bundler.py` import in process. Those fail
loudly, as an ImportError at start-up, but they are listed here too so that an
upgrade reports every break at once rather than one per restart.

Run after every nsdeploy upgrade, from the nsdeploy root:

    python nsdeploy_service/scripts/check-nsdeploy-integration.py

Exit 0 = safe to build an image. Then run the tests and one smoke deploy.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[1]
ROOT = SERVICE.parent

# --- the service must remain self-contained ---------------------------------
SELF_CONTAINED = [
    ("nsdeploy_service/trust.py", "TLS trust is owned by the service"),
    ("nsdeploy_service/_bootstrap/sitecustomize.py",
     "child processes get trust without patching nsdeploy"),
    ("nsdeploy_service/ui/index.html", "the console ships inside the package"),
    ("nsdeploy_service/pyproject.toml",
     "the service declares its own dependencies, scripts and packaging"),
]

# --- stdout strings summarize_build() scrapes --------------------------------
# Mirrors nsdeploy_service/supervisor.py::_SECTIONS and _EXT_MCP_RE.
REPORT_MARKERS = [
    ("nsdeploy/resolve.py", "Hostable tools", "hostable_tools names"),
    ("nsdeploy/resolve.py", "DEMO-MODE agents", "demo_mode_agents names"),
    ("nsdeploy/resolve.py", "Missing tools", "missing_tools names"),
    ("nsdeploy/launcher.py", "External MCP (proxied):", "external_mcps URLs"),
    ("nsdeploy/resolve.py", "→", "bullet arrow separator"),
]

# --- names imported in process ----------------------------------------------
# Deployments drive nsdeploy as a CLI. These two modules do not: themespec.py
# restyles a built bundle without a rebuild, and bundler.py builds a static bundle,
# which is a build product with no process to supervise. Each import is at module
# level, so a rename upstream stops the service at start-up rather than mid-request.
# The last two entries are keyword arguments rather than imports: both are passed by
# name, so a rename upstream is a TypeError on the first build, not at start-up.
IN_PROCESS = [
    ("nsdeploy/generate.py", "def generate_site", "bundler generates the static bundle"),
    ("nsdeploy/generate.py", "def _theme_css", "themespec writes a build's own stylesheet"),
    ("nsdeploy/resolve.py", "def resolve_hocon", "bundler resolves the uploaded HOCON"),
    ("nsdeploy/resolve.py", "def build_plan", "bundler classifies the resolved config"),
    ("nsdeploy/resolve.py", "class DeploymentPlan", "the plan bundler reads front_man from"),
    ("nsdeploy/studio.py", "class StudioSource", "the source type bundler selects"),
    ("nsdeploy/studio.py", "class GithubStudio", "bundler resolves includes from the repo"),
    ("nsdeploy/studio.py", "class LocalStudio", "bundler resolves includes from a checkout"),
    ("nsdeploy/studio.py", "DEFAULT_REPO", "the repo a GithubStudio defaults to"),
    ("nsdeploy/studio.py", "DEFAULT_REF", "the ref a GithubStudio defaults to"),
    ("nsdeploy/theme.py", "def propose_theme", "bundler asks for an opt-in theme"),
    ("nsdeploy/theme.py", "DEFAULT_THEME_MODEL", "the model propose_theme defaults to"),
    ("nsdeploy/theme.py", "class ThemeSpec", "the spec both modules build and merge"),
    ("nsdeploy/theme.py", "DEFAULT_COLORS", "themespec starts from the default look"),
    ("nsdeploy/theme.py", "DEFAULT_FONT", "themespec starts from the default look"),
    ("nsdeploy/theme.py", "_COLOR_RE", "themespec accepts the colours a build accepts"),
    ("nsdeploy/site_source.py", "def load_site_theme", "themespec reads the editable source"),
    ("nsdeploy/site_source.py", "def site_source_exists",
     "themespec tests for an editable source"),
    ("nsdeploy/resolve.py", "include_python_tools",
     "the switch that keeps tool autoinstall out of the API process"),
    ("nsdeploy/generate.py", "static_bundle", "generate_site's static-bundle mode"),
]

# --- generated bundle contract ----------------------------------------------
BUNDLE = [
    ("nsdeploy/generate.py", "agent-manifest.json", "manifest filename"),
    ("nsdeploy/generate.py", ".network.json", "network JSON filename"),
    ("nsdeploy/generate.py", "agent_mcp", "front_man lives under manifest.agent_mcp"),
    ("nsdeploy/generate.py", "nsdeploy-link/v1", "linking protocol version"),
    ("nsdeploy/generate.py", "nsdeploy-agent-mcp/v1", "agent-mcp protocol version"),
    ("nsdeploy/steward.py", "class PublicAgentMcpGateway",
     "class path baked into every generated steward HOCON"),
]

# --- optional: only needed for the port-per-deployment model -----------------
OPTIONAL = [
    ("nsdeploy/__main__.py", '"--host"',
     "site --host flag — required only when DEPLOY_HOST is not 127.0.0.1 "
     "(port-per-deployment). Hostname routing does not need it."),
]


def read(rel: str) -> str | None:
    try:
        return (ROOT / rel).read_text(encoding="utf-8")
    except OSError:
        return None


def section(title: str, items, kind: str = "fail") -> int:
    print(f"\n{title}\n{'-' * len(title)}")
    problems = 0
    for entry in items:
        rel, needle, label = entry[0], entry[1], entry[2]
        text = read(rel)
        ok = text is not None and needle in text
        if ok:
            mark = "OK  "
        elif kind == "warn":
            mark = "NOTE"
        else:
            mark = "FAIL"
            problems += 1
        print(f"  {mark}  {label}")
        if not ok:
            reason = "file missing" if text is None else f"{needle!r} not found"
            print(f"        in {rel}: {reason}")
    return problems


def present(title: str, items) -> int:
    print(f"\n{title}\n{'-' * len(title)}")
    problems = 0
    for rel, label in items:
        ok = (ROOT / rel).exists()
        print(f"  {'OK  ' if ok else 'FAIL'}  {label}")
        if not ok:
            problems += 1
            print(f"        missing: {rel}")
    return problems


def cli_contract() -> int:
    print("\nCLI contract (service -> nsdeploy)\n" + "-" * 33)
    main = read("nsdeploy/__main__.py") or ""
    sup = read("nsdeploy_service/supervisor.py") or ""
    accepted = set(re.findall(r'ap\.add_argument\("(--[a-z-]+)"', main))
    try:
        block = sup[sup.index("def _command"):sup.index("def _spawn")]
    except ValueError:
        print("  FAIL  could not locate Supervisor._command")
        return 1
    passed = set(re.findall(r'"(--[a-z-]+)"', block))
    # --host is emitted conditionally; it is covered under optional extras.
    required = sorted(passed - {"--host"})
    missing = [f for f in required if f not in accepted]
    for flag in required:
        print(f"  {'OK  ' if flag in accepted else 'FAIL'}  {flag}")
    if missing:
        print(f"        -> nsdeploy does not accept: {', '.join(missing)}")
        print("        -> every deployment would exit 2 at argparse")
    return len(missing)


def main() -> int:
    print(f"nsdeploy integration check\nnsdeploy root: {ROOT}\nservice:       {SERVICE}")
    problems = 0
    problems += present("Service is self-contained", SELF_CONTAINED)
    problems += cli_contract()
    problems += section("stdout markers scraped by summarize_build "
                        "(SILENT data loss if reworded)", REPORT_MARKERS)
    problems += section("Generated bundle contract", BUNDLE)
    problems += section("Imported in process by themespec.py and bundler.py "
                        "(ImportError at start-up if renamed)", IN_PROCESS)
    section("Optional — only for the port-per-deployment model", OPTIONAL, kind="warn")

    print()
    if problems:
        print(f"{problems} problem(s). The service will not work correctly against this "
              f"nsdeploy until they are resolved.")
        return 1
    print("All required checks passed.")
    print("Next: python -m unittest discover -s nsdeploy_service/tests -t .")
    print("Then: one smoke deploy, and confirm network.agent_count > 0.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
