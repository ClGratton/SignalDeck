import { NextResponse, type NextRequest } from 'next/server';
import { verifyAgentToken } from '@/lib/agent-tokens';
import { recordAgentCall } from '@/lib/agent-audit';
import { MCP_TOOLS, callMcpTool, describeCall, mcpInstructions } from '@/lib/agent-mcp';
import { agentNetworks, isLocalRequest } from '@/lib/agent-network';
import { cfg } from '@/lib/service-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// LAN-ONLY: the lab tools as an MCP server (Streamable HTTP, stateless JSON
// responses) for Claude Code / Codex on the owner's desktops. Not session-gated —
// the per-agent bearer token (lib/agent-tokens.ts) IS the credential, like the QR
// redeem route. No server-side approval by the owner's explicit choice (see
// CLAUDE.md "External agents" and lib/agent-mcp.ts).
//
// "Local only" is enforced in layers; the in-app ones are:
//   0. The Settings kill switch (AGENT_MCP_ENABLED) — off ⇒ the route 404s.
//   1. Any request that came through Cloudflare (cf-connecting-ip / cf-ray are
//      always set by Cloudflare and a client cannot strip them) gets a 404, so
//      the public hostname can never reach this route.
//   2. Every forwarded hop must be inside the allowed networks (default: private
//      ranges; lib/agent-network.ts) — catches internet requests that reach the
//      origin WITHOUT Cloudflare (e.g. straight to a port-forwarded proxy).
//   3. Any request with an Origin header is refused — CLI MCP clients send none,
//      so this blocks browsers (incl. DNS rebinding against a LAN address).
//   4. A valid, unrevoked agent token.
// Outside the app: a Cloudflare WAF rule blocking /api/agent/* at the edge, and
// the LAN route / firewall allow-listing the desktops (DEPLOY-AGENT-MCP.md).

const SERVER_INFO = { name: 'grtlabs', title: 'Grtlabs homelab', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

const NO_STORE = { 'Cache-Control': 'private, no-store' };

const enabled = () => !/^(false|0|no|off)$/i.test((cfg('AGENT_MCP_ENABLED') ?? '').trim());

/** Requests this route pretends not to exist for: switched off, or not local. */
function hidden(req: NextRequest): boolean {
  if (!enabled()) return true;
  if (req.headers.has('cf-connecting-ip') || req.headers.has('cf-ray')) return true;
  return !isLocalRequest(req.headers, agentNetworks(cfg('AGENT_MCP_ALLOWED_NETWORKS')));
}

function bearer(req: NextRequest): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  return m ? m[1] : null;
}

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

async function handle(msg: JsonRpcMessage, token: { id: string; name: string }): Promise<object | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  }
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: mcpInstructions(),
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (!MCP_TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (
        params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      ) as Record<string, unknown>;
      const started = Date.now();
      let result;
      try {
        result = await callMcpTool(name, args);
      } catch (err) {
        result = {
          content: [{ type: 'text' as const, text: `Tool failed: ${(err as Error)?.message ?? 'error'}` }],
          isError: true,
        };
      }
      recordAgentCall({
        at: started,
        tokenId: token.id,
        tokenName: token.name,
        tool: name,
        request: describeCall(name, args),
        ok: !result.isError,
        ms: Date.now() - started,
      });
      return rpcResult(id, result);
    }
    default:
      // Notifications (initialized, cancelled, …) need no reply.
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(req: NextRequest) {
  if (hidden(req)) return new NextResponse(null, { status: 404 });
  if (req.headers.has('origin')) {
    return NextResponse.json({ error: 'browser requests are not accepted' }, { status: 403, headers: NO_STORE });
  }
  const token = verifyAgentToken(bearer(req));
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, 'Parse error'), { status: 400, headers: NO_STORE });
  }

  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcMessage[];
  const replies = (await Promise.all(messages.map((m) => handle(m ?? {}, token)))).filter(
    (r): r is object => r != null,
  );
  // Only notifications → 202 with no body (Streamable HTTP spec).
  if (replies.length === 0) return new NextResponse(null, { status: 202, headers: NO_STORE });
  return NextResponse.json(batch ? replies : replies[0], { headers: NO_STORE });
}

// Stateless server: no server-initiated SSE stream and no sessions to delete.
export async function GET(req: NextRequest) {
  if (hidden(req)) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

export async function DELETE(req: NextRequest) {
  if (hidden(req)) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}
