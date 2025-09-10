#!/usr/bin/env bash
set -euo pipefail

# Load .env if present to avoid exporting env vars manually each run
if [[ -f .env ]]; then
  echo "Loading environment from .env"
  # Export all variables defined in .env
  set -a
  source .env
  set +a
else
  echo "No .env file found (optional). Create one from .env.example to avoid manual exports."
fi

# Allow overriding Ollama endpoint via env, otherwise config.json controls defaults
export OLLAMA_ENDPOINT=${OLLAMA_ENDPOINT:-}

mode=${1:-}
if [[ "$mode" == "dev" ]]; then
  echo "Starting Email Agent REST server in dev (auto-reload) mode..."
  npm run dev
else
  echo "Starting Email Agent REST server..."
  npm start
fi
