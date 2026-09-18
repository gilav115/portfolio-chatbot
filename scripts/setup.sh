#!/usr/bin/env bash
# Interactive setup wizard for portfolio-chatbot.
#
# Reads your current setup/config.json (if any) and guides you through
# every setting. Press Enter to keep the current value.
# Saves everything to setup/config.json when finished.
#
# Run from anywhere inside the project:
#   bash scripts/setup.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_DIR="$ROOT/setup"
export CONFIG_FILE="$SETUP_DIR/config.json"
WORKER_DIR="$ROOT/worker"
EXAMPLES_DIR="$SETUP_DIR/examples"
PROFILE_DIR="$SETUP_DIR/profile"

ok()   { echo "  ok       $*"; }
info() { echo "  info     $*"; }
warn() { echo "  warn     $*"; }
fail() { echo ""; echo "  ERROR    $*"; echo ""; exit 1; }

step() {
  echo ""
  printf '=%.0s' $(seq 1 64); echo ""
  echo "  $*"
  printf '=%.0s' $(seq 1 64); echo ""
  echo ""
}

# Read a dot-notation key from config.json. Returns DEFAULT if missing.
cfg() {
  local KEY="$1" DEFAULT="${2:-}"
  python3 -c "
import json, os
try:
    with open(os.environ['CONFIG_FILE']) as f:
        c = json.load(f)
    parts = '$KEY'.split('.')
    v = c
    for p in parts:
        v = v.get(p) if isinstance(v, dict) else None
        if v is None:
            break
    if isinstance(v, list):
        print(','.join(str(x) for x in v if x))
    elif v is not None:
        print(str(v) if not isinstance(v, bool) else str(v).lower())
    else:
        print('$DEFAULT')
except Exception:
    print('$DEFAULT')
" 2>/dev/null || echo "$DEFAULT"
}

# Prompt the user. Shows current config value in brackets.
# Result goes into global _ANSWER.
ask() {
  local LABEL="$1" KEY="${2:-}" DEFAULT="${3:-}"
  local CURRENT=""
  if [ -n "$KEY" ] && [ -f "$CONFIG_FILE" ]; then
    CURRENT="$(cfg "$KEY" "$DEFAULT")"
  fi
  [ -z "$CURRENT" ] || [ "$CURRENT" = "None" ] && CURRENT="$DEFAULT" || true
  # Clear obvious placeholder values from example config
  case "$CURRENT" in
    YOUR_*|*example.com*|*your-website*|*your-name*|*yourhandle*|*yourname*|*yourdomain*)
      CURRENT="" ;;
  esac
  if [ -n "$CURRENT" ]; then
    printf "  %s [%s]: " "$LABEL" "$CURRENT"
  else
    printf "  %s: " "$LABEL"
  fi
  IFS= read -r _ANSWER </dev/tty || _ANSWER=""
  [ -z "$_ANSWER" ] && _ANSWER="$CURRENT" || true
}

# Yes/no prompt. Returns 0 for yes, 1 for no.
confirm() {
  local PROMPT="${1:-Continue?}" DEFAULT="${2:-y}"
  local HINT
  [ "$DEFAULT" = "y" ] && HINT="Y/n" || HINT="y/N"
  printf "\n  %s [%s]: " "$PROMPT" "$HINT"
  IFS= read -r _ANSWER </dev/tty || _ANSWER=""
  [ -z "$_ANSWER" ] && _ANSWER="$DEFAULT" || true
  [[ "$_ANSWER" =~ ^[Yy] ]]
}


echo ""
echo "portfolio-chatbot"
echo "================="
echo ""

# Prerequisites
if ! command -v python3 &>/dev/null; then
  fail "python3 is required but not found. Install it and run this script again."
fi
if ! command -v node &>/dev/null; then
  fail "Node.js is not installed. Install it from nodejs.org (version 18 or newer)."
fi
NODE_VERSION="$(node --version 2>/dev/null || echo 'v0')"
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if [ "${NODE_MAJOR:-0}" -lt 18 ] 2>/dev/null; then
  fail "Node.js 18 or newer is required (you have $NODE_VERSION). Install from nodejs.org."
fi

# Create config.json from example if missing
if [ ! -f "$CONFIG_FILE" ]; then
  cp "$EXAMPLES_DIR/config.json" "$CONFIG_FILE"
  info "Created setup/config.json from the example."
