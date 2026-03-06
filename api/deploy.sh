#!/usr/bin/env bash
# =============================================================================
# CustomerMaxing API — Deploy Script
# =============================================================================
# Usage: bash deploy.sh
# Requires: wrangler CLI installed (npm i -g wrangler), authenticated with Cloudflare
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== CustomerMaxing API Deploy ==="
echo ""

# Step 1: Set secrets (only needed once, or when rotating)
echo "--- Step 1: Set secrets (skip if already set) ---"
echo "Run these commands manually if secrets are not yet configured:"
echo ""
echo "  npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY"
echo "  npx wrangler secret put TWILIO_ACCOUNT_SID"
echo "  npx wrangler secret put TWILIO_AUTH_TOKEN"
echo "  npx wrangler secret put ANTHROPIC_API_KEY"
echo ""

# Step 2: Deploy the worker
echo "--- Step 2: Deploying worker ---"
npx wrangler deploy

echo ""
echo "=== Deploy complete ==="
echo ""
echo "Post-deploy checklist:"
echo "  1. Configure Twilio webhook URLs in the Twilio console:"
echo "     - Voice webhook: https://customermaxing-api.<your-subdomain>.workers.dev/api/twilio/incoming"
echo "     - Status callback: https://customermaxing-api.<your-subdomain>.workers.dev/api/twilio/status"
echo "  2. Run schema.sql against your Supabase database"
echo "  3. Verify with: curl https://customermaxing-api.<your-subdomain>.workers.dev/api/health"
