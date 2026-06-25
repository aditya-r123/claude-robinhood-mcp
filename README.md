
## Autonomous Agentic Trading Pod: End-to-End AWS EC2 Deployment

This document outlines the complete infrastructure provisioning, headless authentication, and runtime configuration for deploying an autonomous Claude Code quantitative trading agent connected to **Robinhood's official hosted MCP server** (`https://agent.robinhood.com/mcp/trading`).

> **Important — how brokerage auth actually works.** Robinhood's MCP is a remote **HTTP server authenticated via OAuth**, *not* a local package you feed a username/password to. You authenticate once through a browser; Claude Code caches an access token (and a refresh token that auto-renews it). There is no `uvx robinhood-mcp` package and no plaintext-credentials step — any guide that tells you to put your Robinhood password in a config file is wrong and will not connect.

## Phase 1: Infrastructure Provisioning (AWS EC2)

Do not use the `root` user for this deployment. Recent security updates to Claude Code strictly prohibit the use of the `--dangerously-skip-permissions` flag when executed by root. Rely on the default `ubuntu` user provided by the AWS AMI.

1. Navigate to the **EC2 Dashboard** in your AWS Console.
2. Select **Launch Instance**.
3. **AMI Configuration:** Select **Ubuntu Server 24.04 LTS (HVM)**, SSD Volume Type.
4. **Instance Type:** A `t3.micro` or `t3.small` is sufficient.
5. **Key Pair:** Select an existing `.pem` key pair or create a new one. Download it securely to your local machine.
6. **Network Settings:** Ensure **Allow SSH traffic from Anywhere** (or your specific IP) is checked. HTTP/HTTPS ingress is not needed.
7. **Storage:** 8GB gp3 is sufficient. Launch the instance.

Connect to your instance via SSH:
```bash
ssh -i /path/to/your-key.pem ubuntu@<YOUR_EC2_PUBLIC_IP>
```

## Phase 2: Environment Bootstrapping

Initialize the environment by installing Node.js (v20+) and the Claude CLI.

```bash
# Update package lists
sudo apt update && sudo apt upgrade -y

# Install Node.js (v20.x required for Claude Code)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node -v
npm -v

# Install Claude Code globally
sudo npm install -g @anthropic-ai/claude-code

# Confirm the install path — you will need it for cron. It is usually
# /usr/local/bin/claude (NOT /usr/bin/claude).
which claude
```

## Phase 3: Workspace, Timezone & Headless API Key

Configure the server timezone to align with US equity markets and create the workspace.

```bash
# Sync server timezone to Eastern Time
sudo timedatectl set-timezone America/New_York

# Create the workspace
mkdir -p ~/quant_pod
cd ~/quant_pod
touch log.txt trade_execution.log
```

**About the Anthropic API key.** Headless `claude -p` needs an API key to authenticate to Anthropic (this is separate from the Robinhood/brokerage auth in Phase 5). Cron does **not** read `~/.bashrc`, so exporting it there is not enough for scheduled runs — the key must be set in the crontab itself. We do that in Phase 6. You can still add it to your shell profile for interactive testing:

```bash
echo "export ANTHROPIC_API_KEY='sk-ant-...'" >> ~/.bashrc
source ~/.bashrc
```

## Phase 4: The Strategy Configuration (ips_prompt.txt)

Create the master prompt that drives the multi-agent logic.

```bash
nano ~/quant_pod/ips_prompt.txt
```

Paste your system prompt into `ips_prompt.txt`.

> **Tool names must match the real MCP.** Write your workflow against the tools the Robinhood MCP actually exposes (e.g. `get_accounts`, `get_portfolio`, `get_equity_positions`, `get_equity_quotes`, `get_equity_fundamentals`, `get_equity_historicals`, `place_equity_order`, `cancel_equity_order`). Inventing tool names like `get_buying_power`, `get_portfolio_status`, or `review_equity_order` will make the agent improvise or stall. List the live tools any time with `claude mcp list` (connected) or by asking a headless `claude -p` to enumerate `mcp__robinhood-trading__*` tools.

## Phase 5: Robinhood MCP Integration (Official OAuth Server)

Register Robinhood's hosted MCP server, **user-scoped** so it is visible from any working directory — including the home directory cron runs from. We pin a fixed OAuth callback port so the one-time browser authentication can be tunneled over SSH.

```bash
# Register the official Robinhood HTTP MCP server (user scope, fixed callback port)
claude mcp add --transport http --scope user --callback-port 8765 \
  robinhood-trading https://agent.robinhood.com/mcp/trading

# It will show "Needs authentication" until you complete the OAuth step below
claude mcp list
```

### One-time OAuth authentication (headless server)

OAuth needs a browser, which a headless EC2 box does not have. Forward the callback port over SSH so the browser on your **local machine** can complete the loop:

1. From your **local machine**, SSH in with the callback port forwarded:
   ```bash
   ssh -i /path/to/your-key.pem -L 8765:localhost:8765 ubuntu@<YOUR_EC2_PUBLIC_IP>
   ```
2. On the EC2 box, start an interactive session and trigger auth:
   ```bash
   claude
   # then inside Claude Code:
   /mcp
   # select robinhood-trading -> Authenticate
   ```
3. Claude prints an authorization URL. Open it in your **local** browser, log into Robinhood, and approve. The callback returns to `localhost:8765`, tunnels through SSH back to EC2, and the token is cached in `~/.claude/.credentials.json`.
4. Verify:
   ```bash
   claude mcp list
   # robinhood-trading: ... (HTTP) - ✔ Connected
   ```