fi

echo "  What would you like to do?"
echo ""
echo "    1) Configure  — run the setup wizard"
echo "    2) Deploy     — build and deploy to Cloudflare"
echo ""
printf "  Choice [1]: "
IFS= read -r _MODE </dev/tty || _MODE=""
[ -z "$_MODE" ] && _MODE="1"

if [[ "$_MODE" == "2" ]]; then
  exec bash "$ROOT/scripts/build-and-deploy.sh"
fi

echo ""
echo "  This wizard saves all your settings to setup/config.json."
echo "  Press Enter to keep the value shown in [brackets]."
echo ""


step "1 of 7   Identity"

ask "Bot name" "botName" "Assistant"
BOT_NAME="$_ANSWER"

ask "Your name" "ownerName" ""
OWNER_NAME="$_ANSWER"

echo ""
echo "  Tone options: professional, casual, direct, warm, technical, formal, founder"
ask "Tone" "tone" "professional"
TONE="$_ANSWER"

echo ""
echo "  Response style options:"
echo "    minimal     plain prose, max 2 sentences, no lists or formatting of any kind"
echo "    prose       short flowing sentences, no lists"
echo "    structured  numbered lists allowed for 3+ items, prose otherwise"
ask "Response style" "responseStyle" "prose"
RESPONSE_STYLE="$_ANSWER"


step "2 of 7   Contact methods"

echo "  Only the fields you fill in appear as buttons in the widget."
echo "  Leave blank to skip."
echo ""

ask "Email" "contactMethods.email" ""
CONTACT_EMAIL="$_ANSWER"

ask "LinkedIn URL (full URL)" "contactMethods.linkedin" ""
CONTACT_LINKEDIN="$_ANSWER"

ask "WhatsApp (country code + digits, e.g. 447000000000)" "contactMethods.whatsapp" ""
CONTACT_WHATSAPP="$_ANSWER"

ask "SMS (same format as WhatsApp)" "contactMethods.sms" ""
CONTACT_SMS="$_ANSWER"

ask "Calendar booking URL" "contactMethods.calendar" ""
CONTACT_CALENDAR="$_ANSWER"

ask "GitHub URL (full URL)" "contactMethods.github" ""
CONTACT_GITHUB="$_ANSWER"


step "3 of 7   Security"

echo "  Website URL(s) where the bot will be embedded (comma-separated)."
echo "  Include both www and non-www if your site uses both."
echo "  Example: https://example.com,https://www.example.com"
echo "  The Cloudflare standalone page is added automatically - no need to list it here."
echo "  Leave blank to allow requests from ANY origin (not recommended for production)."
echo ""

ask "Allowed origins" "security.allowedOrigins" ""
ALLOWED_ORIGINS="$_ANSWER"


step "4 of 7   AI provider"

echo "  openai     uses gpt-4o-mini (cheap, fast, default)"
echo "  anthropic  uses claude-haiku-4-5-20251001"
echo ""

ask "Provider (openai / anthropic)" "llm.provider" "openai"
LLM_PROVIDER="$_ANSWER"

echo ""
echo "  Leave blank to use the provider default."
ask "Model override (optional)" "llm.model" ""
LLM_MODEL="$_ANSWER"


step "5 of 7   Widget appearance"

echo "  These can also be set as data attributes in the script tag on your site."
echo ""

ask "Accent colour (hex, e.g. #0055ff)" "ui.accentColor" "#0055ff"
UI_ACCENT="$_ANSWER"

ask "Welcome message" "ui.welcomeMessage" "Hi! Ask me anything."
UI_WELCOME="$_ANSWER"


step "6 of 7   Deployment info"

CURRENT_WORKER_URL="$(cfg 'deployment.workerUrl' '')"
if [ -n "$CURRENT_WORKER_URL" ]; then
  ok "Worker URL: $CURRENT_WORKER_URL"
else
  info "Worker URL: will be set automatically when you run build-and-deploy.sh."
fi
WORKER_URL_VAL=""

echo ""
echo "  Widget JS URL: where widget.js is hosted (e.g. on Cloudflare Pages)."
echo "  Leave blank until you have hosted it. See README Step 7."
echo ""

