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
export CONFIG_FILE
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
indent() { grep -v "^$" | sed 's/^/           /' || true; }

# Reads a dot-separated key from setup/config.json. Prints DEFAULT when missing.
# The path is passed through the environment, so any folder name works.
cfg_get() {
  KEY="$1" DEFAULT="${2:-}" python3 -c "
import json, os
try:
    v = json.load(open(os.environ['CONFIG_FILE']))
    for part in os.environ['KEY'].split('.'):
        v = v.get(part) if isinstance(v, dict) else None
    print(os.environ['DEFAULT'] if v is None else v)
except Exception:
    print(os.environ['DEFAULT'])
" 2>/dev/null || echo "${2:-}"
}

# Sets a dot-separated key in setup/config.json to a string value.
cfg_set() {
  KEY="$1" VALUE="$2" python3 -c "
import json, os
path = os.environ['CONFIG_FILE']
c = json.load(open(path))
obj = c
parts = os.environ['KEY'].split('.')
for part in parts[:-1]:
    obj = obj.setdefault(part, {})
obj[parts[-1]] = os.environ['VALUE']
with open(path, 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
"
}

# Runs a wrangler command, prints its output, and returns its exit status.
# Output is kept in WRANGLER_OUT. Safe under set -e: a failure is returned, not fatal.
run_wrangler() {
  local status=0
  WRANGLER_OUT="$("$WRANGLER" "$@" 2>&1)" || status=$?
  echo "$WRANGLER_OUT" | indent
  if [ "$status" -eq 0 ] && echo "$WRANGLER_OUT" | grep -q "\[ERROR\]"; then status=1; fi
  return "$status"
}

# Stores stdin as a Cloudflare secret. Stops the script with a clear message on failure.
put_secret() {
  local name="$1" status=0
  WRANGLER_OUT="$("$WRANGLER" secret put "$name" 2>&1)" || status=$?
  echo "$WRANGLER_OUT" | indent
  if [ "$status" -ne 0 ] || echo "$WRANGLER_OUT" | grep -q "\[ERROR\]"; then
    fail "Could not store the $name secret in Cloudflare. See the output above."
  fi
}

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
if ! python3 -c "import json, os; json.load(open(os.environ['CONFIG_FILE']))" 2>/dev/null; then
  fail "setup/config.json is not valid JSON. Fix the syntax error and run this script again."
fi
ok "setup/config.json is valid JSON."

# Warn if config still has obvious placeholder values
OWNER_NAME="$(cfg_get ownerName)"
BOT_NAME_VAL="$(cfg_get botName)"
case "$OWNER_NAME" in
  ""|"the professional"|"Alex Chen"|YOUR_*)
    warn "ownerName in setup/config.json still looks like a placeholder (\"$OWNER_NAME\"). Update it with your real name." ;;
esac
case "$BOT_NAME_VAL" in
  ""|"Assistant"|"Alex's Bot"|YOUR_*)
    warn "botName in setup/config.json still looks like a placeholder (\"$BOT_NAME_VAL\"). Update it." ;;
esac
# Example contact details and origins from setup/examples/config.json.
python3 -c "
import json, os
c = json.load(open(os.environ['CONFIG_FILE']))
values = [str(v) for k, v in (c.get('contactMethods') or {}).items() if not k.startswith('_') and isinstance(v, (str, int))]
values += [str(v) for v in ((c.get('security') or {}).get('allowedOrigins') or [])]
for v in values:
    if any(p in v.lower() for p in ('example.com', 'your-website', 'yourdomain', 'yourhandle', 'yourname')):
        print('  warn     setup/config.json still has the example value \"' + v + '\". Replace or remove it.')
" 2>/dev/null || true

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

CONFIG_TOKEN="$(cfg_get deployment.widgetToken)"

save_token() {
  if cfg_set deployment.widgetToken "$1" 2>/dev/null; then
    ok "WIDGET_TOKEN saved to setup/config.json."
  else
    warn "Could not save WIDGET_TOKEN to setup/config.json."
  fi
}

if [ "$HAS_WIDGET_TOKEN" -eq 1 ] && [ -n "$CONFIG_TOKEN" ]; then
  ok "WIDGET_TOKEN is set."
