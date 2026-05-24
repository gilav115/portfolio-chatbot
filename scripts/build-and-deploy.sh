#!/usr/bin/env bash
# Build and deploy portfolio-chatbot to Cloudflare Workers.
#
# Run from anywhere inside the project:
#   bash scripts/build-and-deploy.sh
#
# Safe to run multiple times. Every step checks its own precondition before
# acting, so nothing is repeated or overwritten unnecessarily.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_DIR="$ROOT/setup"
CONFIG_FILE="$SETUP_DIR/config.json"
WORKER_DIR="$ROOT/worker"

# ── Helpers ──────────────────────────────────────────────────────────────────

ok()   { echo "  ok       $*"; }
skip() { echo "  skip     $*"; }
info() { echo "  info     $*"; }
warn() { echo "  warn     $*"; }
fail() { echo ""; echo "  ERROR    $*"; echo ""; exit 1; }
step() { echo ""; echo "Step $*"; }

# ── Header ───────────────────────────────────────────────────────────────────

echo ""
echo "portfolio-chatbot: deploy"
echo "========================"


# ════════════════════════════════════════════════════════════════════════════
step "1 of 6   Dependencies"
# ════════════════════════════════════════════════════════════════════════════

# Check Node.js is installed and is a recent enough version
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Install it from nodejs.org (version 18 or newer), then run this script again."
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js $NODE_VERSION is too old. Version 18 or newer is required. Update at nodejs.org, then run this script again."
fi
ok "Node.js $NODE_VERSION"

# Install npm dependencies if node_modules is missing or package.json is newer
if [ ! -d "$WORKER_DIR/node_modules" ]; then
  info "node_modules not found. Running npm install..."
  (cd "$WORKER_DIR" && npm install --silent)
  ok "npm install complete."
elif [ "$WORKER_DIR/package.json" -nt "$WORKER_DIR/node_modules" ]; then
  info "package.json has changed since last install. Running npm install..."
  (cd "$WORKER_DIR" && npm install --silent)
  ok "npm install complete."
else
  skip "npm modules already installed."
fi


# ════════════════════════════════════════════════════════════════════════════
step "2 of 6   Setup files"
# ════════════════════════════════════════════════════════════════════════════

# Copy any missing setup files from examples, then stop so the user can edit them
COPIED_ANY=0

if [ ! -f "$CONFIG_FILE" ]; then
  cp "$SETUP_DIR/examples/config.json" "$CONFIG_FILE"
  info "Created setup/config.json from the example."
  COPIED_ANY=1
fi

for EXAMPLE in "$SETUP_DIR/examples/"*.md; do
  [ -f "$EXAMPLE" ] || continue
  BASENAME="$(basename "$EXAMPLE")"
  TARGET="$SETUP_DIR/$BASENAME"
  if [ ! -f "$TARGET" ]; then
    cp "$EXAMPLE" "$TARGET"
    info "Created setup/$BASENAME from the example."
    COPIED_ANY=1
  fi
done

if [ "$COPIED_ANY" -eq 1 ]; then
  echo ""
  echo "  Example files have been copied into setup/."
  echo "  Edit them with your real information, then run this script again."
  echo ""
  exit 0
fi

# Validate setup/config.json is valid JSON before doing anything else
if ! python3 -c "import json,sys; json.load(open('$CONFIG_FILE'))" 2>/dev/null; then
  fail "setup/config.json is not valid JSON. Fix the syntax error and run this script again."
fi
ok "setup/config.json is valid JSON."

# Warn if config still has obvious placeholder values
OWNER_NAME="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('ownerName',''))" 2>/dev/null || echo '')"
BOT_NAME_VAL="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('botName',''))" 2>/dev/null || echo '')"
if [ "$OWNER_NAME" = "the professional" ] || [ "$OWNER_NAME" = "Alex Chen" ] || [ -z "$OWNER_NAME" ]; then
  warn "ownerName in setup/config.json still looks like a placeholder (\"$OWNER_NAME\"). Update it with your real name."
fi
if [ "$BOT_NAME_VAL" = "Assistant" ] || [ "$BOT_NAME_VAL" = "Alex's Bot" ] || [ -z "$BOT_NAME_VAL" ]; then
  warn "botName in setup/config.json still looks like a placeholder (\"$BOT_NAME_VAL\"). Update it."
fi

# List and count profile .md files
PROFILE_TEXT=""
PROFILE_COUNT=0
PROFILE_CHARS=0
PROFILE_FILES=""

