#!/usr/bin/env bash
set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
LOG_DIR="${NSDEPLOY_LOG_DIR:-$PROJECT_DIR/.nsdeploy/cailville-logs}"
RUN_DIR="${NSDEPLOY_RUN_DIR:-$PROJECT_DIR/.nsdeploy/cailville-pids}"
UPSTREAM="${NSDEPLOY_UPSTREAM:-https://api.openai.com/v1}"
FACADE_UPSTREAM="${NSDEPLOY_FACADE_UPSTREAM:-$UPSTREAM}"
PRIVATE_STUDIO_DIR="${NSDEPLOY_PRIVATE_STUDIO_DIR:-$PROJECT_DIR/../neuro-san-studio}"
PRIVATE_STUDIO_MANIFEST="${NSDEPLOY_PRIVATE_STUDIO_MANIFEST:-$PROJECT_DIR/.nsdeploy/cailville/manifest.hocon}"
STEWARD_SITES_FILE="$PROJECT_DIR/.nsdeploy/cailville/community-public-sites.json"
PRIVATE_STUDIO_HTTP_PORT="${NSDEPLOY_PRIVATE_STUDIO_HTTP_PORT:-8181}"
PRIVATE_STUDIO_GRPC_PORT="${NSDEPLOY_PRIVATE_STUDIO_GRPC_PORT:-31021}"
PRIVATE_STUDIO_NSFLOW_PORT="${NSDEPLOY_PRIVATE_STUDIO_NSFLOW_PORT:-4174}"
PRIVATE_STUDIO_AGENT_TOOL_PATH="${NSDEPLOY_PRIVATE_STUDIO_AGENT_TOOL_PATH:-$PROJECT_DIR}"
PRIVATE_STEWARD_SITE_TIMEOUT_SECONDS="${NSDEPLOY_STEWARD_SITE_TIMEOUT_SECONDS:-720}"
PRIVATE_STEWARD_BYOK_API_KEY="${NSDEPLOY_STEWARD_BYOK_API_KEY:-${OPENAI_API_KEY:-}}"
PRIVATE_STEWARD_BYOK_MODEL="${NSDEPLOY_STEWARD_BYOK_MODEL:-gpt-4o}"
PRIVATE_STEWARD_LLM_UPSTREAM="${NSDEPLOY_STEWARD_LLM_UPSTREAM:-$FACADE_UPSTREAM}"
THEME_MODEL="${NSDEPLOY_THEME_MODEL:-gpt-5.6}"
THEME_ENABLED="${NSDEPLOY_THEME:-1}"
THEME_REFRESH="${NSDEPLOY_THEME_REFRESH:-0}"
OPEN_BROWSER="${NSDEPLOY_OPEN_BROWSER:-1}"
PRIVATE_STUDIO_ENABLED="${NSDEPLOY_PRIVATE_STUDIO:-1}"
private_studio_ports=("$PRIVATE_STUDIO_HTTP_PORT" "$PRIVATE_STUDIO_GRPC_PORT" "$PRIVATE_STUDIO_NSFLOW_PORT")
ROUTING="${NSDEPLOY_ROUTING:-port}"
BASE_DOMAIN="${NSDEPLOY_BASE_DOMAIN:-localhost}"
GATEWAY_BIND="${NSDEPLOY_GATEWAY_BIND:-127.0.0.1}"
GATEWAY_PORT="${NSDEPLOY_GATEWAY_PORT:-8080}"
PUBLIC_SCHEME="${NSDEPLOY_PUBLIC_SCHEME:-http}"
PUBLIC_PORT="${NSDEPLOY_PUBLIC_PORT:-$GATEWAY_PORT}"

if [[ "$ROUTING" != "port" && "$ROUTING" != "subdomain" ]]; then
  printf 'NSDEPLOY_ROUTING must be port or subdomain, got %s\n' "$ROUTING" >&2
  exit 2
fi

if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ && -z "$PRIVATE_STEWARD_BYOK_API_KEY" ]]; then
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
  PYTHON_BIN="$(command -v python3 || command -v python)"
fi

cd "$PROJECT_DIR"
# Shared only by the local arbiter and private studio; never a model credential.
export NSDEPLOY_COMMERCE_KEY_FILE="${NSDEPLOY_COMMERCE_KEY_FILE:-$PROJECT_DIR/.nsdeploy/cailville/.commerce/steward.key}"
sites=()
ports=()
hocons=()
site_dirs=()
studios=()
link_files=()
origins=()
launch_row_args=(
  --cailville-dir "$CAILVILLE_DIR" --project-dir "$PROJECT_DIR"
)
if [[ "$ROUTING" == "subdomain" ]]; then
  launch_row_args+=(
    --base-domain "$BASE_DOMAIN"
    --public-scheme "$PUBLIC_SCHEME"
    --public-port "$PUBLIC_PORT"
  )
