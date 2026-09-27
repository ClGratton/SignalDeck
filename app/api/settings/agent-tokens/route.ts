import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { authorizeReveal } from '@/lib/reauth';
import { listAgentTokens, mintAgentToken, revokeAgentToken } from '@/lib/agent-tokens';
import { recentAgentCalls } from '@/lib/agent-audit';
import { cfg } from '@/lib/service-config';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** PRIVILEGED: the external-agent tokens (metadata only — never a token or hash),
 *  the configured LAN endpoint (for the setup snippets), and the recent audit
 *  trail of their calls. */
export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.json(
    { tokens: listAgentTokens(), endpoint: cfg('AGENT_MCP_URL')?.trim() || null, calls: recentAgentCalls(50) },
    { headers: NO_STORE },
  );
}

/** PRIVILEGED + RE-AUTH GATED: mint a token. A token grants full, approval-free
 *  lab access over the LAN MCP endpoint, so minting needs a fresh password + TOTP
 *  (or a live reveal grant) on top of the session. The plaintext is returned ONCE
 *  as `value` (the reveal-flow shape) and never again. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { name?: unknown; password?: unknown; code?: unknown; grant?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const auth = await authorizeReveal(body);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error ?? 'Re-authentication failed.' }, { status: 403 });
  }
  let minted;
  try {
    minted = mintAgentToken(typeof body.name === 'string' ? body.name : '');
  } catch {
    return NextResponse.json({ error: 'Could not save the token (data/ not writable).' }, { status: 500 });
  }
  if ('error' in minted) return NextResponse.json({ error: minted.error }, { status: 400 });
  return NextResponse.json({ value: minted.token, grant: auth.grant }, { headers: NO_STORE });
}

/** PRIVILEGED: revoke one token by id. Takes effect on its next call. */
export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.id !== 'string' || !/^[\w-]{1,64}$/.test(body.id)) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }
  let ok: boolean;
  try {
    ok = revokeAgentToken(body.id);
  } catch {
    return NextResponse.json({ error: 'Could not save (data/ not writable).' }, { status: 500 });
  }
  return NextResponse.json({ ok }, { headers: NO_STORE });
}
