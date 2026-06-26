#!/usr/bin/env bash
# Robinhood trading agent runner with MCP auth pre-flight check.
# Usage: run_trading.sh <morning|afternoon>
#
# The tracked ips_prompt.txt stores the account id as the placeholder
# __ACCOUNT_ID__. The real account number lives ONLY in the untracked file
# ~/quant_pod/.account_id and is substituted in at runtime, so it never lands
# in the public repo or the synced files.
set -uo pipefail

CLAUDE=/usr/local/bin/claude
PROMPT_FILE="$HOME/quant_pod/ips_prompt.txt"
ACCOUNT_FILE="$HOME/quant_pod/.account_id"   # untracked, machine-local override
LOG="$HOME/quant_pod/trade_execution.log"
MODE="${1:-morning}"

ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }

echo "[$(ts)] ===== Starting $MODE run =====" >> "$LOG"

# --- Resolve the account id from the untracked local-override file ---
if [ ! -s "$ACCOUNT_FILE" ]; then
    echo "[$(ts)] !!! Missing or empty $ACCOUNT_FILE (account id override). SKIPPING $MODE run." >> "$LOG"
    exit 1
fi
ACCOUNT_ID="$(tr -d '[:space:]' < "$ACCOUNT_FILE")"

# --- Pre-flight: verify the Robinhood MCP is authenticated/connected ---
HEALTH="$(timeout 60 "$CLAUDE" mcp list 2>&1)"
if ! echo "$HEALTH" | grep -q 'robinhood-trading.*Connected'; then
    echo "[$(ts)] !!! MCP NOT AUTHENTICATED — robinhood-trading is not connected. SKIPPING $MODE run." >> "$LOG"
    echo "[$(ts)] --- 'claude mcp list' output was: ---" >> "$LOG"
    echo "$HEALTH" >> "$LOG"
    echo "[$(ts)] --- To re-auth: ssh -i <key>.pem -L 8765:localhost:8765 ubuntu@<host>, then run 'claude' -> /mcp -> robinhood-trading -> authenticate ---" >> "$LOG"
    exit 1
fi

# --- Substitute the account id placeholder at runtime (never stored in the tracked prompt) ---
PROMPT_BODY="$(sed "s/__ACCOUNT_ID__/${ACCOUNT_ID}/g" "$PROMPT_FILE")"

echo "[$(ts)] MCP auth OK (robinhood-trading connected). Executing agent (mode=$MODE)..." >> "$LOG"
"$CLAUDE" -p "$PROMPT_BODY Execute --mode=$MODE" --model sonnet --max-turns 15 --dangerously-skip-permissions --thinking adaptive >> "$LOG" 2>&1
RC=$?
echo "[$(ts)] ===== Finished $MODE run (claude exit code: $RC) =====" >> "$LOG"
exit $RC
