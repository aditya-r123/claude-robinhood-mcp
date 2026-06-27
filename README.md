# Autonomous Agentic Trading Pod

A headless Claude Code agent that trades a small US-equity portfolio on Robinhood, unattended, on a cron schedule. The strategy is a multi-persona "quant pod" (Alpha Miner → Risk Manager → Portfolio Manager) defined entirely in a system prompt.

## Architecture

```
cron (4x/trading-day, ET)
  └─ scripts/run_trading.sh                      # MCP auth pre-flight, then:
       └─ claude -p "<ips_prompt.txt>" --model sonnet --max-turns 35
            ├─ Robinhood MCP (HTTP, OAuth)        # quotes, fundamentals, orders
            └─ WebSearch / WebFetch               # live catalysts, filings
                 └─ one log line per action → ~/quant_pod/log.txt
```

- **Strategy** lives in `ips_prompt.txt` (gitignored — private). It encodes the guardrails (cash floor, per-ticker cap, kill switch, liquidity/market-hours, data-integrity) and the deployment logic.
- **Runner** (`scripts/run_trading.sh`) verifies the MCP is connected, substitutes the real account id into the prompt at runtime, and invokes `claude -p` headless.
- **Brokerage auth:** Robinhood's hosted MCP (`https://agent.robinhood.com/mcp/trading`) is a remote **HTTP server authenticated via OAuth** — no username/password on disk. One browser login; Claude Code caches and auto-refreshes the token.
- **Model auth:** runs on a **Claude subscription** via a long-lived `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), NOT the metered API. Never set `ANTHROPIC_API_KEY` — it overrides the token and bills per-token.

## Repo layout

```
ips_prompt.txt              # the strategy (gitignored; synced to EC2 only)
scripts/
  run_trading.sh            # cron entrypoint: MCP pre-flight + headless agent
  switch_to_subscription.sh # one-time: migrate cron/shell off ANTHROPIC_API_KEY
  check-secrets.sh          # pre-push secret tripwire
templates/
  crontab.template          # the 4-run schedule (fill in the token, then install)
  Makefile.local.example    # copy to Makefile.local; host/key/account
Makefile                    # local <-> EC2 rsync (never carries secrets)
```

## Setup (high level)

1. **EC2:** Ubuntu 24.04, `t3.micro`, default `ubuntu` user (not root — `--dangerously-skip-permissions` is blocked for root). `sudo timedatectl set-timezone America/New_York`.
2. **Install:** Node 20+ and `sudo npm i -g @anthropic-ai/claude-code` (`which claude` → `/usr/local/bin/claude`).
3. **Model auth:** `claude setup-token` (Pro/Max), copy the `sk-ant-oat...` token.
4. **Brokerage auth:** `claude mcp add --transport http --scope user --callback-port 8765 robinhood-trading https://agent.robinhood.com/mcp/trading`, then authenticate once over an SSH tunnel (`ssh -L 8765:localhost:8765 ...` → `claude` → `/mcp`). Confirm `claude mcp list` shows ✔ Connected.
5. **Workspace:** put `ips_prompt.txt` + `scripts/` under `~/quant_pod/`; write the real account number to `~/quant_pod/.account_id` (`chmod 600`).
6. **Schedule:** fill the token into `templates/crontab.template`, then `crontab templates/crontab.template`. `scripts/switch_to_subscription.sh` verifies a token and strips any `ANTHROPIC_API_KEY` for you.

## Monitoring

- `cat ~/quant_pod/log.txt` — structured trade history (one line per action).
- `tail -50 ~/quant_pod/trade_execution.log` — full run output, pre-flight skips, errors (each run bracketed by `===== Starting/Finished =====`).
- `claude mcp list` — brokerage connection health.

## Local ↔ EC2 sync

`Makefile` drives a one-way rsync mirror that excludes all secrets (`Makefile.local`, `.account_id`, `*.pem`, `*credentials*`, logs, `*.bak*`, the OAuth cache). Targets: `make push` / `make pull` / `make diff-push` / `make gitpush` (runs `scripts/check-secrets.sh` first).

## Security

- No brokerage credentials on disk — OAuth only.
- Model auth is the subscription token in the crontab: a ~1-year secret. Restrict SSH; regenerate via `claude setup-token` if exposed.
- The real account number stays out of git — tracked files use the `__ACCOUNT_ID__` placeholder; the real value lives only in `~/quant_pod/.account_id` (EC2) and `Makefile.local` (local), both gitignored + rsync-excluded.
- `make gitpush` runs `scripts/check-secrets.sh` as a tripwire (greps tracked files for API keys, private keys, OAuth tokens, and the real account id).
