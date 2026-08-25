#!/usr/bin/env bash
#
# Rebuild and launch every public Cailville site against JavaScript generated
# from the current Neuro-SAN Python checkout. Every editable site theme is
# deliberately regenerated, so existing layout.html/theme.css/theme.json/site.js
# files below cailville/sites are replaced by fresh theme output.
#
# Usage:
#   ./cailville/rebuild_all.sh
#
# Required for the default theme provider:
#   OPENAI_API_KEY          key used to make the thirteen theme-generation calls
#
# Optional environment variables:
#   NEURO_SAN_SOURCE_DIR    Neuro-SAN checkout (default: ../neuro-san-dbox)
#   NEURO_SAN_WEB_DIR       neuro-san-web checkout (default: ../neuro-san-web)
#   NSDEPLOY_BUILD_PYTHON   Python 3.12 used by Transcrypt
#   NSDEPLOY_PYTHON         Python used to run nsdeploy
#   NSDEPLOY_SKIP_INSTALL   1 to verify, but not install, build dependencies
#   NSDEPLOY_THEME_MODEL    theme model (default comes from launch_all.sh)
#   NSDEPLOY_UPSTREAM       runtime BYOK proxy upstream
#
# The script starts only the thirteen public browser sites. It remains in the
# foreground after opening the Cailville map; press Ctrl-C to stop every site.

set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
TOTAL_STEPS=3

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

resolve_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "directory not found: $path"
  (cd -- "$path" && pwd)
}

usage() {
  sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
}

if (($#)); then
  if (($# == 1)) && [[ "$1" == "-h" || "$1" == "--help" ]]; then
    usage
    exit 0
  fi
  usage >&2
  fail "this script accepts no command-line arguments; configure it with the documented environment variables"
fi

step 1 "Validate the three checkouts and destructive theme-refresh intent"
NEURO_SAN_SOURCE_DIR="$(resolve_dir "${NEURO_SAN_SOURCE_DIR:-$PROJECT_DIR/../neuro-san-dbox}")"
NEURO_SAN_WEB_DIR="$(resolve_dir "${NEURO_SAN_WEB_DIR:-$PROJECT_DIR/../neuro-san-web}")"

[[ -f "$PROJECT_DIR/nsdeploy/__main__.py" ]] || fail "not an nsdeploy checkout: $PROJECT_DIR"
[[ -f "$NEURO_SAN_SOURCE_DIR/neuro_san/__init__.py" ]] || \
  fail "Neuro-SAN Python source was not found below: $NEURO_SAN_SOURCE_DIR"
[[ -f "$NEURO_SAN_WEB_DIR/build/generate.mjs" ]] || \
  fail "neuro-san-web generator was not found below: $NEURO_SAN_WEB_DIR"
[[ -x "$PROJECT_DIR/scripts/generate-runtime-and-launch.sh" ]] || \
  fail "runtime generation launcher is missing or not executable"
[[ -x "$CAILVILLE_DIR/launch_all.sh" ]] || fail "Cailville launcher is missing or not executable"

shopt -s nullglob
public_hocons=("$CAILVILLE_DIR"/*.hocon)
shopt -u nullglob
((${#public_hocons[@]} == 13)) || \
  fail "expected 13 public Cailville HOCON files, found ${#public_hocons[@]}"

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  fail "OPENAI_API_KEY is required to regenerate every theme with the default provider"
fi

export NEURO_SAN_SOURCE_DIR NEURO_SAN_WEB_DIR
export NSDEPLOY_NEURO_SAN_WEB_DIR="$NEURO_SAN_WEB_DIR"
info "Neuro-SAN Python:    $NEURO_SAN_SOURCE_DIR"
info "neuro-san-web:       $NEURO_SAN_WEB_DIR"
info "nsdeploy:            $PROJECT_DIR"
info "Public sites:        ${#public_hocons[@]}"
info "Theme model:         ${NSDEPLOY_THEME_MODEL:-gpt-5.6}"
info "Theme files below cailville/sites will be replaced intentionally."

step 2 "Generate and verify neuro-san-web JavaScript from the Neuro-SAN source"
info "The shared generator installs/verifies pinned dependencies, runs Transcrypt"
info "3.9.5, validates the generated closure, and imports the JavaScript entry point."
"$PROJECT_DIR/scripts/generate-runtime-and-launch.sh" \
  "$CAILVILLE_DIR/harbor_guide.hocon" \
  --port 8091 \
  --no-serve \
  --no-cruse

step 3 "Regenerate all thirteen themes, rebuild all public sites, and launch them"
info "For every public HOCON, nsdeploy will pass --theme --theme-refresh and use"
info "the freshly generated runtime at $NEURO_SAN_WEB_DIR/runtime."
info "Per-site build output is written below $PROJECT_DIR/.nsdeploy/cailville-logs."
info "The private steward/studio is disabled for this public browser test."
info "When all sites answer health checks, launch_all.sh opens cailville.html."

export NSDEPLOY_THEME=1
export NSDEPLOY_THEME_REFRESH=1
export NSDEPLOY_THEME_REFRESH_REQUIRED=1
export NSDEPLOY_PRIVATE_STUDIO=0
exec "$CAILVILLE_DIR/launch_all.sh"
