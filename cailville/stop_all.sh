#!/usr/bin/env bash
set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
RUN_DIR="${NSDEPLOY_RUN_DIR:-$PROJECT_DIR/.nsdeploy/cailville-pids}"
ports=(8092 8091 8095 8096 8093 8094 8097 8098 8099 8100 8101 8102 8103)
private_studio_ports=(
  "${NSDEPLOY_PRIVATE_STUDIO_HTTP_PORT:-8181}"
  "${NSDEPLOY_PRIVATE_STUDIO_GRPC_PORT:-31021}"
  "${NSDEPLOY_PRIVATE_STUDIO_NSFLOW_PORT:-4174}"
)

stop_pid() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
}

stopped=0
if [[ -f "$RUN_DIR/launcher.pid" ]]; then
  launcher_pid="$(<"$RUN_DIR/launcher.pid")"
  launcher_command="$(ps -p "$launcher_pid" -o command= 2>/dev/null || true)"
  if [[ "$launcher_command" == *"launch_all.sh"* ]] && stop_pid "$launcher_pid"; then
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

for port in "${ports[@]}"; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if stop_pid "$pid"; then
      stopped=1
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
done

for port in "${private_studio_ports[@]}"; do
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if stop_pid "$pid"; then
      stopped=1
    fi
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
done

deadline=$((SECONDS + 15))
while ((SECONDS < deadline)); do
  running=0
  for port in "${ports[@]}"; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      running=1
      break
    fi
  done
  if ((running == 0)); then
    for port in "${private_studio_ports[@]}"; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        running=1
        break
      fi
    done
  fi
  ((running)) || break
  sleep 1
done

remaining=()
for port in "${ports[@]}"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    remaining+=("$port")
  fi
done

for port in "${private_studio_ports[@]}"; do
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
