#!/usr/bin/env bash
# Cron runner: MCP auth pre-flight, then the headless agent. Usage: run_trading.sh <tag>
set -uo pipefail

CLAUDE=/usr/local/bin/claude
PROMPT_FILE="$HOME/quant_pod/ips_prompt.txt"
ACCOUNT_FILE="$HOME/quant_pod/.account_id"
LOG="$HOME/quant_pod/trade_execution.log"
MODE="${1:-scheduled}"
ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }

echo "[$(ts)] ===== Starting $MODE run =====" >> "$LOG"

if [ ! -s "$ACCOUNT_FILE" ]; then
    echo "[$(ts)] !!! Missing/empty $ACCOUNT_FILE. SKIPPING $MODE run." >> "$LOG"; exit 1
fi
ACCOUNT_ID="$(tr -d '[:space:]' < "$ACCOUNT_FILE")"

HEALTH="$(timeout 60 "$CLAUDE" mcp list 2>&1)"
if ! echo "$HEALTH" | grep -q 'robinhood-trading.*Connected'; then
    echo "[$(ts)] !!! MCP NOT AUTHENTICATED. SKIPPING $MODE run." >> "$LOG"
    echo "$HEALTH" >> "$LOG"; exit 1
fi

PROMPT_BODY="$(sed "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" "$PROMPT_FILE")"
echo "[$(ts)] MCP OK. Executing agent (mode=$MODE)..." >> "$LOG"
"$CLAUDE" -p "$PROMPT_BODY Execute --mode=$MODE" --model sonnet --max-turns 35 --dangerously-skip-permissions --thinking adaptive >> "$LOG" 2>&1
RC=$?
echo "[$(ts)] ===== Finished $MODE run (claude exit code: $RC) =====" >> "$LOG"
exit $RC
