#!/usr/bin/env bash
#
# serve-local-model.sh — bring up a local, OpenAI-compatible LLM for nsdeploy.
#
# Uses Ollama (https://ollama.com) to serve a model on http://127.0.0.1:11434.
# That URL speaks the OpenAI API at /v1, so nsdeploy can use it both for
# deploy-time theming (--theme-upstream) and at runtime (paste it into the page's
# BYOK settings). No API key and no cloud account required — it all runs locally.
#
# Usage:
#   scripts/serve-local-model.sh                 # pull + serve qwen2.5:7b (default)
#   scripts/serve-local-model.sh llama3.2:3b     # a different model
#   MODEL=qwen2.5:7b scripts/serve-local-model.sh
#
# When it finishes it prints the exact nsdeploy command to deploy with this model.

set -euo pipefail

MODEL="${1:-${MODEL:-qwen2.5:7b}}"
HOST="127.0.0.1"
PORT="11434"
BASE="http://${HOST}:${PORT}"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

# 1. Make sure Ollama is installed -------------------------------------------
if ! command -v ollama >/dev/null 2>&1; then
  err "Ollama isn't installed. Install it, then re-run this script:"
  case "$(uname -s)" in
    Darwin) echo "    brew install ollama        # or download from https://ollama.com/download" ;;
    Linux)  echo "    curl -fsSL https://ollama.com/install.sh | sh" ;;
    *)      echo "    See https://ollama.com/download" ;;
  esac
  exit 1
fi

# 2. Make sure the server is running -----------------------------------------
if curl -fsS -m 2 "${BASE}/api/tags" >/dev/null 2>&1; then
  say "Ollama is already serving at ${BASE}"
else
  say "Starting 'ollama serve' in the background (logs: /tmp/ollama-serve.log)…"
  nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 "${BASE}/api/tags" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! curl -fsS -m 2 "${BASE}/api/tags" >/dev/null 2>&1; then
    err "Ollama didn't come up on ${BASE}. Check /tmp/ollama-serve.log"
    exit 1
  fi
  say "Ollama is up at ${BASE}"
fi

# 3. Pull the model (idempotent — skips if already present) ------------------
say "Pulling model '${MODEL}' (first time downloads a few GB; later runs are instant)…"
ollama pull "${MODEL}"

# 4. Tell the user how to use it ---------------------------------------------
cat <<EOF

✅ Local model '${MODEL}' is ready at ${BASE}

Deploy a network themed by this local model (no key reaches the cloud):

    python -m nsdeploy examples/soccer_world_cup_assistant.hocon --port 8080 \\
        --theme --theme-model ${MODEL} --theme-key x \\
        --theme-upstream ${BASE}/v1

To also run the deployed agents on this local model, open "⚙ BYOK settings"
in the page and enter:
    Router base URL : ${BASE}/v1
    Model           : ${MODEL}
    API key         : x        (Ollama ignores it, but the field must be non-empty)

Leave this terminal open (or keep 'ollama serve' running) while you use the site.
EOF
