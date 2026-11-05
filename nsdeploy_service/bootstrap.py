#!/usr/bin/env python3
"""One command to set up Agentic City in an nsdeploy checkout and prove it works.

    python nsdeploy_service/bootstrap.py

Drop this folder into the root of any nsdeploy checkout, run the line above, and it
will check where it landed, install both packages, verify the contract with the
nsdeploy it found, run the test suite, and start the service to confirm it actually
answers — then stop it again.

The steps exist because this integration fails in two ways that are easy to miss.
A wrong *placement* breaks every deployment with "No module named nsdeploy", because
the supervisor runs `python -m nsdeploy` from this folder's parent. And the service
scrapes nsdeploy's human-readable stdout for tool and agent names, so an upstream
rewording silently empties those fields — a network then reports 0 agents and no
warnings while running perfectly.

How long it takes. The first run is dominated by step 2: nsdeploy's dependency
closure is ~99 packages, because `neuro-san` brings langchain, openai and tiktoken
with it, so a cold install downloads a few hundred MB and can run for minutes. The
other five steps together are roughly 30s (the test suite is most of that). Install
uv and this script will use it — it resolves the same tree several times faster.
Every step prints its own elapsed time at the end so a slow step is distinguishable
from a stuck one.

Flags:
    --skip-install   don't touch the environment, just verify
    --skip-tests     skip the service test suite (saves ~15s)
    --port N         port for the connection test (default: an unused one)

Exit code 0 means ready to use.
"""
from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVICE = Path(__file__).resolve().parent
ROOT = SERVICE.parent
STARTUP_TIMEOUT_SECONDS = 45

_results: list[tuple[str, bool, str]] = []
# Wall-clock per step, printed at the end. Without it there is no way to tell a slow
# step from a stuck one, which is the whole difficulty with this script.
_timings: list[tuple[str, float]] = []
_step_started = 0.0
_step_title = ""


def step(number: int, title: str) -> None:
    global _step_started, _step_title
    if _step_title:
        _timings.append((_step_title, time.monotonic() - _step_started))
    _step_started, _step_title = time.monotonic(), title
    print(f"\n[{number}/6] {title}\n{'-' * (len(title) + 6)}")


def close_timings() -> None:
    global _step_title
    if _step_title:
        _timings.append((_step_title, time.monotonic() - _step_started))
        _step_title = ""


def ok(label: str, detail: str = "") -> bool:
    print(f"  OK    {label}{'  ' + detail if detail else ''}")
    _results.append((label, True, detail))
    return True


def fail(label: str, detail: str = "") -> bool:
    print(f"  FAIL  {label}")
    for line in (detail or "").splitlines():
        print(f"        {line}")
    _results.append((label, False, detail))
    return False


def run(args: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=str(cwd), capture_output=True, text=True)


def stream(args: list[str], cwd: Path = ROOT, keep: int = 40) -> tuple[int, str]:
    """Run a command, echoing its progress live, and return (code, output tail).

    Installing is the long pole in this script — nsdeploy's dependency closure is
    ~99 packages, because neuro-san brings langchain/openai/tiktoken with it — and
    the previous version ran pip with `-q` and captured output, so a cold install
    printed one line and then said nothing for several minutes. That is
    indistinguishable from a hang, and it is what gets this script reported as
    "taking a long time": most of the wait was invisible rather than avoidable.

    Only pip's own progress verbs are echoed, so the log stays a few lines per
    package instead of a wall of wheel URLs.
    """
    interesting = ("Collecting", "Downloading", "Building", "Installing",
                   "Successfully", "Using cached", "ERROR", "error:", "WARNING")
    tail: list[str] = []
    process = subprocess.Popen(
        args, cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1)
    assert process.stdout is not None
    for line in process.stdout:
        line = line.rstrip()
        tail.append(line)
        del tail[:-200]
        if line.startswith(interesting):
            print(f"        {line[:110]}", flush=True)
    process.wait()
    return process.returncode, "\n".join(tail[-keep:])


def installer() -> tuple[list[str], str]:
    """The fastest available installer, and a label for it.

    uv resolves and installs the same tree several times faster than pip, so it is
    preferred when on PATH. Either installer resolves fresh from requirements.txt
    (read by pyproject.toml); there is no lockfile in the repo. pip remains the
    fallback so nothing new is required to bootstrap.
    """
    if shutil.which("uv"):
        return ["uv", "pip", "install", "--python", sys.executable], "uv"
    return [sys.executable, "-m", "pip", "install"], "pip"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


