#!/usr/bin/env bash
set -euo pipefail

echo "=== StripeV2 Deploy ==="
echo ""

# Load env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

TARGET="${1:-all}"

deploy_web() {
  echo "Deploying web to Vercel..."
  export VERCEL_ORG_ID=$(echo "$VERCEL_PROJECT_LINK" | python3 -c "import sys,json; print(json.load(sys.stdin)['orgId'])" 2>/dev/null || echo "")
  export VERCEL_PROJECT_ID="$VERCEL_PROJECT_ID"

  cd apps/web
  vercel deploy --prod -y --no-wait
  cd ../..
  echo "Web deployed."
}

deploy_server() {
  echo "Deploying server to Railway..."
  echo "Push to git and Railway will auto-deploy from the Dockerfile."
  echo "Or deploy manually:"
  echo "  cd apps/server && railway up"
  echo ""
  echo "Railway dashboard: $RAILWAY_HOSTING_DASHBOARD_URL"
}

deploy_docs() {
  echo "Deploying docs to Vercel..."
  cd apps/docs
  vercel deploy --prod -y --no-wait
  cd ../..
  echo "Docs deployed."
}

case "$TARGET" in
  web)    deploy_web ;;
  server) deploy_server ;;
  docs)   deploy_docs ;;
  all)
    deploy_web
    echo ""
    deploy_server
    echo ""
    deploy_docs
    ;;
  *)
    echo "Usage: pnpm deploy [web|server|docs|all]"
    exit 1
    ;;
esac

echo ""
echo "=== Deploy complete ==="
