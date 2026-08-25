#!/usr/bin/env bash
#
# Generate the browser execution runtime from a Neuro-SAN Python checkout and
# launch nsdeploy with that freshly generated runtime.
#
# Usage:
#   ./scripts/generate-runtime-and-launch.sh examples/travel_agent_system.hocon
#   ./scripts/generate-runtime-and-launch.sh cailville/harbor_guide.hocon --port 8091
#
# Every argument after the HOCON path is passed unchanged to `python -m nsdeploy`.
# The script owns --runtime-dir so the launched site cannot accidentally use the
# fixed/vendored runtime.
#
# Optional environment variables:
#   NEURO_SAN_SOURCE_DIR   Neuro-SAN Python checkout (default: ../neuro-san-dbox)
#   NEURO_SAN_WEB_DIR      neuro-san-web checkout (default: ../neuro-san-web)
#   NSDEPLOY_BUILD_PYTHON  Python 3.12 executable used by Transcrypt
#   NSDEPLOY_PYTHON        Python executable used to launch nsdeploy
#   NSDEPLOY_SKIP_INSTALL  Set to 1 to require preinstalled build dependencies

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
INVOCATION_DIR="$PWD"
TOTAL_STEPS=8

step() {
  local number="$1"
  shift
  printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$number" "$TOTAL_STEPS" "$*"
}

info() {
  printf '      %s\n' "$*"
}

fail() {
  printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2
  exit 1
}

resolve_file() {
  local value="$1"
  local path
  if [[ "$value" = /* ]]; then
    path="$value"
  else
    path="$INVOCATION_DIR/$value"
  fi
  [[ -f "$path" ]] || fail "file not found: $path"
  printf '%s/%s\n' "$(cd -- "$(dirname -- "$path")" && pwd)" "$(basename -- "$path")"
}

resolve_dir() {
  local value="$1"
  local path
  if [[ "$value" = /* ]]; then
    path="$value"
  else
    path="$INVOCATION_DIR/$value"
  fi
  [[ -d "$path" ]] || fail "directory not found: $path"
  (cd -- "$path" && pwd)
}

find_python() {
  local requested="${1:-}"
  if [[ -n "$requested" ]]; then
    if [[ "$requested" == */* ]]; then
      [[ -x "$requested" ]] || fail "Python executable is not executable: $requested"
      printf '%s\n' "$requested"
    else
      command -v "$requested" || fail "Python executable was not found on PATH: $requested"
    fi
    return
  fi
  command -v python3.12 || fail "Python 3.12 is required to create the Transcrypt build environment"
}

