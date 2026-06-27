import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { config } from '@/lib/config';
import { sshExec, scpUpload } from '@/lib/ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const remotePrompt = `${config.remoteDir}/ips_prompt.txt`;
const md5 = (s: string | Buffer) => createHash('md5').update(s).digest('hex');

export async function GET() {
  try {
    const content = await fs.readFile(config.localPrompt, 'utf8');
    return NextResponse.json({
      content,
      path: config.localPrompt,
      md5: md5(content),
      bytes: Buffer.byteLength(content),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const content = body.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return NextResponse.json({ error: 'content must be a non-empty string' }, { status: 400 });
  }

  // 1. Write the local (gitignored) copy.
  await fs.writeFile(config.localPrompt, content, 'utf8');
  const localMd5 = md5(content);

  // 2. Back up the remote copy (timestamped, chmod 600), push, verify md5.
  let remoteMd5 = '';
  let synced = false;
  let syncError = '';
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await sshExec(`cp -p ${remotePrompt} ${remotePrompt}.bak.${stamp} 2>/dev/null; true`);
    await scpUpload(config.localPrompt, remotePrompt);
    await sshExec(`chmod 600 ${remotePrompt}`);
    remoteMd5 = (await sshExec(`md5sum ${remotePrompt} | awk '{print $1}'`)).trim();
    synced = remoteMd5 === localMd5;
    if (!synced) syncError = `md5 mismatch: local ${localMd5} vs remote ${remoteMd5}`;
  } catch (e: any) {
    syncError = String(e?.message || e);
  }

  return NextResponse.json({
    ok: synced,
    localMd5,
    remoteMd5,
    synced,
    syncError: syncError || undefined,
    bytes: Buffer.byteLength(content),
  });
}
