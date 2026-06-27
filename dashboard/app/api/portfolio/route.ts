import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { callTool, resetSession } from '@/lib/mcpClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const accountId = config.accountId;
  if (!accountId) {
    return NextResponse.json({ error: 'ACCOUNT_ID not set in Makefile.local' }, { status: 500 });
  }

  try {
    // Round 1 — three independent calls in parallel.
    const [portfolio, positions, orders] = await Promise.all([
      callTool('get_portfolio',       { account_number: accountId }),
      callTool('get_equity_positions', { account_number: accountId }),
      callTool('get_equity_orders',   { account_number: accountId, states: ['queued', 'confirmed', 'partially_filled', 'cancelled', 'filled'], limit: 20 }),
    ]);

    // Extract symbols from positions for round 2.
    const posResults: Array<{ symbol: string }> =
      (positions as any)?.results ?? [];
    const symbols = [...new Set(posResults.map((p) => p.symbol))];

    // Round 2 — quotes + per-symbol historicals in parallel.
    const round2: Array<Promise<unknown>> = [];
    if (symbols.length > 0) {
      round2.push(callTool('get_equity_quotes', { symbols }));
      for (const sym of symbols) {
        round2.push(callTool('get_equity_historicals', {
          symbol: sym, interval: '5minute', span: 'day', account_number: accountId,
        }));
      }
    }
    const round2Results = await Promise.all(round2);

    // Unpack round 2 results.
    let quotes: unknown = { results: [] };
    const historicals: Record<string, unknown> = {};
    if (symbols.length > 0) {
      quotes = round2Results[0];
      symbols.forEach((sym, i) => {
        historicals[sym] = round2Results[i + 1];
      });
    }

    return NextResponse.json({
      portfolio, positions, orders, quotes, historicals,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    // Reset session on auth/network errors so next request re-initialises.
    resetSession();
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
