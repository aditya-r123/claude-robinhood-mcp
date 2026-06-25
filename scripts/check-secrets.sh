#!/usr/bin/env bash
# Scan all git-TRACKED files for secrets before a push.
# Exits non-zero if anything credential-like is found.
# Run from the repo root (the Makefile passes ACCOUNT_ID via the environment).
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# Credential signatures that must never appear in tracked files.
patterns='sk-ant-api[0-9]'                      # Anthropic API key
patterns+='|-----BEGIN [A-Z ]*PRIVATE KEY'      # SSH/TLS private keys
patterns+='|"(access_token|refresh_token)"[[:space:]]*:'  # OAuth tokens
patterns+='|ROBINHOOD_PASSWORD[[:space:]"'\'']*[:=][[:space:]"'\'']*[^"'\'' ]'  # RH password with a value

if git ls-files -z | xargs -0 grep -InE "$patterns" 2>/dev/null; then
    echo "!! Credential-like content found in tracked files (above)."
    fail=1
fi

# If the real account id is supplied (from Makefile.local), make sure it never
# leaked into a tracked file. The value itself is never written here.
if [ -n "${ACCOUNT_ID:-}" ] && [ "${ACCOUNT_ID}" != "000000000" ]; then
    if git ls-files -z | xargs -0 grep -In "$ACCOUNT_ID" 2>/dev/null; then
        echo "!! Real account id leaked into a tracked file (above)."
        fail=1
    fi
fi

if [ "$fail" -eq 0 ]; then
    echo "OK: no secrets found in tracked files."
fi
exit "$fail"