ask "Widget JS URL (where widget.js is hosted)" "deployment.widgetUrl" ""
WIDGET_URL_VAL="$_ANSWER"


step "7 of 7   Cloudflare auth and secrets"

cd "$WORKER_DIR"

info "Checking Cloudflare authentication..."
WHOAMI_OUTPUT="$(npx wrangler whoami 2>&1 || true)"

CF_AUTHED=1
if echo "$WHOAMI_OUTPUT" | grep -qi "not authenticated\|not logged in\|no config\|must be logged in"; then
  CF_AUTHED=0
  echo ""
  echo "  You are not logged in to Cloudflare."
  echo ""
  echo "  Run this once to connect, then run the wizard again:"
  echo "    cd worker && npx wrangler login"
  echo ""
  echo "  A browser tab will open. Log in and click Authorize."
  echo ""
else
  CF_EMAIL="$(echo "$WHOAMI_OUTPUT" | grep -oE "[a-zA-Z0-9._%+]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}" | head -1 || echo '')"
  ok "Authenticated as: ${CF_EMAIL:-your Cloudflare account}"
fi

WIDGET_TOKEN_VAL=""

if [ "$CF_AUTHED" -eq 1 ]; then
  echo ""
  info "Checking secrets..."
  SECRET_LIST="$(npx wrangler secret list 2>/dev/null || echo '')"

  if echo "$SECRET_LIST" | grep -q "LLM_API_KEY"; then
    ok "LLM_API_KEY is already set."
  else
    echo ""
    echo "  LLM_API_KEY is not set."
    echo "  This is your OpenAI or Anthropic API key. The bot cannot answer"
    echo "  questions without it."
    echo ""
    echo "  Get one from:"
    echo "    OpenAI:    platform.openai.com    -> API keys -> Create new secret key"
    echo "    Anthropic: console.anthropic.com  -> API keys -> Create key"
    echo ""
    if confirm "Do you have an API key ready to paste now?"; then
      printf "  Paste your API key (input will not echo): "
      IFS= read -rs LLM_KEY_INPUT </dev/tty || LLM_KEY_INPUT=""
      echo ""
      if [ -n "$LLM_KEY_INPUT" ]; then
        printf '%s' "$LLM_KEY_INPUT" | npx wrangler secret put LLM_API_KEY 2>&1 | grep -v "^$" | sed 's/^/           /'
        ok "LLM_API_KEY stored."
      else
        warn "No key entered. When ready, run:"
        echo "    cd worker && npx wrangler secret put LLM_API_KEY"
      fi
    else
      echo ""
      echo "  When you have a key, run:"
      echo "    cd worker && npx wrangler secret put LLM_API_KEY"
    fi
    echo ""
  fi

  if echo "$SECRET_LIST" | grep -q "WIDGET_TOKEN"; then
    ok "WIDGET_TOKEN is already set."
    WIDGET_TOKEN_VAL="$(python3 -c "
import json, os
try:
    with open(os.environ['CONFIG_FILE']) as f:
        c = json.load(f)
    print(c.get('deployment', {}).get('widgetToken', ''))
except Exception:
    print('')
" 2>/dev/null || echo '')"
  else
    info "Generating WIDGET_TOKEN..."
    WIDGET_TOKEN_VAL="$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")"
    printf '%s' "$WIDGET_TOKEN_VAL" | npx wrangler secret put WIDGET_TOKEN 2>&1 | grep -v "^$" | sed 's/^/           /'
    ok "WIDGET_TOKEN generated and stored."
  fi
fi


# Write config.json

echo ""
info "Saving setup/config.json..."

export BOT_NAME OWNER_NAME TONE RESPONSE_STYLE
export CONTACT_EMAIL CONTACT_LINKEDIN CONTACT_WHATSAPP CONTACT_SMS CONTACT_CALENDAR CONTACT_GITHUB
export ALLOWED_ORIGINS LLM_PROVIDER LLM_MODEL
export UI_ACCENT UI_WELCOME
export WORKER_URL_VAL WIDGET_URL_VAL WIDGET_TOKEN_VAL

python3 - <<'PYEOF'
import json, os

config_file = os.environ['CONFIG_FILE']

try:
    with open(config_file) as f:
        c = json.load(f)
except Exception:
    c = {}

