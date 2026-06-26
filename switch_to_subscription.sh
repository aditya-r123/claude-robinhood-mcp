#!/usr/bin/env bash
# One-time migration: API-key billing  ->  Claude subscription (OAuth token).
#
# Prereq: run `claude setup-token` FIRST (requires a Pro/Max plan) and copy the
# printed token (starts sk-ant-oat...). This script then:
#   - verifies the token actually authenticates (one short Claude call),
#   - rewrites the crontab to use CLAUDE_CODE_OAUTH_TOKEN instead of ANTHROPIC_API_KEY,
#   - comments out any ANTHROPIC_API_KEY line in ~/.bashrc.
# Nothing changes if the token fails to authenticate. The token is never printed.
# Backups are mode 600 and named *.bak.* so they're rsync/git-excluded.
set -uo pipefail
CLAUDE=/usr/local/bin/claude
ts=$(date +%Y%m%d-%H%M%S)

# Disable bracketed paste so the terminal can't wrap the token in ESC[200~ ... ESC[201~
# markers, then extract the token robustly even if markers/whitespace slipped in.
# (A bracketed-paste artifact corrupted the token and caused a 401 the first time.)
printf '\033[?2004l' > /dev/tty 2>/dev/null || true
read -rsp "Paste CLAUDE_CODE_OAUTH_TOKEN (hidden), then Enter: " RAW; echo
TOKEN="$(printf '%s' "$RAW" | grep -oE 'sk-ant-oat[A-Za-z0-9_-]+' | head -1)"
[ -n "${TOKEN:-}" ] || { echo "No valid token found in input (expected 'sk-ant-oat...'). Aborting (nothing changed)."; exit 1; }

# ANTHROPIC_API_KEY out-ranks the subscription token, so clear it for THIS shell before testing.
unset ANTHROPIC_API_KEY

echo "Testing subscription auth (one short Claude call)..."
OUT=$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" "$CLAUDE" -p "Reply with exactly: SUBSCRIPTION_OK" --model sonnet --max-turns 1 2>&1)
if ! printf '%s' "$OUT" | grep -q SUBSCRIPTION_OK; then
  echo "!! Token did NOT authenticate. Nothing changed. Last lines of output:"
  printf '%s\n' "$OUT" | tail -5
  exit 1
fi
echo "OK: headless subscription auth works."

# Rewrite crontab: drop the API key line, add the OAuth token line, keep the schedule.
if crontab -l > "$HOME/quant_pod/crontab.bak.$ts" 2>/dev/null; then chmod 600 "$HOME/quant_pod/crontab.bak.$ts"; fi
{ echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN"
  crontab -l 2>/dev/null | grep -vE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='
} | crontab -
echo "crontab updated  (backup: ~/quant_pod/crontab.bak.$ts)"

# Neutralize the key in ~/.bashrc so interactive SSH shells also use the subscription.
if grep -q ANTHROPIC_API_KEY "$HOME/.bashrc" 2>/dev/null; then
  cp "$HOME/.bashrc" "$HOME/.bashrc.bak.$ts" && chmod 600 "$HOME/.bashrc.bak.$ts"
  sed -i 's/^\([^#].*ANTHROPIC_API_KEY.*\)$/# [disabled: using Claude subscription] \1/' "$HOME/.bashrc"
  echo "~/.bashrc API key line commented  (backup: ~/.bashrc.bak.$ts)"
fi
echo "DONE. Cron + interactive claude now run on your Claude subscription (no API billing)."
echo "Verify:  crontab -l   (should show CLAUDE_CODE_OAUTH_TOKEN, no ANTHROPIC_API_KEY)"