fi
while IFS=$'\t' read -r site port hocon site_dir studio link_file origin; do
  [[ -n "$site" ]] || continue
  sites+=("$site")
  ports+=("$port")
  hocons+=("$hocon")
  site_dirs+=("$site_dir")
  studios+=("$studio")
  link_files+=("$link_file")
  origins+=("$origin")
done < <(
  "$PYTHON_BIN" -m nsdeploy.cailville launch-rows "${launch_row_args[@]}"
)
if ((${#sites[@]} == 0)); then
  printf 'No sites found in %s\n' "$CAILVILLE_DIR/community.json" >&2
  exit 1
fi

demo_ports=("${ports[@]}")
if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
  demo_ports+=("${private_studio_ports[@]}")
fi

pids=()
private_pid=""
gateway_pid=""

signal_tree() {
  local signal="$1"
  local pid="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  pkill -"$signal" -P "$pid" 2>/dev/null || true
  kill -"$signal" "$pid" 2>/dev/null || true
}

demo_ports_busy() {
  local port
  for port in "${demo_ports[@]}"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
  done
  if [[ "$ROUTING" == "subdomain" ]] \
     && lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$private_pid" ]]; then
    printf '\nStopping private Neuro-SAN studio...\n'
    signal_tree TERM "$private_pid"
  fi
  if [[ -n "$gateway_pid" ]]; then
    printf '\nStopping nsdeploy subdomain gateway...\n'
    signal_tree TERM "$gateway_pid"
  fi
  if ((${#pids[@]})); then
    printf '\nStopping Cailville sites...\n'
    for pid in "${pids[@]}"; do
      signal_tree TERM "$pid"
    done
  fi

  local deadline=$((SECONDS + 5))
  while ((SECONDS < deadline)) && demo_ports_busy; do
    sleep 1
  done

  # Some HTTP server loops can outlive their launching shell. Bound graceful
  # shutdown, then force only the PIDs we started and listeners on demo ports.
  if [[ -n "$private_pid" ]]; then
    signal_tree KILL "$private_pid"
  fi
  if [[ -n "$gateway_pid" ]]; then
    signal_tree KILL "$gateway_pid"
  fi
  if ((${#pids[@]})); then
    for pid in "${pids[@]}"; do
      signal_tree KILL "$pid"
    done
  fi
  local port listener_pid
  for port in "${demo_ports[@]}"; do
    while read -r listener_pid; do
      [[ -n "$listener_pid" ]] && signal_tree KILL "$listener_pid"
    done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  done
  if [[ "$ROUTING" == "subdomain" ]]; then
    while read -r listener_pid; do
      [[ -n "$listener_pid" ]] && signal_tree KILL "$listener_pid"
    done < <(lsof -tiTCP:"$GATEWAY_PORT" -sTCP:LISTEN 2>/dev/null || true)
  fi

  [[ -z "$private_pid" ]] || wait "$private_pid" 2>/dev/null || true
  [[ -z "$gateway_pid" ]] || wait "$gateway_pid" 2>/dev/null || true
  ((${#pids[@]} == 0)) || wait "${pids[@]}" 2>/dev/null || true
  if demo_ports_busy; then
    printf 'Warning: one or more Cailville ports did not stop cleanly. Run %s.\n' \
      "$CAILVILLE_DIR/stop_all.sh" >&2
  fi
  rm -f "$RUN_DIR/launcher.pid"
  if [[ -n "$private_pid" ]]; then
    rm -f "$RUN_DIR/private-studio.pid"
  fi
  rm -f "$RUN_DIR/gateway.pid"
  for site in "${sites[@]}"; do
    rm -f "$RUN_DIR/$site.pid"
  done
}
trap cleanup EXIT INT TERM

if demo_ports_busy; then
  printf 'Found an earlier Cailville run; cleaning it up before launch...\n'
  "$CAILVILLE_DIR/stop_all.sh"
fi

for i in "${!sites[@]}"; do
  if lsof -nP -iTCP:"${ports[$i]}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s for %s is already in use.\n' "${ports[$i]}" "${sites[$i]}" >&2
    exit 1
  fi
done

if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
  for port in "${private_studio_ports[@]}"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      printf 'Private Neuro-SAN studio port %s is already in use.\n' "$port" >&2
      exit 1
    fi
  done
fi
if [[ "$ROUTING" == "subdomain" ]] \
   && lsof -nP -iTCP:"$GATEWAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Subdomain gateway port %s is already in use.\n' "$GATEWAY_PORT" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$RUN_DIR"
printf '%s\n' "$$" >"$RUN_DIR/launcher.pid"

for i in "${!sites[@]}"; do
  site="${sites[$i]}"
  port="${ports[$i]}"
  hocon="${hocons[$i]}"
  site_dir="${site_dirs[$i]}"
  studio="${studios[$i]}"
  log="$LOG_DIR/$site.log"
  printf 'Starting %-27s %s\n' "$site" "${origins[$i]}"
  deploy_args=(
    "$hocon"
    --port "$port"
    --out "$PROJECT_DIR/.nsdeploy/cailville/$site"
    --site-dir "$site_dir"
    --site-url "${origins[$i]}"
    --steward-sites "$STEWARD_SITES_FILE"
    --upstream "$UPSTREAM"
    --facade-upstream "$FACADE_UPSTREAM"
  )
  if [[ "${link_files[$i]}" != "-" ]]; then
    deploy_args+=(--links "${link_files[$i]}")
  fi
  if ((${#theme_args[@]})); then
    deploy_args+=("${theme_args[@]}")
  fi
  if [[ "$studio" != "-" ]]; then
    deploy_args+=(--studio "$studio")
  fi
  PYTHONUNBUFFERED=1 "$PYTHON_BIN" -m nsdeploy "${deploy_args[@]}" >"$log" 2>&1 &
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
  printf 'Ready    %-27s %s\n' "$site" "${origins[$i]}"
done

if [[ "$ROUTING" == "subdomain" ]]; then
  gateway_args=(
    gateway --base-domain "$BASE_DOMAIN" --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT"
  )
  for i in "${!sites[@]}"; do
    gateway_args+=(--route "${sites[$i]}=http://127.0.0.1:${ports[$i]}")
  done
  gateway_log="$LOG_DIR/subdomain-gateway.log"
  PYTHONUNBUFFERED=1 "$PYTHON_BIN" -m nsdeploy "${gateway_args[@]}" >"$gateway_log" 2>&1 &
  gateway_pid="$!"
  printf '%s\n' "$gateway_pid" >"$RUN_DIR/gateway.pid"
  gateway_deadline=$((SECONDS + 30))
  gateway_host="${origins[0]#*://}"
  gateway_host="${gateway_host%%:*}"
  while ! curl --fail --silent --show-error --output /dev/null \
      -H "Host: $gateway_host" "http://127.0.0.1:$GATEWAY_PORT/" 2>/dev/null; do
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      printf '\nSubdomain gateway failed to start. Last log lines:\n' >&2
      tail -30 "$gateway_log" >&2
      exit 1
    fi
    if ((SECONDS >= gateway_deadline)); then
      printf '\nTimed out waiting for subdomain gateway. See %s\n' "$gateway_log" >&2
      exit 1
    fi
    sleep 1
  done
  printf 'Ready    subdomain gateway          %s://*.%s\n' "$PUBLIC_SCHEME" "$BASE_DOMAIN"
fi

# Concurrent site generation writes a broad aggregate manifest. Rebuild it from
# the active map so a base-map reset cannot retain private stewards from old demos.
"$PYTHON_BIN" -m nsdeploy.cailville active-manifest \
  --cailville-dir "$CAILVILLE_DIR" --project-dir "$PROJECT_DIR"

if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
  if [[ ! -d "$PRIVATE_STUDIO_DIR" ]]; then
    printf '\nPrivate Neuro-SAN studio project not found: %s\n' "$PRIVATE_STUDIO_DIR" >&2
    printf 'Set NSDEPLOY_PRIVATE_STUDIO_DIR to its location and rerun.\n' >&2
    exit 1
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
    NSDEPLOY_STEWARD_LLM_UPSTREAM="$PRIVATE_STEWARD_LLM_UPSTREAM" \
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
fi

if [[ ! "$OPEN_BROWSER" =~ ^(0|false|no)$ ]]; then
  open "$CAILVILLE_DIR/cailville.html"
  if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
    open "$PRIVATE_STUDIO_URL"
  fi
fi
printf '\nCailville is running. Logs: %s\n' "$LOG_DIR"
if [[ "$ROUTING" == "subdomain" ]]; then
  printf 'Public site routing: %s://<network>.%s\n' "$PUBLIC_SCHEME" "$BASE_DOMAIN"
fi
printf 'Private steward manifest: %s\n' "$PRIVATE_STUDIO_MANIFEST"
if [[ ! "$PRIVATE_STUDIO_ENABLED" =~ ^(0|false|no)$ ]]; then
  printf 'Private Neuro-SAN studio: %s\n' "$PRIVATE_STUDIO_URL"
fi
printf 'Press Ctrl-C to stop every site.\n'
wait
