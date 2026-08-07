#!/usr/bin/env bash
set -Eeuo pipefail

CAILVILLE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$CAILVILLE_DIR/.." && pwd)"
LOG_DIR="${NSDEPLOY_LOG_DIR:-$PROJECT_DIR/.nsdeploy/cailville-logs}"
RUN_DIR="${NSDEPLOY_RUN_DIR:-$PROJECT_DIR/.nsdeploy/cailville-pids}"
UPSTREAM="${NSDEPLOY_UPSTREAM:-http://localhost:12434/engines/v1}"
THEME_MODEL="${NSDEPLOY_THEME_MODEL:-gpt-4o}"

if [[ -n "${NSDEPLOY_PYTHON:-}" ]]; then
  PYTHON_BIN="$NSDEPLOY_PYTHON"
elif [[ -x "$PROJECT_DIR/venv/bin/python" ]]; then
  PYTHON_BIN="$PROJECT_DIR/venv/bin/python"
else
  PYTHON_BIN="$(command -v python3 || command -v python)"
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

cleanup() {
  trap - EXIT INT TERM
  if ((${#pids[@]})); then
    printf '\nStopping Cailville sites...\n'
    for pid in "${pids[@]}"; do
      pkill -TERM -P "$pid" 2>/dev/null || true
    done
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/launcher.pid"
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

mkdir -p "$LOG_DIR" "$RUN_DIR"
printf '%s\n' "$$" >"$RUN_DIR/launcher.pid"
cd "$PROJECT_DIR"

for i in "${!sites[@]}"; do
  site="${sites[$i]}"
  port="${ports[$i]}"
  log="$LOG_DIR/$site.log"
  printf 'Starting %-27s http://127.0.0.1:%s/\n' "$site" "$port"
  PYTHONUNBUFFERED=1 "$PYTHON_BIN" -m nsdeploy "$CAILVILLE_DIR/$site.hocon" \
    --port "$port" \
    --upstream "$UPSTREAM" \
    --theme \
    --theme-model "$THEME_MODEL" \
    --theme-refresh >"$log" 2>&1 &
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

open "$CAILVILLE_DIR/cailville.html"
printf '\nCailville is running. Logs: %s\nPress Ctrl-C to stop every site.\n' "$LOG_DIR"
wait
