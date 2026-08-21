#!/usr/bin/env bash
set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
LOG_DIR="${NSDEPLOY_LOG_DIR:-$PROJECT_DIR/.nsdeploy/cailville-logs}"
RUN_DIR="${NSDEPLOY_RUN_DIR:-$PROJECT_DIR/.nsdeploy/cailville-pids}"
UPSTREAM="${NSDEPLOY_UPSTREAM:-https://api.openai.com/v1}"
FACADE_UPSTREAM="${NSDEPLOY_FACADE_UPSTREAM:-$UPSTREAM}"
NEURO_SAN_WEB_DIR="${NSDEPLOY_NEURO_SAN_WEB_DIR:-$PROJECT_DIR/../neuro-san-web}"
RUNTIME_DIR="${NSDEPLOY_RUNTIME_DIR:-$NEURO_SAN_WEB_DIR/runtime}"
PRIVATE_STUDIO_DIR="${NSDEPLOY_PRIVATE_STUDIO_DIR:-$PROJECT_DIR/../cailville-private}"
PRIVATE_STUDIO_MANIFEST="${NSDEPLOY_PRIVATE_STUDIO_MANIFEST:-$PROJECT_DIR/.nsdeploy/cailville/manifest.hocon}"
PRIVATE_STUDIO_HTTP_PORT="${NSDEPLOY_PRIVATE_STUDIO_HTTP_PORT:-8181}"
PRIVATE_STUDIO_GRPC_PORT="${NSDEPLOY_PRIVATE_STUDIO_GRPC_PORT:-31021}"
PRIVATE_STUDIO_NSFLOW_PORT="${NSDEPLOY_PRIVATE_STUDIO_NSFLOW_PORT:-4174}"
PRIVATE_STUDIO_AGENT_TOOL_PATH="${NSDEPLOY_PRIVATE_STUDIO_AGENT_TOOL_PATH:-$PROJECT_DIR}"
PRIVATE_STUDIO_ENABLED="${NSDEPLOY_PRIVATE_STUDIO:-1}"
PRIVATE_STEWARD_SITE_TIMEOUT_SECONDS="${NSDEPLOY_STEWARD_SITE_TIMEOUT_SECONDS:-720}"
PRIVATE_STEWARD_BYOK_API_KEY="${NSDEPLOY_STEWARD_BYOK_API_KEY:-${OPENAI_API_KEY:-}}"
PRIVATE_STEWARD_BYOK_MODEL="${NSDEPLOY_STEWARD_BYOK_MODEL:-gpt-4o}"
THEME_MODEL="${NSDEPLOY_THEME_MODEL:-gpt-5.6}"
THEME_ENABLED="${NSDEPLOY_THEME:-1}"
THEME_REFRESH="${NSDEPLOY_THEME_REFRESH:-0}"

if [[ -z "$PRIVATE_STEWARD_BYOK_API_KEY" ]]; then
  printf 'Warning: no caller BYOK key in the launch environment.\n' >&2
  printf 'The private studio must load OPENAI_API_KEY itself, or public calls will be rejected.\n' >&2
fi

theme_args=()
if [[ ! "$THEME_ENABLED" =~ ^(0|false|no)$ ]]; then
  theme_args=(--theme --theme-model "$THEME_MODEL")
  if [[ ! "$THEME_REFRESH" =~ ^(0|false|no)$ ]]; then
    theme_args+=(--theme-refresh)
  fi
fi

if [[ -n "${NSDEPLOY_PYTHON:-}" ]]; then
  PYTHON_BIN="$NSDEPLOY_PYTHON"
