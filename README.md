
## Autonomous Agentic Trading Pod: End-to-End AWS EC2 Deployment

This document outlines the complete infrastructure provisioning, headless authentication, and runtime configuration for deploying an autonomous Claude Code quantitative trading agent mapped to a Robinhood MCP server.

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
curl -fsSL [https://deb.nodesource.com/setup_20.x](https://deb.nodesource.com/setup_20.x) | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node -v 
npm -v

# Install Claude Code globally
sudo npm install -g @anthropic-ai/claude-code
```

## Phase 3: Headless Authentication & Workspace Setup

We will configure the server timezone to align with US equity markets, establish the workspace, and inject the API key for headless execution.

```bash
# Sync server timezone to Eastern Time
sudo timedatectl set-timezone America/New_York

# Inject the Anthropic API Key into the environment variables
echo "export ANTHROPIC_API_KEY='your_actual_api_key_here'" >> ~/.bashrc
source ~/.bashrc

# Create the workspace directories
mkdir -p ~/quant_pod
cd ~/quant_pod
touch log.txt
```

## Phase 4: The Strategy Configuration (ips_prompt.txt)

Create the master configuration file that drives the multi-agent logic.

```bash
nano ~/quant_pod/ips_prompt.txt
```

Paste your system prompt into `ips_prompt.txt`

## Phase 5: Robinhood MCP Integration

The server needs the MCP configuration to communicate with the brokerage.

```bash
# Initialize the Claude configuration directory
mkdir -p ~/.claude

# Create the settings file
nano ~/.claude/settings.json
```

Paste your local Robinhood MCP JSON configuration here. It should look like this:

```json
{
  "mcpServers": {
    "robinhood": {
      "command": "node",
      "args": ["/path/to/your/robinhood-mcp-server/build/index.js"],
      "env": {
        "ROBINHOOD_USERNAME": "your_email",
        "ROBINHOOD_PASSWORD": "your_password",
        "ROBINHOOD_DEVICE_TOKEN": "your_token"
      }
    }
  }
}
```

## Phase 6: Autonomous Scheduler (Cron)

Set up the scheduling daemon to trigger the agent headlessly, constrained by `--max-turns` to prevent infinite loops and runaway API costs.

```bash
# Find the exact binary path for Claude
which claude

# Note the output (typically /usr/bin/claude). Use it in the crontab below.
# Open the cron scheduler
crontab -e
```

Append the following two lines. The `>> ~/quant_pod/trade_execution.log` captures any system-level stdout/stderr (errors, tool failure dumps) for debugging, while the agent's actual trading actions are safely written to the `log.txt` file configured in Phase 4.

```bash
# Morning Routine: 09:00 AM Eastern Time (Mon-Fri)
0 9 * * 1-5 /usr/bin/claude -p "$(cat ~/quant_pod/ips_prompt.txt) Execute --mode=morning" --max-turns 15 --dangerously-skip-permissions >> ~/quant_pod/trade_execution.log 2>&1

# Afternoon Routine: 03:00 PM Eastern Time (Mon-Fri)
0 15 * * 1-5 /usr/bin/claude -p "$(cat ~/quant_pod/ips_prompt.txt) Execute --mode=afternoon" --max-turns 15 --dangerously-skip-permissions >> ~/quant_pod/trade_execution.log 2>&1
```

## Verification & Monitoring

You can now safely disconnect from the server.

* To view a clean, structured history of trades executed by the agent:
```bash
cat ~/quant_pod/log.txt
```


* To debug tool errors, API faults, or system crashes:
```bash
cat ~/quant_pod/trade_execution.log
```