def clean(obj):
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if not k.startswith('_')}
    if isinstance(obj, list):
        return [clean(x) for x in obj]
    return obj

c = clean(c)

def sv(key_path, val):
    if not val or val in ('None', 'null', 'false', 'true'):
        if val in ('false', 'true'):
            keys = key_path.split('.')
            obj = c
            for k in keys[:-1]:
                obj = obj.setdefault(k, {})
            obj[keys[-1]] = val == 'true'
        return
    keys = key_path.split('.')
    obj = c
    for k in keys[:-1]:
        obj = obj.setdefault(k, {})
    obj[keys[-1]] = val

def sv_list(key_path, csv):
    if not csv or csv in ('None', 'null'):
        return
    items = [v.strip() for v in csv.split(',') if v.strip()]
    if not items:
        return
    keys = key_path.split('.')
    obj = c
    for k in keys[:-1]:
        obj = obj.setdefault(k, {})
    obj[keys[-1]] = items

sv('botName',                   os.environ['BOT_NAME'])
sv('ownerName',                 os.environ['OWNER_NAME'])
sv('tone',                      os.environ['TONE'])
sv('responseStyle',             os.environ['RESPONSE_STYLE'])
sv('contactMethods.email',      os.environ['CONTACT_EMAIL'])
sv('contactMethods.linkedin',   os.environ['CONTACT_LINKEDIN'])
sv('contactMethods.whatsapp',   os.environ['CONTACT_WHATSAPP'])
sv('contactMethods.sms',        os.environ['CONTACT_SMS'])
sv('contactMethods.calendar',   os.environ['CONTACT_CALENDAR'])
sv('contactMethods.github',     os.environ['CONTACT_GITHUB'])
sv_list('security.allowedOrigins', os.environ['ALLOWED_ORIGINS'])
sv('llm.provider',              os.environ['LLM_PROVIDER'])
sv('llm.model',                 os.environ['LLM_MODEL'])
sv('ui.accentColor',            os.environ['UI_ACCENT'])
sv('ui.welcomeMessage',         os.environ['UI_WELCOME'])
sv('deployment.workerUrl',      os.environ['WORKER_URL_VAL'])
sv('deployment.widgetUrl',      os.environ['WIDGET_URL_VAL'])
sv('deployment.widgetToken',    os.environ['WIDGET_TOKEN_VAL'])

with open(config_file, 'w') as f:
    json.dump(c, f, indent=2)
    f.write('\n')
PYEOF

ok "setup/config.json saved."

# Copy any missing profile .md files from examples into setup/profile/
mkdir -p "$PROFILE_DIR"
COPIED_PROFILES=0
for EXAMPLE in "$EXAMPLES_DIR"/*.md; do
  [ -f "$EXAMPLE" ] || continue
  BASENAME="$(basename "$EXAMPLE")"
  TARGET="$PROFILE_DIR/$BASENAME"
  if [ ! -f "$TARGET" ]; then
    cp "$EXAMPLE" "$TARGET"
    info "Created setup/profile/$BASENAME from the example template."
    COPIED_PROFILES=1
  fi
done

echo ""
echo "================================"
echo "Setup complete."
echo ""

if [ "$COPIED_PROFILES" -eq 1 ]; then
  echo "  Profile templates were created in setup/profile/."
  echo "  Replace the example text with your real information before deploying."
else
  echo "  Profile files already exist in setup/profile/."
fi
echo ""
echo "  Files to edit:"
for FILE in about.md contact.md services.md experience.md faq.md boundaries.md; do
  [ -f "$PROFILE_DIR/$FILE" ] && echo "    * setup/profile/$FILE"
done
echo ""
echo "  At minimum, fill in setup/profile/about.md and setup/profile/contact.md."
echo ""
echo "  For advanced settings (blockedTopics, suggestedQuestions, etc.):"
echo "    edit setup/config.json directly."
echo ""

if [ "$CF_AUTHED" -eq 1 ]; then
  echo "  When your profile files are ready, deploy with:"
  echo "    bash scripts/setup.sh  (choose option 2)"
  echo ""
  if confirm "Deploy now?"; then
    bash "$ROOT/scripts/build-and-deploy.sh"
  fi
else
  echo "  Once authenticated, deploy with:"
  echo "    bash scripts/setup.sh  (choose option 2)"
fi