# --- 1. placement -----------------------------------------------------------
def check_placement() -> bool:
    step(1, "Placement")
    good = True
    if SERVICE.name != "nsdeploy_service":
        good = fail(f"the folder is named {SERVICE.name!r}",
                    "It must be called nsdeploy_service — the package name is imported "
                    "literally.")
    if (ROOT / "nsdeploy").is_dir() and (ROOT / "pyproject.toml").is_file():
        ok("beside nsdeploy/", f"root: {ROOT}")
    else:
        good = fail("not in an nsdeploy checkout",
                    f"Looked for nsdeploy/ and pyproject.toml in {ROOT}.\n"
                    f"Move this folder so it sits NEXT TO nsdeploy/, not inside it:\n"
                    f"    <checkout>/nsdeploy/\n    <checkout>/nsdeploy_service/")
    if ROOT.name == "nsdeploy":
        good = fail("nested inside the nsdeploy package",
                    "The supervisor runs `python -m nsdeploy` from this folder's parent, "
                    "which here is the package itself — every deployment would fail with "
                    "'No module named nsdeploy'.")
    if sys.version_info < (3, 10):
        good = fail(f"Python {sys.version.split()[0]}", "3.10 or newer is required.")
    else:
        ok(f"Python {sys.version.split()[0]}")
    return good


# --- 2. install -------------------------------------------------------------
def already_installed() -> bool:
    """True when both packages are importable from *this* checkout.

    Worth knowing before the wait: with the tree already satisfied, pip still spends
    ~35s per package re-resolving 99 dependencies and changing nothing. That is the
    single biggest reason a *re-run* of this script feels slow, and it is entirely
    skippable — so say so rather than let it look like progress.

    Checked by import location rather than importlib.metadata: an editable install
    records its files inside site-packages (via a .pth/finder shim), so metadata
    reports the wrong root and the check silently answered False.
    """
    try:
        import importlib

        for name in ("nsdeploy", "nsdeploy_service"):
            module = importlib.import_module(name)
            if not module.__file__:
                return False
            if Path(module.__file__).resolve().parent.parent != ROOT:
                return False
        return True
    except Exception:  # noqa: BLE001 - not importable yet just means "not installed"
        return False


def install(skip: bool) -> bool:
    step(2, "Install")
    if skip:
        print("  ..    skipped (--skip-install)")
        return True
    if already_installed():
        print("  NOTE  both packages already point at this checkout. Re-resolving the")
        print("  NOTE  dependency tree still takes ~35s per package and changes nothing;")
        print("  NOTE  pass --skip-install to go straight to verification.")
    base, tool = installer()
    print(f"  ..    using {tool}"
          + ("" if tool == "uv" else "  (install uv for a much faster resolve)"))
    print("  ..    nsdeploy pulls ~99 packages (neuro-san brings langchain/openai);")
    print("  ..    the first run downloads them all and can take several minutes.")
    good = True
    for label, target in (("nsdeploy", "."), ("nsdeploy-service", "./nsdeploy_service")):
        print(f"  ..    {tool} install -e {target}")
        started = time.monotonic()
        code, tail = stream([*base, "-e", target])
        if code == 0:
            ok(label, f"{time.monotonic() - started:.0f}s")
        else:
            good = fail(label, tail.strip()[-600:])
    return good


# --- 3. nsdeploy runs -------------------------------------------------------
def check_nsdeploy_cli() -> bool:
    step(3, "nsdeploy CLI")
    result = run([sys.executable, "-m", "nsdeploy", "--help"])
    if result.returncode != 0:
        return fail("python -m nsdeploy --help",
                    "Every deployment shells out to exactly this, so nothing will work "
                    "until it does.\n" + (result.stderr or "").strip()[-400:])
    ok("python -m nsdeploy --help")
    if "--host" in result.stdout:
        ok("--host supported", "(port-per-deployment model available)")
    else:
        print("  NOTE  no --host flag: hostname routing only "
              "(DEPLOY_HOST must stay 127.0.0.1)")
    return True


# --- 4. contract ------------------------------------------------------------
def check_contract() -> bool:
    step(4, "Contract with this nsdeploy")
    script = SERVICE / "scripts" / "check-nsdeploy-integration.py"
    if not script.is_file():
        return fail("check script missing", f"expected {script}")
    result = run([sys.executable, str(script)])
    if result.returncode == 0:
        ok("stdout markers, bundle keys and CLI flags all match")
        return True
    detail = "\n".join(line for line in result.stdout.splitlines()
                       if line.strip().startswith(("FAIL", "in ", "->")))
    return fail("contract mismatch", detail or result.stdout[-800:])


