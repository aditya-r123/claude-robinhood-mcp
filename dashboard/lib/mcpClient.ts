import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MCP_URL = 'https://agent.robinhood.com/mcp/trading';

// ── keychain read ──────────────────────────────────────────────────────────

interface RawCreds {
  claudeAiOauth?: unknown;
  mcpOAuth?: Record<string, McpOAuthEntry>;
}

interface McpOAuthEntry {
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Reuse in-process token until it expires (saves a keychain read per poll).
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const { stdout } = await execFileAsync('security', [
    'find-generic-password', '-s', 'Claude Code-credentials', '-w',
  ], { timeout: 5_000 });

  const raw: RawCreds = JSON.parse(stdout.trim());
  const mcpOAuth = raw.mcpOAuth ?? {};
  const entry = Object.values(mcpOAuth).find((e) =>
    e.serverUrl?.includes('agent.robinhood.com'),
  );
  if (!entry) throw new Error('Robinhood MCP credentials not found in keychain');

  tokenCache = { token: entry.accessToken, expiresAt: entry.expiresAt };
  return entry.accessToken;
}

// ── MCP session (reuse across polls to avoid re-initialising every 5s) ────

let sessionId: string | null = null;

async function ensureSession(token: string): Promise<string> {
  if (sessionId) return sessionId;

  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'quant-pod-dashboard', version: '1.0' },
      },
    }),
  });

  const sid = resp.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  await drain(resp); // consume body
  return sessionId ?? '';
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function headers(token: string, sid?: string) {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json, text/event-stream',
  };
  if (sid) h['Mcp-Session-Id'] = sid;
  return h;
}

async function drain(resp: Response): Promise<void> {
  try { await resp.text(); } catch { /* ignore */ }
}

// Parse either application/json or text/event-stream MCP response.
async function parseResp(resp: Response, id: number): Promise<unknown> {
  const ct = resp.headers.get('content-type') ?? '';
  const text = await resp.text();

  if (ct.includes('event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const msg = JSON.parse(line.slice(6));
        if (msg.id === id) {
          if (msg.error) throw new Error(JSON.stringify(msg.error));
          return msg.result;
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
    throw new Error(`No result for id=${id} in SSE stream`);
  }

  const msg = JSON.parse(text);
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  return msg.result;
}

// ── public API ─────────────────────────────────────────────────────────────

let _id = 1;
const nextId = () => _id++;

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const token = await getAccessToken();
  const sid = await ensureSession(token);
  const id = nextId();

  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: headers(token, sid || undefined),
    body: JSON.stringify({
      jsonrpc: '2.0', id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  return parseResp(resp, id);
}

// Reset session (called on auth error so next request re-initialises).
export function resetSession() {
  sessionId = null;
  tokenCache = null;
}
