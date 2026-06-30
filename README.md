# Autonomous Agentic Trading Pod

A Claude Code agent that trades a small US-equity portfolio on Robinhood, unattended, on a cron schedule. The strategy is a multi-persona "quant pod" (Alpha Miner → Risk Manager → Portfolio Manager) defined entirely in a system prompt.

## Architecture

```
cron (configurable schedule, ET)
  └─ scripts/run_trading.sh                      # MCP auth pre-flight, then:
       └─ claude -p "<ips_prompt.txt>" --model sonnet --max-turns 35
            ├─ Robinhood MCP (HTTP, OAuth)        # quotes, fundamentals, orders
            └─ WebSearch / WebFetch               # live catalysts, filings
                 └─ structured log → ~/quant_pod/log.txt + trade_execution.log
```

- **Strategy** lives in `ips_prompt.txt` (gitignored — private). It encodes the guardrails (cash floor, per-ticker cap, kill switch, liquidity/market-hours, data-integrity) and the deployment logic.
- **Runner** (`scripts/run_trading.sh`) verifies the MCP is connected, substitutes the real account id into the prompt at runtime, and invokes `claude -p` headless.
- **Brokerage auth:** Robinhood's hosted MCP (`https://agent.robinhood.com/mcp/trading`) is a remote **HTTP server authenticated via OAuth** — no username/password on disk. One browser login; Claude Code caches and auto-refreshes the token.
- **Model auth:** runs on a **Claude subscription** via a long-lived `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`), NOT the metered API. Never set `ANTHROPIC_API_KEY` — it overrides the token and bills per-token.

## Dashboard

A Next.js web dashboard (`dashboard/`) provides real-time visibility and control over the trading agent from any browser. It connects to the EC2 host over SSH to read logs and manage the cron schedule.

**Tabs (drag-to-reorder):**

- **Portfolio** — live Robinhood stats: equity, cash, P&L, open positions, recent orders, and interactive candlestick/line chart with six timeframes (1H / 1D / 1W / 1M / 1Y / MAX). Auto-refreshes every 2 minutes with a session cache.
- **Activity** — structured trade history parsed from `log.txt`, grouped by run. Shows each agent action (BUY / SELL / HOLD), risk-veto result, catalyst reasoning, run duration, and exit status. Live-polls for a running agent.
- **System Prompt** — in-browser editor for `ips_prompt.txt` on EC2. Edit and save the strategy without SSH.
- **Scheduler** — visual cron manager. Add, remove, and configure run times with market-session labels (Pre-Market, Market Open, Morning, Midday, Afternoon, Market Close). Writes directly to the EC2 crontab.

**Status bar** (header) shows whether the agent is currently running or when it was last active, polling every 5 seconds.

**API routes** (Next.js server, proxies to EC2 over SSH):

| Route | Purpose |
|---|---|
| `GET /api/portfolio?tf=…` | Robinhood portfolio, positions, orders, quotes, historical prices |
| `GET /api/activity` | Parsed log lines + run metadata |
| `GET /api/status` | Agent running / last-active seconds |
| `GET /api/prompt` / `POST /api/prompt` | Read / write `ips_prompt.txt` on EC2 |
| `GET /api/cron` / `POST /api/cron` | Read / write EC2 crontab entries |

## Repo layout

```
ips_prompt.txt              # the strategy (gitignored; synced to EC2 only)
dashboard/                  # Next.js monitoring & control dashboard
  app/                      # Next.js App Router pages + API routes
  components/               # Portfolio, ActivityLog, CronScheduler, PromptEditor
scripts/
  run_trading.sh            # cron entrypoint: MCP pre-flight + headless agent
  switch_to_subscription.sh # one-time: migrate cron/shell off ANTHROPIC_API_KEY
  check-secrets.sh          # pre-push secret tripwire
templates/
  crontab.template          # a sample schedule (fill in the token, then install)
  Makefile.local.example    # copy to Makefile.local; fill in host/key/account
Makefile                    # local <-> EC2 rsync (never carries secrets)
```

## Setup (high level)

1. **EC2:** Ubuntu 24.04, `t3.micro`, default `ubuntu` user (not root — `--dangerously-skip-permissions` is blocked for root). `sudo timedatectl set-timezone America/New_York`.
2. **Install:** Node 20+ and `sudo npm i -g @anthropic-ai/claude-code` (`which claude` → `/usr/local/bin/claude`).
3. **Model auth:** `claude setup-token` (Pro/Max), copy the `sk-ant-oat...` token.
4. **Brokerage auth:** `claude mcp add --transport http --scope user --callback-port 8765 robinhood-trading https://agent.robinhood.com/mcp/trading`, then authenticate once over an SSH tunnel (`ssh -L 8765:localhost:8765 ...` → `claude` → `/mcp`). Confirm `claude mcp list` shows ✔ Connected.
5. **Workspace:** put `ips_prompt.txt` + `scripts/` under `~/quant_pod/`; write the real account number to `~/quant_pod/.account_id` (`chmod 600`).
6. **Schedule:** fill the token into `templates/crontab.template`, then `crontab templates/crontab.template`. Or use the dashboard Scheduler tab after setup. `scripts/switch_to_subscription.sh` verifies a token and strips any `ANTHROPIC_API_KEY` for you.
7. **Dashboard:** copy `templates/Makefile.local.example` to `Makefile.local`, fill in your EC2 host/key/account. Then `cd dashboard && npm install && npm run dev` (or deploy to Vercel/similar). Set `EC2_HOST`, `EC2_KEY_PATH`, and `EC2_USER` in the dashboard's `.env.local`.

## Monitoring

- **Dashboard** — browser UI at `localhost:3000` (or your deployed URL).
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