elif [ "$HAS_WIDGET_TOKEN" -eq 1 ]; then
  # A token exists in Cloudflare (for example set by hand with wrangler secret put),
  # but this machine does not know its value. Cloudflare cannot show it back, so ask.
  # Replacing it silently would break every website that already uses it.
  echo ""
  echo "  WIDGET_TOKEN is set in Cloudflare, but setup/config.json does not have its value."
  echo "  Paste the token you set, so the generated pages can use it."
  echo "  Press Enter to create a new token instead. Websites that use the old token"
  echo "  will then need the new one."
  echo ""
  TOKEN_INPUT=""
  if [ -t 0 ]; then
    printf "  Token (input will not echo): "
    IFS= read -rs TOKEN_INPUT || TOKEN_INPUT=""
    echo ""
  fi
  if [ -n "$TOKEN_INPUT" ]; then
    printf '%s' "$TOKEN_INPUT" | put_secret WIDGET_TOKEN
    save_token "$TOKEN_INPUT"
  else
    info "Creating a new WIDGET_TOKEN..."
    NEW_TOKEN="$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")"
    printf '%s' "$NEW_TOKEN" | put_secret WIDGET_TOKEN
    save_token "$NEW_TOKEN"
    warn "WIDGET_TOKEN was replaced. Update data-token on any website that embeds the widget."
  fi
elif [ -n "$CONFIG_TOKEN" ]; then
  info "Restoring WIDGET_TOKEN from setup/config.json..."
  printf '%s' "$CONFIG_TOKEN" | put_secret WIDGET_TOKEN
  ok "WIDGET_TOKEN restored."
else
  info "Generating WIDGET_TOKEN..."
  NEW_TOKEN="$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")"
  printf '%s' "$NEW_TOKEN" | put_secret WIDGET_TOKEN
  save_token "$NEW_TOKEN"
fi

if [ "$MISSING_SECRETS" -eq 1 ]; then
  fail "Set the missing secrets above, then run this script again."
fi


# ════════════════════════════════════════════════════════════════════════════
step "5 of 7   Uploading profile and config"
# ════════════════════════════════════════════════════════════════════════════

info "Uploading config to Cloudflare..."
put_secret BOT_CONFIG_JSON < "$CONFIG_FILE"
ok "Config uploaded."

# Cloudflare limits each secret to 5 KB. The limit counts bytes, and non-English
# text or emoji take 2 to 4 bytes per character, so split by bytes, never inside
# a character. The worker reads PROFILE_TEXT_1, PROFILE_TEXT_2, ... until one is missing.
CHUNK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHUNK_DIR"' EXIT
export CHUNK_DIR
printf '%s' "$PROFILE_TEXT" | python3 -c "
import os, sys
data = sys.stdin.buffer.read().decode('utf-8')
limit, chunks, current, size = 4000, [], [], 0
for ch in data:
    n = len(ch.encode('utf-8'))
    if size + n > limit:
        chunks.append(''.join(current)); current, size = [], 0
    current.append(ch); size += n
if current:
    chunks.append(''.join(current))
for i, chunk in enumerate(chunks, 1):
    with open(os.path.join(os.environ['CHUNK_DIR'], str(i)), 'w', encoding='utf-8') as f:
        f.write(chunk)
print(len(chunks))
" > "$CHUNK_DIR/count"
CHUNK_NUM="$(cat "$CHUNK_DIR/count")"

if [ "$CHUNK_NUM" -eq 0 ]; then
  warn "No profile content to upload. Any old profile in Cloudflare is removed below,"
  warn "so the bot will say its profile is being set up."
else
  info "Uploading profile text to Cloudflare..."
  for _i in $(seq 1 "$CHUNK_NUM"); do
    put_secret "PROFILE_TEXT_$_i" < "$CHUNK_DIR/$_i"
  done
  ok "Profile uploaded ($CHUNK_NUM piece(s), $PROFILE_CHARS characters)."
fi

# Delete leftover pieces from an earlier, larger profile (and the old single-secret
# PROFILE_TEXT). Without this, shrinking or emptying the profile leaves old text live.
for _name in $(echo "$SECRET_LIST" | grep -oE 'PROFILE_TEXT(_[0-9]+)?' | sort -u); do
  _n="${_name#PROFILE_TEXT_}"
  if [ "$_name" = "PROFILE_TEXT" ] || [ "$_n" -gt "$CHUNK_NUM" ]; then
    if run_wrangler secret delete "$_name" <<< "y"; then
      ok "Removed old profile piece $_name"
    else
      warn "Could not remove $_name. Remove it with: cd worker && npx wrangler secret delete $_name"
    fi
  fi
