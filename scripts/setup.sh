#!/usr/bin/env bash
set -euo pipefail

echo "=== StripeV2 Setup ==="
echo ""

# Check prerequisites
command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v stripe >/dev/null 2>&1 || { echo "Error: stripe CLI is required. Install from: https://docs.stripe.com/stripe-cli"; exit 1; }

# Install dependencies
echo "1/4  Installing dependencies..."
pnpm install

# Pull environment variables from Stripe Projects
echo "2/4  Pulling environment variables from Stripe Projects..."
stripe projects env --pull

# --- Port detection ---
find_free_port() {
  local start_port="$1"
  local port="$start_port"
  while lsof -i :"$port" >/dev/null 2>&1; do
    echo "     Port $port is in use, trying $((port + 1))..."
    port=$((port + 1))
  done
  echo "$port"
}

# Find available ports
SERVER_PORT=$(find_free_port 4000)
WEB_PORT=$(find_free_port 3000)
DOCS_PORT=$(find_free_port 3001)
# Make sure docs port doesn't collide with web port
if [ "$DOCS_PORT" -eq "$WEB_PORT" ]; then
  DOCS_PORT=$(find_free_port $((WEB_PORT + 1)))
fi

echo "     Using ports: web=$WEB_PORT server=$SERVER_PORT docs=$DOCS_PORT"

# Add app-specific env vars
ENV_FILE=".env"

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # Update existing value
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
  echo "     Set ${key}=${value}"
}

# Set DATABASE_URL from PLANETSCALE_URL
if grep -q "^PLANETSCALE_URL=" "$ENV_FILE" && ! grep -q "^DATABASE_URL=" "$ENV_FILE"; then
  PSQL_URL=$(grep "^PLANETSCALE_URL=" "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")
  echo "DATABASE_URL='${PSQL_URL}'" >> "$ENV_FILE"
  echo "     Added DATABASE_URL (from PLANETSCALE_URL)"
fi

set_env "PORT" "$SERVER_PORT"
set_env "BETTER_AUTH_URL" "http://localhost:${SERVER_PORT}"
set_env "FRONTEND_URL" "http://localhost:${WEB_PORT}"
set_env "NEXT_PUBLIC_API_URL" "http://localhost:${SERVER_PORT}"
set_env "WEB_PORT" "$WEB_PORT"
set_env "DOCS_PORT" "$DOCS_PORT"

# Generate BETTER_AUTH_SECRET if missing
if ! grep -q "^BETTER_AUTH_SECRET=" "$ENV_FILE" 2>/dev/null; then
  SECRET=$(openssl rand -base64 32)
  echo "BETTER_AUTH_SECRET='${SECRET}'" >> "$ENV_FILE"
  echo "     Generated BETTER_AUTH_SECRET"
fi

# Push database schema
echo "3/4  Pushing database schema to PlanetScale..."
pnpm db:push

# Build all packages
echo "4/4  Building packages..."
pnpm build

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Run 'pnpm dev' to start development."
echo "  Web:    http://localhost:${WEB_PORT}"
echo "  Server: http://localhost:${SERVER_PORT}"
echo "  Docs:   http://localhost:${DOCS_PORT}"
