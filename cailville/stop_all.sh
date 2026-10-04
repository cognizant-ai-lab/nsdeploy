#!/usr/bin/env bash
set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
RUN_DIR="${NSDEPLOY_RUN_DIR:-$PROJECT_DIR/.nsdeploy/cailville-pids}"
ROUTING="${NSDEPLOY_ROUTING:-port}"
GATEWAY_PORT="${NSDEPLOY_GATEWAY_PORT:-8080}"
if [[ -n "${NSDEPLOY_PYTHON:-}" ]]; then
  PYTHON_BIN="$NSDEPLOY_PYTHON"
elif [[ -x "$PROJECT_DIR/venv/bin/python" ]]; then
  PYTHON_BIN="$PROJECT_DIR/venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python)"
fi
ports=()
while read -r port; do
  [[ -n "$port" ]] && ports+=("$port")
done < <(
  cd "$PROJECT_DIR"
  "$PYTHON_BIN" -m nsdeploy.cailville ports \
    --cailville-dir "$CAILVILLE_DIR" --project-dir "$PROJECT_DIR"
)
private_studio_ports=(
  "${NSDEPLOY_PRIVATE_STUDIO_HTTP_PORT:-8181}"
  "${NSDEPLOY_PRIVATE_STUDIO_GRPC_PORT:-31021}"
  "${NSDEPLOY_PRIVATE_STUDIO_NSFLOW_PORT:-4174}"
)
all_ports=("${ports[@]}" "${private_studio_ports[@]}")
if [[ "$ROUTING" == "subdomain" ]]; then
  all_ports+=("$GATEWAY_PORT")
fi

signal_pid() {
  local signal="$1"
  local pid="$2"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  pkill -"$signal" -P "$pid" 2>/dev/null || true
  kill -"$signal" "$pid" 2>/dev/null || true
}

stop_pid() {
  local pid="$1"
  signal_pid TERM "$pid"
}

force_pid() {
  local pid="$1"
  signal_pid KILL "$pid"
}

stopped=0
if [[ -f "$RUN_DIR/launcher.pid" ]]; then
  launcher_pid="$(<"$RUN_DIR/launcher.pid")"
  launcher_command="$(ps -p "$launcher_pid" -o command= 2>/dev/null || true)"
  if [[ "$launcher_command" == *"launch_all.sh"* ]] && stop_pid "$launcher_pid"; then
    stopped=1
  fi
fi

if [[ -f "$RUN_DIR/gateway.pid" ]]; then
  gateway_pid="$(<"$RUN_DIR/gateway.pid")"
  if stop_pid "$gateway_pid"; then
    stopped=1
  fi
fi

if [[ -f "$RUN_DIR/private-studio.pid" ]]; then
  private_pid="$(<"$RUN_DIR/private-studio.pid")"
  if stop_pid "$private_pid"; then
    stopped=1
  fi
fi

for pid_file in "$RUN_DIR"/*.pid; do
  [[ -f "$pid_file" && "$pid_file" != "$RUN_DIR/launcher.pid" ]] || continue
  pid="$(<"$pid_file")"
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" == *"-m nsdeploy"* && "$command" == *"/cailville/"* ]] && stop_pid "$pid"; then
    stopped=1
  fi
done

for port in "${all_ports[@]}"; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if stop_pid "$pid"; then
      stopped=1
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
done

deadline=$((SECONDS + 5))
while ((SECONDS < deadline)); do
  running=0
  for port in "${all_ports[@]}"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      running=1
      break
    fi
  done
  ((running)) || break
  sleep 1
done

forced=0
for port in "${all_ports[@]}"; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if force_pid "$pid"; then
      forced=1
      stopped=1
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
done

if ((forced)); then
  deadline=$((SECONDS + 5))
  while ((SECONDS < deadline)); do
    running=0
    for port in "${all_ports[@]}"; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        running=1
        break
      fi
    done
    ((running)) || break
    sleep 1
  done
fi

remaining=()
for port in "${all_ports[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    remaining+=("$port")
  fi
done

if ((${#remaining[@]})); then
  printf 'Could not stop Cailville listeners on ports: %s\n' "${remaining[*]}" >&2
  exit 1
fi

rm -f "$RUN_DIR"/*.pid 2>/dev/null || true
if ((stopped)); then
  printf 'Stopped all Cailville sites.\n'
else
  printf 'No running Cailville sites found.\n'
fi