done


# ════════════════════════════════════════════════════════════════════════════
step "6 of 7   Deploying chat worker"
# ════════════════════════════════════════════════════════════════════════════

info "Running wrangler deploy..."
if ! run_wrangler deploy; then
  fail "Chat worker deployment failed. See output above."
fi
DEPLOY_OUTPUT="$WRANGLER_OUT"

WORKER_URL="$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || echo '')"

if [ -n "$WORKER_URL" ]; then
  cfg_set deployment.workerUrl "$WORKER_URL" 2>/dev/null && ok "Worker URL saved to setup/config.json." || true
fi
ok "Chat worker deployed: ${WORKER_URL:-see output above}"


# ════════════════════════════════════════════════════════════════════════════
step "7 of 7   Deploying widget"
# ════════════════════════════════════════════════════════════════════════════

[ -n "$WORKER_URL" ] || WORKER_URL="$(cfg_get deployment.workerUrl)"

# Derive the account subdomain from the chat worker URL so we can predict the widget URL.
# e.g. from https://portfolio-chatbot-worker.your-account.workers.dev -> your-account
CF_ACCOUNT_SUBDOMAIN="$(echo "${WORKER_URL:-}" | sed -n 's|https://[^.]*\.\([^.]*\)\.workers\.dev.*|\1|p')"

WIDGET_WORKER_NAME="$(grep '^name' "$WIDGET_WORKER_DIR/wrangler.toml" | head -1 | sed 's/name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/' | tr -d ' ')"
[ -z "$WIDGET_WORKER_NAME" ] && WIDGET_WORKER_NAME="portfolio-chatbot-widget"

WIDGET_URL_EXPECTED=""
if [ -n "$CF_ACCOUNT_SUBDOMAIN" ]; then
  WIDGET_URL_EXPECTED="https://${WIDGET_WORKER_NAME}.${CF_ACCOUNT_SUBDOMAIN}.workers.dev"
fi

# Read config values needed to generate a working widget/index.html
WIDGET_BOT_NAME="$(cfg_get botName Assistant)"
WIDGET_ACCENT="$(cfg_get ui.accentColor '#0055ff')"
WIDGET_WELCOME="$(cfg_get ui.welcomeMessage 'Hi! Ask me anything.')"
WIDGET_TOKEN_CFG="$(cfg_get deployment.widgetToken)"
WIDGET_CHAT_URL="${WORKER_URL:-}"

export WIDGET_BOT_NAME WIDGET_ACCENT WIDGET_WELCOME WIDGET_TOKEN_CFG WIDGET_CHAT_URL

# Generate production widget/index.html with real URLs baked in.
# widget/dev.html is the development version (uses localhost) — not touched here.
info "Generating production widget/index.html..."
python3 - <<'PYEOF'
import os
from html import escape

def attr(name):
    return escape(os.environ.get(name, ''), quote=True)

root       = os.environ['ROOT']
bot_name   = attr('WIDGET_BOT_NAME') or 'Assistant'
accent     = attr('WIDGET_ACCENT') or '#0055ff'
welcome    = attr('WIDGET_WELCOME') or 'Hi! Ask me anything.'
token      = attr('WIDGET_TOKEN_CFG')
worker_url = attr('WIDGET_CHAT_URL')

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

with open(os.path.join(root, 'widget', 'index.html'), 'w') as f:
    f.write(html)
PYEOF
ok "widget/index.html generated."

# Deploy widget as Cloudflare Workers Static Assets.
# This updates <widget-worker-name>.<account>.workers.dev to serve:
#   /            the standalone chat page
#   /widget.js   the embeddable script for any website
info "Deploying widget worker (this serves the standalone chat page and widget.js)..."
WIDGET_DEPLOY_FAILED=1
for ATTEMPT in 1 2; do
  if run_wrangler deploy --config "$WIDGET_WORKER_DIR/wrangler.toml"; then
    WIDGET_DEPLOY_FAILED=0
    break
  fi
  if [ "$ATTEMPT" -eq 1 ]; then
    warn "Widget deploy attempt 1 failed. Retrying..."
    sleep 3
  fi
done
WIDGET_DEPLOY_OUTPUT="$WRANGLER_OUT"

