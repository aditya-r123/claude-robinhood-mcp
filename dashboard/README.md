# Quant Pod Dashboard

A local-only web UI for the trading bot. Two panels:

- **System Prompt** — view/edit `ips_prompt.txt`; Save writes the local file **and** `scp`s it to AWS (backing up the remote copy first), then verifies the md5 matches.
- **Activity** — SSHes both `~/quant_pod/trade_execution.log` (agent reasoning) and `~/quant_pod/log.txt` (canonical trades) and merges them into one card per run, grouped by day → run. Each card shows the trades, the Decision, the per-stage deliberation (Alpha Miner / Risk Manager / Portfolio Manager …), the summary, and sources. Canonical trades are matched to their run by timestamp window and unioned with the exec-log actions (nothing dropped); trades that match no run land in an "Other logged trades" bucket. Auto-refreshes every 4s while a run is live (every 30s otherwise).

## Run

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000
```

## Config

Host/key/remote-dir are read from the repo's `Makefile.local` automatically. Override with env vars if needed:

```
DASH_EC2_HOST=ubuntu@ec2-...    DASH_SSH_KEY=~/Downloads/cs133.pem
DASH_REMOTE_DIR=/home/ubuntu/quant_pod    DASH_LOCAL_PROMPT=/abs/path/ips_prompt.txt
```

The backend shells out to your system `ssh`/`scp` with that key — same access you already use.