if (($# == 0)) || [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
  exit $(( $# == 0 ? 2 : 0 ))
fi

HOCON_ARG="$1"
shift
NSDEPLOY_ARGS=("$@")

for arg in "${NSDEPLOY_ARGS[@]}"; do
  if [[ "$arg" == "--runtime-dir" || "$arg" == --runtime-dir=* ]]; then
    fail "do not pass --runtime-dir; this script supplies the freshly generated runtime"
  fi
done

step 1 "Resolve and validate all inputs"
HOCON_PATH="$(resolve_file "$HOCON_ARG")"
NEURO_SAN_SOURCE_DIR="$(resolve_dir "${NEURO_SAN_SOURCE_DIR:-$PROJECT_DIR/../neuro-san-dbox}")"
NEURO_SAN_WEB_DIR="$(resolve_dir "${NEURO_SAN_WEB_DIR:-$PROJECT_DIR/../neuro-san-web}")"
RUNTIME_DIR="$NEURO_SAN_WEB_DIR/runtime"
REPORT_PATH="$RUNTIME_DIR/generated/nsxc-report.json"

[[ -f "$PROJECT_DIR/nsdeploy/__main__.py" ]] || fail "not an nsdeploy checkout: $PROJECT_DIR"
[[ -f "$NEURO_SAN_SOURCE_DIR/neuro_san/__init__.py" ]] || \
  fail "Neuro-SAN source package not found below: $NEURO_SAN_SOURCE_DIR"
[[ -f "$NEURO_SAN_WEB_DIR/build/generate.mjs" ]] || \
  fail "neuro-san-web generator not found below: $NEURO_SAN_WEB_DIR"
[[ -f "$NEURO_SAN_WEB_DIR/requirements-build.txt" ]] || \
  fail "neuro-san-web build requirements are missing"
[[ -f "$NEURO_SAN_WEB_DIR/package-lock.json" ]] || \
  fail "neuro-san-web package-lock.json is required for a reproducible build"

info "HOCON example:       $HOCON_PATH"
info "Neuro-SAN source:    $NEURO_SAN_SOURCE_DIR"
info "neuro-san-web:       $NEURO_SAN_WEB_DIR"
info "generated runtime:   $RUNTIME_DIR"
info "nsdeploy checkout:   $PROJECT_DIR"

step 2 "Check the Node.js and Python toolchains"
command -v node >/dev/null 2>&1 || fail "node is required (neuro-san-web requires Node.js 20+)"
command -v npm >/dev/null 2>&1 || fail "npm is required"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
((NODE_MAJOR >= 20)) || fail "Node.js 20+ is required; found $(node --version)"

BUILD_VENV="$NEURO_SAN_WEB_DIR/.venv"
if [[ -n "${NSDEPLOY_BUILD_PYTHON:-}" ]]; then
  BUILD_PYTHON="$(find_python "$NSDEPLOY_BUILD_PYTHON")"
elif [[ -x "$BUILD_VENV/bin/python" ]]; then
  BUILD_PYTHON="$BUILD_VENV/bin/python"
else
  BOOTSTRAP_PYTHON="$(find_python "")"
  info "Creating isolated Transcrypt environment: $BUILD_VENV"
  "$BOOTSTRAP_PYTHON" -m venv "$BUILD_VENV"
  BUILD_PYTHON="$BUILD_VENV/bin/python"
fi

BUILD_VERSION="$($BUILD_PYTHON -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
[[ "$BUILD_VERSION" == "3.12" ]] || fail "Transcrypt build Python must be 3.12; found $BUILD_VERSION at $BUILD_PYTHON"
info "Node.js:              $(node --version)"
info "npm:                  $(npm --version)"
info "Transcrypt Python:    $BUILD_PYTHON ($($BUILD_PYTHON --version 2>&1))"

if [[ -n "${NSDEPLOY_PYTHON:-}" ]]; then
  DEPLOY_PYTHON="$(find_python "$NSDEPLOY_PYTHON")"
elif [[ -x "$PROJECT_DIR/.venv/bin/python" ]]; then
  DEPLOY_PYTHON="$PROJECT_DIR/.venv/bin/python"
elif [[ -x "$PROJECT_DIR/venv/bin/python" ]]; then
  DEPLOY_PYTHON="$PROJECT_DIR/venv/bin/python"
else
  DEPLOY_PYTHON="$(find_python "")"
fi
info "nsdeploy Python:      $DEPLOY_PYTHON ($($DEPLOY_PYTHON --version 2>&1))"

step 3 "Install or verify the pinned cross-compiler and JavaScript dependencies"
if [[ "${NSDEPLOY_SKIP_INSTALL:-0}" =~ ^(1|true|yes)$ ]]; then
  info "NSDEPLOY_SKIP_INSTALL is set; verifying existing dependencies only."
  "$BUILD_PYTHON" -c \
    'from importlib.metadata import version; assert version("Transcrypt") == "3.9.5", version("Transcrypt")' \
    || fail "Transcrypt 3.9.5 is not installed in $BUILD_PYTHON"
  (cd -- "$NEURO_SAN_WEB_DIR" && npm ls --depth=0 >/dev/null) \
    || fail "npm dependencies are incomplete; run again without NSDEPLOY_SKIP_INSTALL"
else
  info "Installing the exact Python versions from requirements-build.txt."
  "$BUILD_PYTHON" -m pip install --disable-pip-version-check -r \
    "$NEURO_SAN_WEB_DIR/requirements-build.txt"
  if (cd -- "$NEURO_SAN_WEB_DIR" && npm ls --depth=0 >/dev/null 2>&1); then
    info "package-lock dependencies are already installed and valid."
  else
    info "Installing the exact JavaScript dependency tree with npm ci."
    (cd -- "$NEURO_SAN_WEB_DIR" && npm ci)
  fi
fi
TRANSCRYPT_VERSION="$($BUILD_PYTHON -c 'from importlib.metadata import version; print(version("Transcrypt"))')"
[[ "$TRANSCRYPT_VERSION" == "3.9.5" ]] || fail "expected Transcrypt 3.9.5, found $TRANSCRYPT_VERSION"
info "Verified Transcrypt $TRANSCRYPT_VERSION and package-lock dependencies."

step 4 "Record the exact Neuro-SAN input revision"
if git -C "$NEURO_SAN_SOURCE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SOURCE_COMMIT="$(git -C "$NEURO_SAN_SOURCE_DIR" rev-parse HEAD)"
  info "Git commit:           $SOURCE_COMMIT"
  if [[ -n "$(git -C "$NEURO_SAN_SOURCE_DIR" status --short --untracked-files=all)" ]]; then
    info "Git working tree:     DIRTY (all file types; Python inputs are reported separately below)"
  else
    info "Git working tree:     clean"
  fi
else
  info "Source is not a Git checkout; nsxc will identify it by its staged Python hash."
fi

step 5 "Generate JavaScript from the Neuro-SAN Python dependency closure"
info "The generator stages source, applies generic compatibility transforms, runs"
info "Transcrypt 3.9.5, bundles the declared LangChain.js mappings, and atomically"
info "replaces runtime/generated only after the complete build succeeds."
(
  cd -- "$NEURO_SAN_WEB_DIR"
  PYTHON_SOURCE_ROOT="$NEURO_SAN_SOURCE_DIR" \
  PYTHON="$BUILD_PYTHON" \
    npm run generate
)

step 6 "Verify the generated runtime and print its provenance"
for required in \
  "$RUNTIME_DIR/index.js" \
  "$RUNTIME_DIR/python-executor.js" \
  "$RUNTIME_DIR/generated/kernel.mjs" \
  "$RUNTIME_DIR/generated/kernel.d.ts" \
  "$RUNTIME_DIR/generated/neuro_san.internals.graph.activations.front_man_activation.mjs" \
  "$RUNTIME_DIR/generated/neuro_san.internals.run_context.langchain.core.langchain_run_context.mjs" \
  "$RUNTIME_DIR/generated/nsxc_browser.langchain_bridge.mjs" \
  "$REPORT_PATH"; do
  [[ -s "$required" ]] || fail "required generated/runtime artifact is missing or empty: $required"
done

"$BUILD_PYTHON" - "$REPORT_PATH" "$NEURO_SAN_SOURCE_DIR" <<'PY'
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
source_root = Path(sys.argv[2]).resolve()
report = json.loads(report_path.read_text(encoding="utf-8"))
compiler = report.get("compiler", {})
if compiler != {"name": "Transcrypt", "version": "3.9.5"}:
    raise SystemExit(f"FAILED: unexpected compiler record: {compiler!r}")
if report.get("source_mutated") is not False:
    raise SystemExit("FAILED: generator reports that the Neuro-SAN source was mutated")
if not report.get("files") or not report.get("closure_modules"):
    raise SystemExit("FAILED: generation report contains no files or dependency closure")

print(f"      Compiler:             {compiler['name']} {compiler['version']}")
print(f"      Python target:         {report.get('python')}")
print(f"      Closure modules:       {len(report['closure_modules'])}")
print(f"      Generated files:       {len(report['files'])}")
print(f"      Entry-point contracts: {len(report.get('entry_points', []))}")
print(f"      Compatibility warnings:{len(report.get('warnings', [])):>4}")
for revision in report.get("source_revisions", []):
    print(f"      Source commit:         {revision.get('git_commit') or '(not a Git checkout)'}")
    print(f"      Staged source SHA-256: {revision.get('staged_python_sha256')}")
    print(f"      Python inputs dirty:   {revision.get('dirty')}")
print(f"      Full build report:     {report_path}")
print(f"      Source remained read-only: {source_root}")
PY

step 7 "Smoke-test the JavaScript module graph and nsdeploy environment"
(
  cd -- "$NEURO_SAN_WEB_DIR"
  node --input-type=module -e "await import('./runtime/index.js')"
)
info "JavaScript entry point imported successfully: $RUNTIME_DIR/index.js"
(
  cd -- "$PROJECT_DIR"
  "$DEPLOY_PYTHON" -c 'import nsdeploy, pyhocon, mcp, uvicorn, starlette'
) || fail "nsdeploy dependencies are missing; run '$DEPLOY_PYTHON -m pip install -e $PROJECT_DIR'"
info "nsdeploy and its HOCON/MCP serving dependencies imported successfully."

step 8 "Launch nsdeploy with the freshly generated runtime"
info "Command: $DEPLOY_PYTHON -m nsdeploy $HOCON_PATH --runtime-dir $RUNTIME_DIR ${NSDEPLOY_ARGS[*]}"
info "This process remains in the foreground. Press Ctrl-C to stop it."
cd -- "$PROJECT_DIR"
exec "$DEPLOY_PYTHON" -m nsdeploy "$HOCON_PATH" \
  --runtime-dir "$RUNTIME_DIR" \
  "${NSDEPLOY_ARGS[@]}"