# --- 5. tests ---------------------------------------------------------------
def run_tests(skip: bool) -> bool:
    step(5, "Tests")
    if skip:
        print("  ..    skipped (--skip-tests)")
        return True
    result = run([sys.executable, "-m", "unittest", "discover",
                  "-s", "nsdeploy_service/tests", "-t", "."])
    tail = (result.stderr or "").strip().splitlines()
    summary = next((line for line in reversed(tail) if line.startswith("Ran ")), "")
    if result.returncode == 0:
        return ok("service test suite", summary)
    return fail("service test suite",
                "\n".join(line for line in tail if line.startswith(("FAIL:", "ERROR:", "Ran ")))
                or summary)


# --- 6. connection ----------------------------------------------------------
def check_connection(port: int) -> bool:
    step(6, "Connection")
    work = Path(tempfile.mkdtemp(prefix="nsdeploy-bootstrap-"))
    # A throwaway work root and a port pool clear of the API port, so this never
    # touches real deployment records.
    env_port_start = port + 1
    child = subprocess.Popen(
        [sys.executable, "-m", "nsdeploy_service",
         "--host", "127.0.0.1", "--port", str(port),
         "--work-root", str(work),
         "--port-start", str(env_port_start), "--port-end", str(env_port_start + 9),
         "--max-deployments", "5"],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        health = None
        while time.monotonic() < deadline:
            if child.poll() is not None:
                return fail("the service exited during start-up",
                            (child.stdout.read() if child.stdout else "")[-800:])
            try:
                with urllib.request.urlopen(f"{base}/health", timeout=3) as response:
                    health = json.loads(response.read().decode("utf-8"))
                break
            except (urllib.error.URLError, OSError, ValueError):
                time.sleep(0.4)
        if health is None:
            return fail("no answer on /health",
                        f"waited {STARTUP_TIMEOUT_SECONDS}s on {base}")
        ok("GET /health", f"status={health.get('status')} v{health.get('version')}")

        good = True
        for path, label in (("/app/", "console"), ("/docs", "OpenAPI docs"),
                            ("/deployments", "deployment API")):
            try:
                with urllib.request.urlopen(f"{base}{path}", timeout=8) as response:
                    ok(f"GET {path}", f"HTTP {response.status} ({label})")
            except urllib.error.HTTPError as exc:
                ok(f"GET {path}", f"HTTP {exc.code} ({label})")
            except Exception as exc:  # noqa: BLE001
                good = fail(f"GET {path}", f"{type(exc).__name__}: {exc}")

        for warning in health.get("warnings") or []:
            print(f"  NOTE  health warning: {warning}")
        return good
    finally:
        child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bootstrap", description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skip-install", action="store_true",
                        help="verify only; do not touch the environment")
    parser.add_argument("--skip-tests", action="store_true", help="skip the test suite")
    parser.add_argument("--port", type=int, default=None,
                        help="port for the connection test (default: an unused one)")
    args = parser.parse_args(argv)

    # Spelled out rather than imported from nsdeploy_service: this script runs
    # before the environment it is setting up exists, and is deliberately
    # stdlib-only so it cannot fail on an import.
    print("Agentic City — setup and connection test")
    print(f"service : {SERVICE}")
    print(f"nsdeploy: {ROOT}")

    # Placement first: every later step assumes it, and a wrong answer here makes
    # the rest meaningless rather than merely failing.
    if not check_placement():
        print("\nFAILED at placement. Fix that before anything else.")
        return 1
    steps = [
        install(args.skip_install),
        check_nsdeploy_cli(),
        check_contract(),
        run_tests(args.skip_tests),
        check_connection(args.port or free_port()),
    ]

    close_timings()
    failures = [label for label, passed, _ in _results if not passed]
    print("\n" + "=" * 60)
    total = sum(seconds for _, seconds in _timings)
    print(f"Time: {total:.0f}s total — " + ", ".join(
        f"{title.lower()} {seconds:.0f}s" for title, seconds in _timings))
    if total > 90:
        print("Re-runs are much faster with:  --skip-install --skip-tests")
    if failures or not all(steps):
        print(f"NOT READY — {len(failures)} check(s) failed:")
        for label in failures:
            print(f"  - {label}")
        print("\nScroll up for the detail under each step.")
        return 1
    print("READY. The service runs against this nsdeploy.")
    print("\nStart it:   python -m nsdeploy_service --port 9100")
    print("Console:    http://127.0.0.1:9100/app/")
    print("\nOne thing this cannot check: deploy a HOCON and confirm the record shows")
    print("agent_count > 0. If it is 0 while the site works, nsdeploy changed the shape")
    print("of its generated bundle and summarize_build needs updating.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
