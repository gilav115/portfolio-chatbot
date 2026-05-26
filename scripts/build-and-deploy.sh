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
export ROOT
SETUP_DIR="$ROOT/setup"
PROFILE_DIR="$SETUP_DIR/profile"
CONFIG_FILE="$SETUP_DIR/config.json"
WORKER_DIR="$ROOT/worker"
WIDGET_WORKER_DIR="$ROOT/widget-worker"
WRANGLER="$WORKER_DIR/node_modules/.bin/wrangler"

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
step "1 of 7   Dependencies"
# ════════════════════════════════════════════════════════════════════════════

if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Install it from nodejs.org (version 18 or newer), then run this script again."
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js $NODE_VERSION is too old. Version 18 or newer is required. Update at nodejs.org, then run this script again."
fi
ok "Node.js $NODE_VERSION"

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
step "2 of 7   Setup files"
# ════════════════════════════════════════════════════════════════════════════

# Copy config.json from examples if missing
if [ ! -f "$CONFIG_FILE" ]; then
  cp "$SETUP_DIR/examples/config.json" "$CONFIG_FILE"
  info "Created setup/config.json from the example. Edit it with your details."
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

# Create setup/profile/ from examples if it doesn't exist or has no .md files
if [ ! -d "$PROFILE_DIR" ] || ! ls "$PROFILE_DIR"/*.md >/dev/null 2>&1; then
  mkdir -p "$PROFILE_DIR"
  EXAMPLES_DIR="$SETUP_DIR/examples"
  if [ -d "$EXAMPLES_DIR" ]; then
    for EXAMPLE in "$EXAMPLES_DIR"/*.md; do
      [ -f "$EXAMPLE" ] || continue
      BASENAME="$(basename "$EXAMPLE")"
      TARGET="$PROFILE_DIR/$BASENAME"
      if [ ! -f "$TARGET" ]; then
        cp "$EXAMPLE" "$TARGET"
        info "Created setup/profile/$BASENAME from example template."
      fi
    done
  fi
fi

# Read and concatenate profile .md files — skip any still containing the example marker
PROFILE_TEXT=""
PROFILE_COUNT=0
PROFILE_CHARS=0
PROFILE_FILES=""
EXAMPLE_MARKER="PORTFOLIO-CHATBOT-EXAMPLE"

for f in "$PROFILE_DIR"/*.md; do
  [ -f "$f" ] || continue
  if grep -q "$EXAMPLE_MARKER" "$f"; then
    warn "setup/profile/$(basename "$f") still has example content — skipping."
    continue
  fi
  BASENAME="$(basename "$f")"
  SECTION="$(basename "$f" .md)"
  CONTENT="$(cat "$f")"
  CHAR_COUNT="${#CONTENT}"
  PROFILE_TEXT="${PROFILE_TEXT}

## ${SECTION}

${CONTENT}"
  PROFILE_COUNT=$((PROFILE_COUNT + 1))
  PROFILE_CHARS=$((PROFILE_CHARS + CHAR_COUNT))
  PROFILE_FILES="$PROFILE_FILES setup/profile/$BASENAME($CHAR_COUNT chars)"
  ok "setup/profile/$BASENAME   ($CHAR_COUNT characters)"
done

if [ "$PROFILE_COUNT" -eq 0 ]; then
  warn "No .md files found in setup/profile/. The bot will deploy but will have nothing to answer from."
  warn "Add at least setup/profile/about.md and setup/profile/contact.md, then run this script again."
fi

info "Profile total: $PROFILE_COUNT file(s), $PROFILE_CHARS characters."


# ════════════════════════════════════════════════════════════════════════════
step "3 of 7   Cloudflare authentication"
# ════════════════════════════════════════════════════════════════════════════

cd "$WORKER_DIR"

WHOAMI_OUTPUT="$("$WRANGLER" whoami 2>&1 || true)"

if echo "$WHOAMI_OUTPUT" | grep -qi "not authenticated\|You are not logged in\|No config found\|must be logged in"; then
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
step "4 of 7   Secrets"
# ════════════════════════════════════════════════════════════════════════════

info "Checking Cloudflare secrets..."
SECRET_LIST="$("$WRANGLER" secret list 2>/dev/null || echo '')"

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

CONFIG_TOKEN="$(python3 -c "
import json
try:
    with open('$CONFIG_FILE') as f:
        c = json.load(f)
    print(c.get('deployment', {}).get('widgetToken', ''))
except Exception:
    print('')
" 2>/dev/null || echo '')"

if [ "$HAS_WIDGET_TOKEN" -eq 1 ] && [ -n "$CONFIG_TOKEN" ]; then
  ok "WIDGET_TOKEN is set."
elif [ "$HAS_WIDGET_TOKEN" -eq 1 ] && [ -z "$CONFIG_TOKEN" ]; then
  info "WIDGET_TOKEN is set in Cloudflare but missing from setup/config.json. Rotating..."
  NEW_TOKEN="$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")"
  printf '%s' "$NEW_TOKEN" | "$WRANGLER" secret put WIDGET_TOKEN 2>&1 | grep -v "^$" | sed 's/^/           /'
  NEW_TOKEN="$NEW_TOKEN" python3 -c "
import json, os
with open('$CONFIG_FILE') as f:
    c = json.load(f)
c.setdefault('deployment', {})['widgetToken'] = os.environ['NEW_TOKEN']
with open('$CONFIG_FILE', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "WIDGET_TOKEN rotated and saved to setup/config.json." || warn "Could not save WIDGET_TOKEN to config.json."
elif [ -n "$CONFIG_TOKEN" ]; then
  info "Restoring WIDGET_TOKEN from setup/config.json..."
  printf '%s' "$CONFIG_TOKEN" | "$WRANGLER" secret put WIDGET_TOKEN 2>&1 | grep -v "^$" | sed 's/^/           /'
  ok "WIDGET_TOKEN restored."
else
  info "Generating WIDGET_TOKEN..."
  NEW_TOKEN="$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")"
  printf '%s' "$NEW_TOKEN" | "$WRANGLER" secret put WIDGET_TOKEN 2>&1 | grep -v "^$" | sed 's/^/           /'
  NEW_TOKEN="$NEW_TOKEN" python3 -c "
import json, os
with open('$CONFIG_FILE') as f:
    c = json.load(f)
c.setdefault('deployment', {})['widgetToken'] = os.environ['NEW_TOKEN']
with open('$CONFIG_FILE', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "WIDGET_TOKEN generated and saved to setup/config.json." || warn "WIDGET_TOKEN generated but could not save to config.json."
fi

if [ "$MISSING_SECRETS" -eq 1 ]; then
  fail "Set the missing secrets above, then run this script again."
fi


# ════════════════════════════════════════════════════════════════════════════
step "5 of 7   Uploading profile and config"
# ════════════════════════════════════════════════════════════════════════════

BOT_CONFIG="$(cat "$CONFIG_FILE")"

info "Uploading config to Cloudflare..."
printf '%s' "$BOT_CONFIG" | "$WRANGLER" secret put BOT_CONFIG_JSON 2>&1 | grep -v "^$" | sed 's/^/           /' || true
ok "Config uploaded."

info "Uploading profile text to Cloudflare..."
if [ -z "$PROFILE_TEXT" ]; then
  warn "No profile content to upload."
else
  CHUNK_SIZE=4000
  PROFILE_LEN=${#PROFILE_TEXT}
  CHUNK_NUM=0
  CHUNK_OFFSET=0
  while [ "$CHUNK_OFFSET" -lt "$PROFILE_LEN" ]; do
    CHUNK_NUM=$((CHUNK_NUM + 1))
    CHUNK="${PROFILE_TEXT:$CHUNK_OFFSET:$CHUNK_SIZE}"
    UPLOAD_OUT="$(printf '%s' "$CHUNK" | "$WRANGLER" secret put "PROFILE_TEXT_$CHUNK_NUM" 2>&1)"
    echo "$UPLOAD_OUT" | grep -v "^$" | sed 's/^/           /'
    if echo "$UPLOAD_OUT" | grep -q "\[ERROR\]"; then
      fail "Failed to upload profile chunk $CHUNK_NUM. See output above."
    fi
    CHUNK_OFFSET=$((CHUNK_OFFSET + CHUNK_SIZE))
  done
  ok "Profile uploaded ($CHUNK_NUM chunk(s), $PROFILE_CHARS characters)."

  # Delete any leftover chunks from a previous larger profile.
  # Without this, shrinking a profile leaves old secrets that get appended to the prompt.
  for _i in $(seq $(( CHUNK_NUM + 1 )) 10); do
    if echo "$SECRET_LIST" | grep -q "PROFILE_TEXT_$_i"; then
      printf 'y\n' | "$WRANGLER" secret delete "PROFILE_TEXT_$_i" 2>&1 | grep -v "^$" | sed 's/^/           /' || true
      ok "Removed stale profile chunk PROFILE_TEXT_$_i"
    fi
  done
fi


# ════════════════════════════════════════════════════════════════════════════
step "6 of 7   Deploying chat worker"
# ════════════════════════════════════════════════════════════════════════════

info "Running wrangler deploy..."
DEPLOY_OUTPUT="$("$WRANGLER" deploy 2>&1)"
echo "$DEPLOY_OUTPUT" | grep -v "^$" | sed 's/^/           /'

if echo "$DEPLOY_OUTPUT" | grep -qi "\[ERROR\]\|Error:"; then
  fail "Chat worker deployment failed. See output above."
fi

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
ok "Chat worker deployed: ${WORKER_URL:-see output above}"


# ════════════════════════════════════════════════════════════════════════════
step "7 of 7   Deploying widget"
# ════════════════════════════════════════════════════════════════════════════

# Derive the account subdomain from the chat worker URL so we can predict the widget URL.
# e.g. from https://gil-bot.gilsway.workers.dev -> gilsway
CF_ACCOUNT_SUBDOMAIN="$(echo "${WORKER_URL:-}" | sed 's|https://[^.]*\.\([^.]*\)\.workers\.dev.*|\1|')"
if [ -z "$CF_ACCOUNT_SUBDOMAIN" ]; then
  CF_ACCOUNT_SUBDOMAIN="$(python3 -c "
import json
try:
    c = json.load(open('$CONFIG_FILE'))
    url = c.get('deployment',{}).get('workerUrl','')
    parts = url.replace('https://','').split('.')
    print(parts[1] if len(parts) > 2 else '')
except Exception:
    print('')
" 2>/dev/null || echo '')"
fi

WIDGET_WORKER_NAME="$(grep '^name' "$WIDGET_WORKER_DIR/wrangler.toml" | head -1 | sed 's/name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/' | tr -d ' ')"
[ -z "$WIDGET_WORKER_NAME" ] && WIDGET_WORKER_NAME="portfolio-chatbot-widget"

WIDGET_URL_EXPECTED=""
if [ -n "$CF_ACCOUNT_SUBDOMAIN" ]; then
  WIDGET_URL_EXPECTED="https://${WIDGET_WORKER_NAME}.${CF_ACCOUNT_SUBDOMAIN}.workers.dev"
fi

# Read config values needed to generate a working widget/index.html
WIDGET_BOT_NAME="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('botName','Assistant'))" 2>/dev/null || echo 'Assistant')"
WIDGET_ACCENT="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('ui',{}).get('accentColor','#0055ff'))" 2>/dev/null || echo '#0055ff')"
WIDGET_WELCOME="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('ui',{}).get('welcomeMessage','Hi! Ask me anything.'))" 2>/dev/null || echo 'Hi! Ask me anything.')"
WIDGET_TOKEN_CFG="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('deployment',{}).get('widgetToken',''))" 2>/dev/null || echo '')"
WIDGET_CHAT_URL="${WORKER_URL:-$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('deployment',{}).get('workerUrl',''))" 2>/dev/null || echo '')}"

export WIDGET_BOT_NAME WIDGET_ACCENT WIDGET_WELCOME WIDGET_TOKEN_CFG WIDGET_CHAT_URL

# Generate production widget/index.html with real URLs baked in.
# widget/dev.html is the development version (uses localhost) — not touched here.
info "Generating production widget/index.html..."
python3 - <<'PYEOF'
import os

root       = os.environ['ROOT']
bot_name   = os.environ.get('WIDGET_BOT_NAME', 'Assistant')
accent     = os.environ.get('WIDGET_ACCENT', '#0055ff')
welcome    = os.environ.get('WIDGET_WELCOME', 'Hi! Ask me anything.')
token      = os.environ.get('WIDGET_TOKEN_CFG', '')
worker_url = os.environ.get('WIDGET_CHAT_URL', '')

token_attr  = f'\n  data-token="{token}"'   if token      else ''
worker_attr = f'\n  data-worker="{worker_url}"' if worker_url else ''

html = f"""<!DOCTYPE html>
<!-- Generated by scripts/build-and-deploy.sh. Do not edit manually. -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{bot_name}</title>
  <style>html,body{{margin:0;padding:0;height:100%;background:#f8f8f8}}</style>
</head>
<body>
<script
  src="./widget.js"
  data-name="{bot_name}"
  data-accent="{accent}"
  data-welcome="{welcome}"{worker_attr}{token_attr}
  defer
></script>
</body>
</html>
"""

with open(f'{root}/widget/index.html', 'w') as f:
    f.write(html)
PYEOF
ok "widget/index.html generated."

# Deploy widget as Cloudflare Workers Static Assets.
# This updates <widget-worker-name>.<account>.workers.dev to serve:
#   /            the standalone chat page
#   /widget.js   the embeddable script for any website
info "Deploying widget worker (this serves the standalone chat page and widget.js)..."
WIDGET_DEPLOY_OUTPUT=""
WIDGET_DEPLOY_FAILED=0
for ATTEMPT in 1 2; do
  WIDGET_DEPLOY_OUTPUT="$("$WRANGLER" deploy --config "$WIDGET_WORKER_DIR/wrangler.toml" 2>&1)"
  if echo "$WIDGET_DEPLOY_OUTPUT" | grep -qi "\[ERROR\]\|Error:"; then
    if [ "$ATTEMPT" -eq 1 ]; then
      warn "Widget deploy attempt 1 failed. Retrying..."
      sleep 3
    else
      WIDGET_DEPLOY_FAILED=1
    fi
  else
    break
  fi
done

echo "$WIDGET_DEPLOY_OUTPUT" | grep -v "^$" | sed 's/^/           /'

WIDGET_URL=""
if [ "$WIDGET_DEPLOY_FAILED" -eq 0 ]; then
  WIDGET_URL="$(echo "$WIDGET_DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || echo '')"
  [ -z "$WIDGET_URL" ] && WIDGET_URL="${WIDGET_URL_EXPECTED:-}"
  if [ -n "$WIDGET_URL" ]; then
    ok "Widget deployed at: $WIDGET_URL"
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    c = json.load(f)
c.setdefault('deployment', {})['widgetUrl'] = '$WIDGET_URL'
with open('$CONFIG_FILE', 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
" 2>/dev/null && ok "Widget URL saved to setup/config.json." || true
  fi
else
  warn "Widget deployment failed after 2 attempts. The chat worker is still live."
  warn "To retry manually: cd worker && npx wrangler deploy --config ../widget-worker/wrangler.toml"
  WIDGET_URL="${WIDGET_URL_EXPECTED:-}"
fi

# Add the widget URL to security.allowedOrigins so the worker enforces origin checking.
# User-specified sites are already in config.json; this appends the Cloudflare URL.
if [ -n "$WIDGET_URL" ]; then
  WIDGET_URL="$WIDGET_URL" python3 -c "
import json, os
with open('$CONFIG_FILE') as f:
    c = json.load(f)
widget_url = os.environ['WIDGET_URL']
origins = c.setdefault('security', {}).setdefault('allowedOrigins', [])
if widget_url not in origins:
    origins.append(widget_url)
    with open('$CONFIG_FILE', 'w') as f:
        json.dump(c, f, indent=2)
        f.write('\n')
    print('  ok       ' + widget_url + ' added to allowedOrigins.')
else:
    print('  ok       allowedOrigins already includes the widget URL.')
for o in origins:
    print('  ok         allowed: ' + o)
" 2>/dev/null || warn "Could not update allowedOrigins in config.json."

  info "Re-uploading config with updated allowedOrigins..."
  BOT_CONFIG_UPDATED="$(cat "$CONFIG_FILE")"
  printf '%s' "$BOT_CONFIG_UPDATED" | "$WRANGLER" secret put BOT_CONFIG_JSON 2>&1 | grep -v "^$" | sed 's/^/           /' || true
  ok "Config re-uploaded. Origin enforcement is now active."
fi


# ════════════════════════════════════════════════════════════════════════════
# Final output — generate setup/embed.html and print summary
# ════════════════════════════════════════════════════════════════════════════

FINAL_WORKER_URL="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('deployment',{}).get('workerUrl',''))" 2>/dev/null || echo "${WORKER_URL:-}")"
FINAL_WIDGET_URL="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('deployment',{}).get('widgetUrl',''))" 2>/dev/null || echo "${WIDGET_URL:-}")"
FINAL_TOKEN="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('deployment',{}).get('widgetToken',''))" 2>/dev/null || echo '')"

export FINAL_WORKER_URL FINAL_WIDGET_URL FINAL_TOKEN CONFIG_FILE

python3 - <<'PYEOF'
import os, datetime

root        = os.environ['ROOT']
config_file = os.environ['CONFIG_FILE']
worker_url  = os.environ.get('FINAL_WORKER_URL', '')
widget_url  = os.environ.get('FINAL_WIDGET_URL', '')
token       = os.environ.get('FINAL_TOKEN', '')
widget_js   = f"{widget_url}/widget.js" if widget_url else ''
chat_page   = f"{widget_url}/" if widget_url else ''
generated   = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

token_attr  = f' data-token="{token}"'  if token else ''

script_tag = ''
if widget_js and worker_url:
    script_tag = (
        f'<script src="{widget_js}"\n'
        f'        data-worker="{worker_url}"{token_attr}\n'
        f'        defer></script>'
    )

iframe_tag = ''
if chat_page:
    iframe_tag = (
        f'<iframe src="{chat_page}"\n'
        f'  width="400" height="600"\n'
        f'  style="border:none;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.15);"\n'
        f'></iframe>'
    )

base44_lines = ['import { useEffect } from "react";', '', 'export default function ChatWidget() {', '  useEffect(() => {', '    const s = document.createElement("script");']
if widget_js:
    base44_lines.append(f'    s.src = "{widget_js}";')
if worker_url:
    base44_lines.append(f'    s.dataset.worker = "{worker_url}";')
if token:
    base44_lines.append(f'    s.dataset.token = "{token}";')
base44_lines += ['    s.async = true;', '    document.body.appendChild(s);', '    return () => document.body.removeChild(s);', '  }, []);', '  return null;', '}']
base44_component = '\n'.join(base44_lines)

# Write setup/embed.html
embed_html = f"""<!DOCTYPE html>
<!-- Generated by scripts/build-and-deploy.sh on {generated}. Do not edit manually. -->
<!--                                                                          -->
<!-- SECURITY NOTE: This file contains your WIDGET_TOKEN. It is safe for     -->
<!-- this token to appear in your website's HTML source code (anyone who      -->
<!-- embeds the widget will have it visible). However, do NOT commit this     -->
<!-- file to a public repository, and do not share the token outside of       -->
<!-- embed contexts. If you suspect abuse, re-run the deploy script to rotate -->
<!-- the token automatically.                                                 -->
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Embed Guide</title>
  <style>
    body {{ font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.6; }}
    h1 {{ font-size: 1.4em; margin-bottom: 4px; }}
    .meta {{ color: #888; font-size: 0.9em; margin-bottom: 32px; }}
    h2 {{ font-size: 1em; text-transform: uppercase; letter-spacing: .06em; color: #555; margin-top: 36px; margin-bottom: 8px; }}
    pre {{ background: #f4f4f4; padding: 16px 20px; border-radius: 8px; overflow-x: auto; font-size: 0.88em; line-height: 1.55; white-space: pre; }}
    .warn {{ background: #fff8e6; border-left: 4px solid #f59e0b; padding: 12px 16px; border-radius: 4px; margin: 24px 0; font-size: 0.92em; }}
    .warn strong {{ color: #92400e; }}
    a {{ color: #0055ff; }}
  </style>
</head>
<body>
  <h1>Embed Guide</h1>
  <p class="meta">Generated: {generated}</p>

  <h2>Deployment</h2>
  <pre>Chat worker : {worker_url}
Widget host : {widget_url}
Widget JS   : {widget_js}
Standalone  : {chat_page}</pre>

  <h2>Option 1 — Script tag (recommended for any website)</h2>
  <p>Add before <code>&lt;/body&gt;</code> on any page:</p>
  <pre>{script_tag}</pre>

  <h2>Option 2 — Base44 component</h2>
  <p>Replace your ChatWidget component with:</p>
  <pre>{base44_component}</pre>

  <h2>Option 3 — Standalone page (share or iframe)</h2>
  <p>The standalone chat page can be shared as a direct link, or embedded in a page via iframe:</p>
  <pre>{iframe_tag}</pre>

  <div class="warn">
    <strong>Token security.</strong> The WIDGET_TOKEN (<code>{token}</code>) will be visible
    in your website's HTML source to anyone who views it. This is expected and unavoidable
    for a browser-embedded widget. What the token provides: it prevents unauthorised scripts
    from hammering your API endpoint. What it does NOT provide: it is not a secret that
    protects against a determined person. Do not commit this file to a public repository.
    If you suspect abuse, re-run <code>bash scripts/setup.sh</code> (choose Deploy) to rotate
    the token automatically.
  </div>
</body>
</html>
"""

embed_path = f"{root}/setup/embed.html"
with open(embed_path, 'w') as f:
    f.write(embed_html)

# Print console summary
div = '=' * 56
print('')
print(div)
print('Deployed successfully.')
print('')
if worker_url:
    print(f'  Chat worker : {worker_url}')
if widget_js:
    print(f'  Widget JS   : {widget_js}')
if chat_page:
    print(f'  Standalone  : {chat_page}')
print('')
print('  Full embed instructions saved to: setup/embed.html')
print('  Open it in a browser for copy-paste ready code.')
print('')
print('  To update: edit setup/profile/ files and run this script again.')
print(div)
print('')
PYEOF
