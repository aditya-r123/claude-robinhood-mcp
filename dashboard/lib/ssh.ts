import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config';

const execFileAsync = promisify(execFile);

const baseOpts = [
  '-i', config.sshKey,
  '-o', 'ConnectTimeout=15',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
];

export async function sshExec(remoteCmd: string): Promise<string> {
  const { stdout } = await execFileAsync('ssh', [...baseOpts, config.ec2Host, remoteCmd], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function scpUpload(localPath: string, remotePath: string): Promise<void> {
  await execFileAsync('scp', [...baseOpts, localPath, `${config.ec2Host}:${remotePath}`]);
}

export function sshSpawn(remoteCmd: string) {
  return spawn('ssh', [...baseOpts, config.ec2Host, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
}
