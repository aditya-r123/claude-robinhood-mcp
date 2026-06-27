#!/usr/bin/env bash
# One-time: migrate cron + shell off ANTHROPIC_API_KEY onto a Claude subscription token.
# Prereq: run `claude setup-token` and copy the printed sk-ant-oat... token.
set -uo pipefail
CLAUDE=/usr/local/bin/claude
ts=$(date +%Y%m%d-%H%M%S)

printf '\033[?2004l' > /dev/tty 2>/dev/null || true   # disable bracketed paste
read -rsp "Paste CLAUDE_CODE_OAUTH_TOKEN (hidden), then Enter: " RAW; echo
TOKEN="$(printf '%s' "$RAW" | grep -oE 'sk-ant-oat[A-Za-z0-9_-]+' | head -1)"
[ -n "${TOKEN:-}" ] || { echo "No valid sk-ant-oat... token found. Aborting."; exit 1; }

unset ANTHROPIC_API_KEY   # the API key out-ranks the subscription token
echo "Testing subscription auth..."
OUT=$(CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" "$CLAUDE" -p "Reply with exactly: SUBSCRIPTION_OK" --model sonnet --max-turns 1 2>&1)
if ! printf '%s' "$OUT" | grep -q SUBSCRIPTION_OK; then
  echo "!! Token did NOT authenticate. Nothing changed:"; printf '%s\n' "$OUT" | tail -5; exit 1
fi
echo "OK."

if crontab -l > "$HOME/quant_pod/crontab.bak.$ts" 2>/dev/null; then chmod 600 "$HOME/quant_pod/crontab.bak.$ts"; fi
{ echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN"; crontab -l 2>/dev/null | grep -vE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='; } | crontab -
echo "crontab updated (backup: ~/quant_pod/crontab.bak.$ts)"

if grep -q ANTHROPIC_API_KEY "$HOME/.bashrc" 2>/dev/null; then
  cp "$HOME/.bashrc" "$HOME/.bashrc.bak.$ts" && chmod 600 "$HOME/.bashrc.bak.$ts"
  sed -i 's/^\([^#].*ANTHROPIC_API_KEY.*\)$/# [disabled] \1/' "$HOME/.bashrc"
  echo "~/.bashrc API key commented (backup: ~/.bashrc.bak.$ts)"
fi
echo "DONE — cron now runs on your subscription. Verify: crontab -l"
