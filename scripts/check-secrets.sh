#!/usr/bin/env bash
# Pre-push tripwire: scan git-tracked files for secrets. Non-zero exit aborts the push.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0

patterns='sk-ant-api[0-9]'
patterns+='|-----BEGIN [A-Z ]*PRIVATE KEY'
patterns+='|"(access_token|refresh_token)"[[:space:]]*:'
patterns+='|ROBINHOOD_PASSWORD[[:space:]"'\'']*[:=][[:space:]"'\'']*[^"'\'' ]'
if git ls-files -z | xargs -0 grep -InE "$patterns" 2>/dev/null; then
    echo "!! Credential-like content in tracked files (above)."; fail=1
fi

if [ -n "${ACCOUNT_ID:-}" ] && [ "${ACCOUNT_ID}" != "000000000" ]; then
    if git ls-files -z | xargs -0 grep -In "$ACCOUNT_ID" 2>/dev/null; then
        echo "!! Real account id leaked into a tracked file (above)."; fail=1
    fi
fi

[ "$fail" -eq 0 ] && echo "OK: no secrets found in tracked files."
exit "$fail"