WIDGET_URL=""
if [ "$WIDGET_DEPLOY_FAILED" -eq 0 ]; then
  WIDGET_URL="$(echo "$WIDGET_DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1 || echo '')"
  [ -z "$WIDGET_URL" ] && WIDGET_URL="${WIDGET_URL_EXPECTED:-}"
  if [ -n "$WIDGET_URL" ]; then
    ok "Widget deployed at: $WIDGET_URL"
    cfg_set deployment.widgetUrl "$WIDGET_URL" 2>/dev/null && ok "Widget URL saved to setup/config.json." || true
  fi
else
  warn "Widget deployment failed after 2 attempts. The chat worker is still live."
  warn "To retry manually: cd worker && npx wrangler deploy --config ../widget-worker/wrangler.toml"
  WIDGET_URL="${WIDGET_URL_EXPECTED:-}"
fi

# If you listed your own sites in security.allowedOrigins, origin checks are on,
# so the widget's standalone page must be on the list too. If the list is empty,
# every site is allowed: leave it empty rather than switch checks on for one URL.
if [ -n "$WIDGET_URL" ]; then
  export WIDGET_URL
  ORIGINS_RESULT="$(python3 -c "
import json, os
path = os.environ['CONFIG_FILE']
c = json.load(open(path))
widget_url = os.environ['WIDGET_URL'].rstrip('/').lower()
origins = (c.get('security') or {}).get('allowedOrigins') or []
if not origins:
    print('empty')
elif widget_url in [str(o).rstrip('/').lower() for o in origins]:
    print('present')
else:
    origins.append(widget_url)
    c.setdefault('security', {})['allowedOrigins'] = origins
    with open(path, 'w') as f:
        json.dump(c, f, indent=2)
        f.write('\n')
    print('added')
" 2>/dev/null || echo 'error')"

  case "$ORIGINS_RESULT" in
    empty)
      warn "security.allowedOrigins is empty, so any website can use your bot."
      warn "Add your website address to it in setup/config.json before going live." ;;
    present)
      ok "allowedOrigins already includes the widget URL." ;;
    added)
      ok "$WIDGET_URL added to allowedOrigins."
      info "Re-uploading config with updated allowedOrigins..."
      put_secret BOT_CONFIG_JSON < "$CONFIG_FILE"
      ok "Config re-uploaded." ;;
    *)
      warn "Could not update allowedOrigins in setup/config.json." ;;
  esac
fi


# ════════════════════════════════════════════════════════════════════════════
# Final output — generate setup/embed.html and print summary
# ════════════════════════════════════════════════════════════════════════════

FINAL_WORKER_URL="$(cfg_get deployment.workerUrl "${WORKER_URL:-}")"
FINAL_WIDGET_URL="$(cfg_get deployment.widgetUrl "${WIDGET_URL:-}")"
FINAL_TOKEN="$(cfg_get deployment.widgetToken)"

export FINAL_WORKER_URL FINAL_WIDGET_URL FINAL_TOKEN CONFIG_FILE

python3 - <<'PYEOF'
import os, datetime
from html import escape

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
<!-- embed contexts. To replace the token, remove deployment.widgetToken from -->
<!-- setup/config.json, run the deploy script, and press Enter when asked.    -->
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
  <pre>Chat worker : {escape(worker_url)}
Widget host : {escape(widget_url)}
Widget JS   : {escape(widget_js)}
Standalone  : {escape(chat_page)}</pre>

  <h2>Option 1 — Script tag (recommended for any website)</h2>
  <p>Add before <code>&lt;/body&gt;</code> on any page:</p>
  <pre>{escape(script_tag)}</pre>

  <h2>Option 2 — Base44 component</h2>
  <p>Replace your ChatWidget component with:</p>
  <pre>{escape(base44_component)}</pre>

  <h2>Option 3 — Standalone page (share or iframe)</h2>
  <p>The standalone chat page can be shared as a direct link, or embedded in a page via iframe:</p>
  <pre>{escape(iframe_tag)}</pre>

  <div class="warn">
    <strong>Token security.</strong> The WIDGET_TOKEN (<code>{escape(token)}</code>) will be visible
    in your website's HTML source to anyone who views it. This is expected and unavoidable
    for a browser-embedded widget. What the token provides: it prevents unauthorised scripts
    from hammering your API endpoint. What it does NOT provide: it is not a secret that
    protects against a determined person. Do not commit this file to a public repository.
    To replace the token, remove <code>deployment.widgetToken</code> from <code>setup/config.json</code>,
    run <code>bash scripts/build-and-deploy.sh</code>, and press Enter when it asks for the token.
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
