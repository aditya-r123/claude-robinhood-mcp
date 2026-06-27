import { config } from '@/lib/config';
import { sshExec } from '@/lib/ssh';
import { mergeActivity } from '@/lib/mergeActivity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execLog = `${config.remoteDir}/trade_execution.log`;
const tradeLog = `${config.remoteDir}/log.txt`;

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* client disconnected */
        }
      };

      try {
        // Fetch both log files in parallel — roughly halves round-trip time vs
        // the old single concatenated SSH command.
        const [execText, tradeText] = await Promise.all([
          sshExec(`cat ${execLog} 2>/dev/null || true`),
          sshExec(`cat ${tradeLog} 2>/dev/null || true`),
        ]);

        const { days, live } = mergeActivity(execText, tradeText);

        send('meta', { live, totalDays: days.length });

        // Stream one run at a time so the client can render cards as they arrive.
        for (const day of days) {
          for (const run of day.runs) {
            send('run', { date: day.date, run });
          }
          if (day.orphanTrades.length > 0) {
            send('orphans', { date: day.date, trades: day.orphanTrades });
          }
        }

        send('done', null);
      } catch (e: any) {
        send('error', { error: String(e?.message || e) });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
