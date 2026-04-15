#!/usr/bin/env bash
set -euo pipefail

# Load .env from project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

# Find free ports if current ones are in use
find_free_port() {
  local port="$1"
  while lsof -i :"$port" >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

export PORT=$(find_free_port "${PORT:-4000}")
export WEB_PORT=$(find_free_port "${WEB_PORT:-3000}")
export DOCS_PORT=$(find_free_port "${DOCS_PORT:-3001}")

# Avoid collisions between web and docs
if [ "$DOCS_PORT" -eq "$WEB_PORT" ]; then
  export DOCS_PORT=$(find_free_port $((WEB_PORT + 1)))
fi

# Update derived URLs
export BETTER_AUTH_URL="http://localhost:${PORT}"
export API_URL="http://localhost:${PORT}"
# Keep NEXT_PUBLIC_API_URL exported for any leftover client-side usage.
export NEXT_PUBLIC_API_URL="http://localhost:${PORT}"
export FRONTEND_URL="http://localhost:${WEB_PORT}"

echo "Starting dev servers..."
echo "  Web:    http://localhost:${WEB_PORT}"
echo "  Server: http://localhost:${PORT}"
echo "  Docs:   http://localhost:${DOCS_PORT}"
echo ""

# Run turbo with the resolved env
cd "$ROOT_DIR"
exec pnpm exec turbo dev "$@"
