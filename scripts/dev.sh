#!/usr/bin/env bash
# Runs the chat worker locally with your real setup/ files.
#
#   bash scripts/dev.sh
#
# wrangler dev does not read shell variables, so this script passes
# setup/config.json and setup/profile/*.md to it with --var.
# Put your API key in worker/.dev.vars (gitignored):
#   LLM_API_KEY=sk-...

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT/worker"
CONFIG_FILE="$ROOT/setup/config.json"
[ -f "$CONFIG_FILE" ] || CONFIG_FILE="$ROOT/setup/examples/config.json"
export ROOT CONFIG_FILE

if [ ! -x "$WORKER_DIR/node_modules/.bin/wrangler" ]; then
  (cd "$WORKER_DIR" && npm install --silent)
fi

if [ ! -f "$WORKER_DIR/.dev.vars" ]; then
  echo "  warn     worker/.dev.vars not found. Create it with one line: LLM_API_KEY=your-key"
fi

# Same rules as the deploy script: files that still have the example marker are skipped.
PROFILE_TEXT="$(python3 -c "
import glob, os
parts = []
for path in sorted(glob.glob(os.path.join(os.environ['ROOT'], 'setup', 'profile', '*.md'))):
    text = open(path, encoding='utf-8').read()
    if 'PORTFOLIO-CHATBOT-EXAMPLE' in text:
        continue
    parts.append('## ' + os.path.basename(path)[:-3] + '\n\n' + text)
print('\n\n'.join(parts))
")"

# Origin checks are switched off locally, so widget/dev.html works from your disk.
BOT_CONFIG_JSON="$(python3 -c "
import json, os
c = json.load(open(os.environ['CONFIG_FILE']))
c.setdefault('security', {})['allowedOrigins'] = []
print(json.dumps(c))
")"

echo "  info     Config:  ${CONFIG_FILE#$ROOT/}"
echo "  info     Profile: ${#PROFILE_TEXT} characters from setup/profile/"
echo "  info     Test page: open widget/dev.html in your browser."
echo ""

cd "$WORKER_DIR"
exec ./node_modules/.bin/wrangler dev \
  --var "BOT_CONFIG_JSON:$BOT_CONFIG_JSON" \
  --var "PROFILE_TEXT:$PROFILE_TEXT" \
  "$@"