for f in "$SETUP_DIR"/*.md; do
  [ -f "$f" ] || continue
  BASENAME="$(basename "$f")"
  SECTION="$(basename "$f" .md)"
  CONTENT="$(cat "$f")"
  CHAR_COUNT="${#CONTENT}"
  PROFILE_TEXT="${PROFILE_TEXT}

## ${SECTION}

${CONTENT}"
  PROFILE_COUNT=$((PROFILE_COUNT + 1))
  PROFILE_CHARS=$((PROFILE_CHARS + CHAR_COUNT))
  PROFILE_FILES="$PROFILE_FILES setup/$BASENAME($CHAR_COUNT chars)"
  ok "setup/$BASENAME   ($CHAR_COUNT characters)"
done

if [ "$PROFILE_COUNT" -eq 0 ]; then
  warn "No .md files found in setup/. The bot will deploy but will have nothing to answer from."
  warn "Add at least setup/about.md and setup/contact.md, then run this script again."
fi

info "Profile total: $PROFILE_COUNT file(s), $PROFILE_CHARS characters."


# ════════════════════════════════════════════════════════════════════════════
step "3 of 6   Cloudflare authentication"
# ════════════════════════════════════════════════════════════════════════════

cd "$WORKER_DIR"

WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1 || true)"

if echo "$WHOAMI_OUTPUT" | grep -qi "not authenticated\|You are not logged in\|No config found\|must be logged in\|error"; then
  echo ""
  echo "  You are not logged in to Cloudflare."
  echo ""
  echo "  Run this once to connect:"
  echo "    cd worker && npx wrangler login"
  echo ""
  echo "  A browser tab will open. Log in and click Authorize."
  echo "  Then run this script again."
  echo ""
  exit 1
fi

CF_ACCOUNT="$(echo "$WHOAMI_OUTPUT" | grep -oE "[a-zA-Z0-9._%+]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" | head -1 || echo 'your account')"
ok "Authenticated as: $CF_ACCOUNT"


# ════════════════════════════════════════════════════════════════════════════
step "4 of 6   Secrets"
# ════════════════════════════════════════════════════════════════════════════

info "Checking Cloudflare secrets..."
SECRET_LIST="$(npx wrangler secret list 2>/dev/null || echo '')"

HAS_LLM_KEY=0
HAS_WIDGET_TOKEN=0
echo "$SECRET_LIST" | grep -q "LLM_API_KEY"   && HAS_LLM_KEY=1     || true
echo "$SECRET_LIST" | grep -q "WIDGET_TOKEN"  && HAS_WIDGET_TOKEN=1 || true

MISSING_SECRETS=0

if [ "$HAS_LLM_KEY" -eq 1 ]; then
  ok "LLM_API_KEY is set."
else
  echo ""
  echo "  LLM_API_KEY is not set."
  echo ""
  echo "  Get a key from:"
  echo "    OpenAI:    platform.openai.com   -> API keys -> Create new secret key"
  echo "    Anthropic: console.anthropic.com -> API keys -> Create key"
  echo ""
  echo "  Then store it with:"
  echo "    cd worker && npx wrangler secret put LLM_API_KEY"
  echo ""
  MISSING_SECRETS=1
fi

if [ "$HAS_WIDGET_TOKEN" -eq 1 ]; then
  ok "WIDGET_TOKEN is set."
else
  echo ""
  echo "  WIDGET_TOKEN is not set."
  echo ""
  echo "  Make up any random string, for example: kR9mLp8wYz3jFaX7"
  echo "  Write it down. You will paste it into your website later."
  echo ""
  echo "  Then store it with:"
  echo "    cd worker && npx wrangler secret put WIDGET_TOKEN"
  echo ""
  MISSING_SECRETS=1
fi

if [ "$MISSING_SECRETS" -eq 1 ]; then
  fail "Set the missing secrets above, then run this script again."
fi


# ════════════════════════════════════════════════════════════════════════════
step "5 of 6   Uploading profile and config"
# ════════════════════════════════════════════════════════════════════════════

BOT_CONFIG="$(cat "$CONFIG_FILE")"

info "Uploading config to Cloudflare..."
printf '%s' "$BOT_CONFIG"   | npx wrangler secret put BOT_CONFIG_JSON 2>&1 | grep -v "^$" | sed 's/^/           /' || true
ok "Config uploaded."

info "Uploading profile text to Cloudflare..."
printf '%s' "$PROFILE_TEXT" | npx wrangler secret put PROFILE_TEXT 2>&1 | grep -v "^$" | sed 's/^/           /' || true
ok "Profile uploaded."


# ════════════════════════════════════════════════════════════════════════════
step "6 of 6   Deploying"
# ════════════════════════════════════════════════════════════════════════════

info "Running wrangler deploy..."
DEPLOY_OUTPUT="$(npx wrangler deploy 2>&1)"
echo "$DEPLOY_OUTPUT" | grep -v "^$" | sed 's/^/           /'

WORKER_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || echo '')"

if [ -n "$WORKER_URL" ] && [ -f "$CONFIG_FILE" ]; then
  python3 -c "
import json, os
with open('$CONFIG_FILE') as f:
    c = json.load(f)
c.setdefault('deployment', {})['workerUrl'] = '$WORKER_URL'
with open('$CONFIG_FILE', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Worker URL saved to setup/config.json." || true
fi


# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "========================"
echo "Deployed successfully."
echo ""
if [ -n "$WORKER_URL" ]; then
  echo "  Worker URL: $WORKER_URL"
  echo ""
  echo "  Copy this URL. You need it when adding the widget to your website."
else
  echo "  Worker URL: check the output above for a line ending in .workers.dev"
fi
echo ""
echo "  To update after editing setup/ files, run this script again."
echo "========================"
echo ""