elif [[ -x "$PROJECT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"
elif [[ -x "$PROJECT_DIR/venv/bin/python" ]]; then
  PYTHON_BIN="$PROJECT_DIR/venv/bin/python"
else
  PYTHON_BIN="$(command -v python3.12 || command -v python3 || command -v python)"
fi

if ! "$PYTHON_BIN" -c 'import nsdeploy, pyhocon' >/dev/null 2>&1; then
  printf 'Python interpreter lacks nsdeploy dependencies: %s\n' "$PYTHON_BIN" >&2
  printf 'Set NSDEPLOY_PYTHON to the Python 3.12 environment where nsdeploy is installed.\n' >&2
  exit 1
fi

if [[ ! -f "$RUNTIME_DIR/index.js" || ! -f "$RUNTIME_DIR/generated/kernel.mjs" ]]; then
  printf 'Built neuro-san-web runtime not found: %s\n' "$RUNTIME_DIR" >&2
  printf 'Run npm ci and npm run generate in %s, then retry.\n' "$NEURO_SAN_WEB_DIR" >&2
  exit 1
fi

sites=(
  rivera_household
  harbor_guide
  deneman_place
  butterpink_family
  seabreeze_inn
  greenbank_farm
  main_street_exchange
  neighbor_exchange
  tide_and_table_fishery
  salt_house_restaurant
  harbor_wheels_cooperative
  fix_and_found
  harbor_town_hall
)
ports=(8092 8091 8095 8096 8093 8094 8097 8098 8099 8100 8101 8102 8103)
pids=()
private_pid=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$private_pid" ]]; then
    printf '\nStopping private Neuro-SAN studio...\n'
    pkill -TERM -P "$private_pid" 2>/dev/null || true
    kill "$private_pid" 2>/dev/null || true
    wait "$private_pid" 2>/dev/null || true
  fi
  if ((${#pids[@]})); then
    printf '\nStopping Cailville sites...\n'
    for pid in "${pids[@]}"; do
      pkill -TERM -P "$pid" 2>/dev/null || true
    done
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/launcher.pid"
  rm -f "$RUN_DIR/private-studio.pid"
  for site in "${sites[@]}"; do
    rm -f "$RUN_DIR/$site.pid"
  done
}
trap cleanup EXIT INT TERM

for i in "${!sites[@]}"; do
  if lsof -nP -iTCP:"${ports[$i]}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s for %s is already in use.\n' "${ports[$i]}" "${sites[$i]}" >&2
    exit 1
  fi
done

for port in "$PRIVATE_STUDIO_HTTP_PORT" "$PRIVATE_STUDIO_GRPC_PORT" "$PRIVATE_STUDIO_NSFLOW_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Private Neuro-SAN studio port %s is already in use.\n' "$port" >&2
    exit 1
  fi
done

mkdir -p "$LOG_DIR" "$RUN_DIR"
printf '%s\n' "$$" >"$RUN_DIR/launcher.pid"
cd "$PROJECT_DIR"

for i in "${!sites[@]}"; do
  site="${sites[$i]}"
  port="${ports[$i]}"
  log="$LOG_DIR/$site.log"
  printf 'Starting %-27s http://127.0.0.1:%s/\n' "$site" "$port"
  site_command=("$PYTHON_BIN" -m nsdeploy "$CAILVILLE_DIR/$site.hocon" \
    --port "$port" \
    --upstream "$UPSTREAM" \
    --facade-upstream "$FACADE_UPSTREAM" \
    --runtime-dir "$RUNTIME_DIR")
  if [[ ! "$THEME_ENABLED" =~ ^(0|false|no)$ ]]; then
    site_command+=("${theme_args[@]}")
  fi
  PYTHONUNBUFFERED=1 "${site_command[@]}" >"$log" 2>&1 &
  pid="$!"
  pids+=("$pid")
  printf '%s\n' "$pid" >"$RUN_DIR/$site.pid"
done

deadline=$((SECONDS + 300))
for i in "${!sites[@]}"; do
  site="${sites[$i]}"
  port="${ports[$i]}"
  pid="${pids[$i]}"
  while ! curl --fail --silent --show-error --output /dev/null "http://127.0.0.1:$port/" 2>/dev/null; do
    if ! kill -0 "$pid" 2>/dev/null; then
      printf '\n%s failed to start. Last log lines:\n' "$site" >&2
      tail -30 "$LOG_DIR/$site.log" >&2
      exit 1
    fi
    if ((SECONDS >= deadline)); then
      printf '\nTimed out waiting for %s. See %s\n' "$site" "$LOG_DIR/$site.log" >&2
      exit 1
    fi
    sleep 1
  done
  printf 'Ready    %-27s http://127.0.0.1:%s/\n' "$site" "$port"
done

if [[ "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ || ! -d "$PRIVATE_STUDIO_DIR" ]]; then
  if [[ ! -d "$PRIVATE_STUDIO_DIR" && ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
    printf '\nPrivate Neuro-SAN studio project not found: %s\n' "$PRIVATE_STUDIO_DIR" >&2
    printf 'Continuing with the thirteen public browser sites only.\n' >&2
    printf 'Set NSDEPLOY_PRIVATE_STUDIO_DIR to enable the private stewards.\n' >&2
  else
    printf '\nPrivate Neuro-SAN studio disabled; running public browser sites only.\n'
  fi
  open "$CAILVILLE_DIR/cailville.html"
  printf '\nCailville public sites are running. Logs: %s\n' "$LOG_DIR"
  printf 'Press Ctrl-C to stop every site.\n'
  wait
  exit 0
fi
if [[ ! -f "$PRIVATE_STUDIO_MANIFEST" ]]; then
  printf '\nPrivate steward manifest not found: %s\n' "$PRIVATE_STUDIO_MANIFEST" >&2
  exit 1
fi

if [[ -x "$PRIVATE_STUDIO_DIR/.venv/bin/python" ]]; then
  PRIVATE_STUDIO_PYTHON="$PRIVATE_STUDIO_DIR/.venv/bin/python"
elif [[ -x "$PRIVATE_STUDIO_DIR/venv/bin/python" ]]; then
  PRIVATE_STUDIO_PYTHON="$PRIVATE_STUDIO_DIR/venv/bin/python"
else
  PRIVATE_STUDIO_PYTHON="${NSDEPLOY_PRIVATE_STUDIO_PYTHON:-$(command -v python3 || command -v python)}"
fi
PRIVATE_STUDIO_LOG="$LOG_DIR/private-neuro-san-studio.log"
PRIVATE_STUDIO_URL="http://127.0.0.1:$PRIVATE_STUDIO_NSFLOW_PORT"
PRIVATE_STUDIO_SERVER_URL="http://127.0.0.1:$PRIVATE_STUDIO_HTTP_PORT"
printf 'Starting private Neuro-SAN studio with %s\n' "$PRIVATE_STUDIO_MANIFEST"
(
  cd "$PRIVATE_STUDIO_DIR"
  AGENT_MANIFEST_FILE="$PRIVATE_STUDIO_MANIFEST" \
  AGENT_TOOL_PATH="$PRIVATE_STUDIO_AGENT_TOOL_PATH" \
  NSDEPLOY_STEWARD_SITE_TIMEOUT_SECONDS="$PRIVATE_STEWARD_SITE_TIMEOUT_SECONDS" \
  NSDEPLOY_STEWARD_BYOK_API_KEY="$PRIVATE_STEWARD_BYOK_API_KEY" \
  NSDEPLOY_STEWARD_BYOK_MODEL="$PRIVATE_STEWARD_BYOK_MODEL" \
  NSDEPLOY_PRIVATE_STUDIO_ROOT="$PRIVATE_STUDIO_DIR" \
  NEURO_SAN_SERVER_GRPC_PORT="$PRIVATE_STUDIO_GRPC_PORT" \
  PYTHONPATH="$PROJECT_DIR${PYTHONPATH:+:$PYTHONPATH}" \
  PYTHONUNBUFFERED=1 "$PRIVATE_STUDIO_PYTHON" -m nsdeploy.private_studio \
    --server-http-port "$PRIVATE_STUDIO_HTTP_PORT" \
    --server-grpc-port "$PRIVATE_STUDIO_GRPC_PORT" \
    --nsflow-port "$PRIVATE_STUDIO_NSFLOW_PORT" \
    --no-html
) >"$PRIVATE_STUDIO_LOG" 2>&1 &
private_pid="$!"
printf '%s\n' "$private_pid" >"$RUN_DIR/private-studio.pid"

private_deadline=$((SECONDS + 180))
while ! curl --fail --silent --show-error --output /dev/null "$PRIVATE_STUDIO_SERVER_URL" 2>/dev/null \
   || ! curl --fail --silent --show-error --output /dev/null "$PRIVATE_STUDIO_URL" 2>/dev/null; do
  if ! kill -0 "$private_pid" 2>/dev/null; then
    printf '\nPrivate Neuro-SAN studio failed to start. Last log lines:\n' >&2
    tail -40 "$PRIVATE_STUDIO_LOG" >&2
    exit 1
  fi
  if ((SECONDS >= private_deadline)); then
    printf '\nTimed out waiting for private Neuro-SAN studio. See %s\n' "$PRIVATE_STUDIO_LOG" >&2
    exit 1
  fi
  sleep 1
done
printf 'Ready    private Neuro-SAN server   %s\n' "$PRIVATE_STUDIO_SERVER_URL"
printf 'Ready    private Neuro-SAN nsFlow    %s\n' "$PRIVATE_STUDIO_URL"

open "$CAILVILLE_DIR/cailville.html"
open "$PRIVATE_STUDIO_URL"
printf '\nCailville is running. Logs: %s\n' "$LOG_DIR"
printf 'Private steward manifest: %s\n' "$PRIVATE_STUDIO_MANIFEST"
printf 'Private Neuro-SAN studio: %s\n' "$PRIVATE_STUDIO_URL"
printf 'Press Ctrl-C to stop every site.\n'
wait
