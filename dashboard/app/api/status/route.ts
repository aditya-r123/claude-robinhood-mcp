import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { sshExec } from '@/lib/ssh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execLog = `${config.remoteDir}/trade_execution.log`;

export async function GET() {
  try {
    const cmd = [
      // [c]laude bracket trick: matches the running agent but not this pgrep's own command line.
      `echo "RUNNING:$(pgrep -fc '[c]laude -p' 2>/dev/null || echo 0)"`,
      `echo "MTIME:$(stat -c %Y ${execLog} 2>/dev/null || echo 0)"`,
      `echo "NOW:$(date +%s)"`,
      `echo "---TAIL---"`,
      `tail -n 6 ${execLog} 2>/dev/null || true`,
    ].join('; ');
    const out = await sshExec(cmd);
    const running = /RUNNING:([1-9]\d*)/.test(out);
    const mtime = Number(out.match(/MTIME:(\d+)/)?.[1] || 0);
    const now = Number(out.match(/NOW:(\d+)/)?.[1] || 0);
    const tail = out.split('---TAIL---')[1]?.trim() || '';
    return NextResponse.json({
      running,
      lastActivitySecondsAgo: mtime && now ? now - mtime : null,
      tail,
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e), running: false }, { status: 500 });
  }
}