> **Token lifetime.** The cached access token is short-lived (~6 days), but a **refresh token** is stored alongside it and Claude Code renews the access token automatically on each run — so this is effectively set-and-forget. You only need to repeat this OAuth step if the refresh token is revoked or expires. The pre-flight check in Phase 6 makes any such failure loud instead of silent.

## Phase 6: Autonomous Scheduler (Cron + Pre-flight Auth Check)

Rather than calling `claude` directly from cron, we use a small runner script that first verifies the Robinhood MCP is authenticated. If it is not, the run is skipped with a loud log entry instead of silently attempting to trade with no brokerage connection.

Create the runner:

```bash
nano ~/quant_pod/run_trading.sh
```

Paste:

See [`run_trading.sh`](run_trading.sh) in this repo for the full script. Besides the MCP auth pre-flight, it resolves the account id from the untracked `~/quant_pod/.account_id` file and substitutes the `__ACCOUNT_ID__` placeholder into the prompt at runtime, so the real account number never lands in the synced/committed files.

Make it executable, create the untracked account-id override, and sanity-check the syntax:

```bash
chmod +x ~/quant_pod/run_trading.sh
echo "YOUR_ACCOUNT_NUMBER" > ~/quant_pod/.account_id && chmod 600 ~/quant_pod/.account_id
bash -n ~/quant_pod/run_trading.sh && echo "syntax OK"
```

Open the cron scheduler:

```bash
crontab -e
```

Add the API key as an environment line (cron does not source your shell profile), then the two schedule lines pointing at the runner:

```bash
ANTHROPIC_API_KEY=sk-ant-...

# Morning Routine: 09:00 AM Eastern Time (Mon-Fri) — pre-flight auth check then trade
0 9 * * 1-5 /home/ubuntu/quant_pod/run_trading.sh morning

# Afternoon Routine: 03:30 PM Eastern Time (Mon-Fri) — pre-flight auth check then trade
30 15 * * 1-5 /home/ubuntu/quant_pod/run_trading.sh afternoon
```

> **Flag notes.** `--dangerously-skip-permissions` auto-approves tool calls (required for unattended runs). `--max-turns 15` caps the agent loop to prevent runaway API cost. `--thinking adaptive` enables extended thinking — the CLI only accepts `enabled`, `adaptive`, or `disabled` (there is no `--thinking-budget` flag).

## Verification & Monitoring

You can now safely disconnect from the server.

* Confirm the brokerage connection is healthy at any time:
```bash
claude mcp list
```

* View a clean, structured history of trades executed by the agent:
```bash
cat ~/quant_pod/log.txt
```

* Debug runs, pre-flight skips, tool errors, or crashes (every run is bracketed with timestamped `===== Starting / Finished =====` markers):
```bash
tail -50 ~/quant_pod/trade_execution.log
```

## Phase 7: Version Control & Local ↔ EC2 Sync

This repo is the source of truth; the EC2 `~/quant_pod` directory holds the same project files plus runtime-only state (logs, the `.account_id` override, the OAuth cache). A `Makefile` drives an rsync mirror that **never** carries secrets.

One-time local setup:

```bash
cp Makefile.local.example Makefile.local   # then edit: EC2_HOST, SSH_KEY, REMOTE_DIR, ACCOUNT_ID
```

Day-to-day:

```bash
make pull              # EC2  -> local : bring edits made on the server down
make push              # local -> EC2  : send edits made locally up
make diff-pull         # preview a pull (dry run, shows what would change)
make diff-push         # preview a push
make save msg="..."    # pull from EC2, then git add + commit
make gitpush           # run the secret scan, then git push to GitHub
```

Typical loops:

- **Edited on EC2** (e.g. tweaked the strategy live): `make save msg="tuned alpha miner"` then `make gitpush`.
- **Edited locally**: commit, then `make deploy` (alias for `make push`) to update the server.

What is **excluded** from every sync and from git (see `.gitignore` and the rsync excludes): `Makefile.local`, `.account_id`, `.env`, `*credentials*`, `*.pem`, all `*.log`/`log.txt`, `*.bak*`, editor swap files, and the OAuth cache. `make gitpush` additionally runs `scripts/check-secrets.sh`, which greps every tracked file for API keys, private keys, OAuth tokens, and your real account number, and aborts the push if any are found.

> **Note on "immediate" sync.** These targets are explicit and directional — you run `pull` or `push` based on where you just edited. rsync is one-way per call, so there is no auto-merge. If you want true real-time two-way syncing, use a dedicated tool such as [`unison`](https://github.com/bcpierce00/unison) or [`mutagen`](https://mutagen.io/); the Makefile targets above are the simple, conflict-free default.

## Security Notes

* The Robinhood connection uses OAuth — there are **no brokerage credentials stored on disk**. Do not add your Robinhood username/password to any config file; the official MCP does not use them.
* Your `ANTHROPIC_API_KEY` lives in the crontab. Treat the instance as sensitive: restrict SSH access, and rotate the key if the instance is ever exposed.
* The OAuth token cache is in `~/.claude/.credentials.json` (mode `600`). Anyone with that file can trade your account — protect it accordingly.
* Your real account number is kept out of the repo: tracked files use the `__ACCOUNT_ID__` placeholder, and the real value lives only in the untracked `~/quant_pod/.account_id` (EC2) and `Makefile.local` (local). Both are gitignored and rsync-excluded.
* Before pushing, `make gitpush` runs `scripts/check-secrets.sh` as a tripwire. It is a safety net, not a guarantee — keep secrets in the untracked files listed above.
