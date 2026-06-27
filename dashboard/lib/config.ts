import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// dashboard/ lives inside the repo; the bot config is one level up.
const repoRoot = path.resolve(process.cwd(), '..');

function readMakefileLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const txt = fs.readFileSync(path.join(repoRoot, 'Makefile.local'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*(EC2_HOST|SSH_KEY|REMOTE_DIR|ACCOUNT_ID)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* fall back to env / defaults */
  }
  return out;
}

const expandHome = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const mk = readMakefileLocal();

export const config = {
  ec2Host: process.env.DASH_EC2_HOST || mk.EC2_HOST || 'ubuntu@ec2-34-229-143-152.compute-1.amazonaws.com',
  sshKey: expandHome(process.env.DASH_SSH_KEY || mk.SSH_KEY || '~/Downloads/cs133.pem'),
  remoteDir: process.env.DASH_REMOTE_DIR || mk.REMOTE_DIR || '/home/ubuntu/quant_pod',
  localPrompt: process.env.DASH_LOCAL_PROMPT || path.join(repoRoot, 'ips_prompt.txt'),
  accountId: process.env.DASH_ACCOUNT_ID || mk.ACCOUNT_ID || '',
};
