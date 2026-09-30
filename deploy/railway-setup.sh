#!/usr/bin/env bash
# One-time Railway setup for Booking Agent.
# Before running:  npm i -g @railway/cli  &&  railway login
#
# Fresh install (database on a Railway volume):
#   bash deploy/railway-setup.sh you@example.com
#
# Moving from Render (keep all customers and data — reuse the same Turso database AND the same APP_SECRET):
#   APP_SECRET='<from Render>' TURSO_DATABASE_URL='libsql://…' TURSO_AUTH_TOKEN='…' bash deploy/railway-setup.sh you@example.com
set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_EMAIL="${1:-}"
SERVICE="booking-agent"
SECRETS="deploy/railway-secrets.txt"

if [ -z "$ADMIN_EMAIL" ]; then echo "Usage: bash deploy/railway-setup.sh you@example.com"; exit 1; fi
command -v railway >/dev/null || { echo "Railway CLI missing. Run: npm i -g @railway/cli"; exit 1; }
railway whoami >/dev/null 2>&1 || { echo "Not logged in. Run: railway login"; exit 1; }

if [ -f "$SECRETS" ]; then
  echo "⚠️  $SECRETS already exists — this script was run before. Use 'railway up --service $SERVICE' to redeploy."
  exit 1
fi

APP_SECRET="${APP_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
TURSO_DATABASE_URL="${TURSO_DATABASE_URL:-}"
TURSO_AUTH_TOKEN="${TURSO_AUTH_TOKEN:-}"
ADMIN_PASSWORD="Adm-$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)7"

echo "→ Creating Railway project"
railway init --name booking-agent

echo "→ Creating service"
railway add --service "$SERVICE"

if [ -z "$TURSO_DATABASE_URL" ]; then
  echo "→ Adding persistent storage for the database (/data)"
  railway volume add --service "$SERVICE" --mount-path /data
  DB_VARS=("DATABASE_PATH=/data/app.db")
else
  echo "→ Using existing Turso database (no volume needed)"
  DB_VARS=("TURSO_DATABASE_URL=$TURSO_DATABASE_URL" "TURSO_AUTH_TOKEN=$TURSO_AUTH_TOKEN")
fi

echo "→ Creating public domain"
DOMAIN_OUT="$(railway domain --service "$SERVICE" --json 2>&1 || true)"
DOMAIN="$(echo "$DOMAIN_OUT" | grep -oE '[a-zA-Z0-9.-]+\.up\.railway\.app' | head -1 || true)"
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(railway domain list --service "$SERVICE" 2>/dev/null | grep -oE '[a-zA-Z0-9.-]+\.up\.railway\.app' | head -1 || true)"
fi
if [ -z "$DOMAIN" ]; then echo "Could not read the domain. Output was:"; echo "$DOMAIN_OUT"; exit 1; fi
PUBLIC_URL="https://$DOMAIN"

echo "→ Setting variables"
railway variable set \
  "NODE_ENV=production" \
  "${DB_VARS[@]}" \
  "PUBLIC_URL=$PUBLIC_URL" \
  "APP_NAME=Booking Agent" \
  "CLAUDE_MODEL=claude-sonnet-5-5" \
  "APP_SECRET=$APP_SECRET" \
  "ADMIN_EMAIL=$ADMIN_EMAIL" \
  "ADMIN_PASSWORD=$ADMIN_PASSWORD" \
  --service "$SERVICE" --skip-deploys

umask 077
cat > "$SECRETS" <<SECRETS_EOF
# Booking Agent – Railway production secrets. Keep this file safe; do not commit or share.
PUBLIC_URL=$PUBLIC_URL
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD   # first login only; change it in the app under Account
APP_SECRET=$APP_SECRET           # NEVER change: it encrypts customers' stored keys
SECRETS_EOF

echo "→ Deploying (first build takes 2–4 minutes)"
railway up --service "$SERVICE" --detach -y

echo
echo "✅ Done. App URL: $PUBLIC_URL"
echo "   Admin login:  $ADMIN_EMAIL  (password saved in $SECRETS)"
echo "   Watch the build: railway logs --service $SERVICE"
