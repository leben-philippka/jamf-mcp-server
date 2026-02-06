#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load env (contains JAMF_URL/JAMF_CLIENT_* etc.)
if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

# Ensure MCP mode + writable logging even if NODE_ENV=production
export MCP_MODE="true"
export LOG_DIR="$HOME/Library/Logs/jamf-mcp-server"
mkdir -p "$LOG_DIR"

exec node "dist/index.js" --mcp
