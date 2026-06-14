import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { submitDecision, isReauthRequired } from '@/lib/assistant/decisions';
import { grantElevation, reverifyCredentials } from '@/lib/reauth';

export const runtime = 'nodejs';

/** PRIVILEGED: resolve ONE inline agent-mode action the operator approved or
 *  skipped. The matching turn (a still-open /api/assistant stream) resumes.
 *
 *  Destructive (blacklisted) actions require a FRESH re-auth: running one means
 *  the body must carry password + TOTP, which we verify here before resolving
 *  'run' and opening the 30-minute elevation window. A bad/absent credential is
 *  rejected WITHOUT resolving, so the action stays paused and the operator can
 *  retry. 'skip' never needs credentials. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { id?: unknown; decision?: unknown; password?: unknown; code?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const decision = body.decision === 'run' || body.decision === 'skip' ? body.decision : null;
  if (!id || !decision) {
    return NextResponse.json({ error: 'id and decision are required' }, { status: 400 });
  }

  // A destructive action's 'run' must be backed by fresh credentials.
  if (decision === 'run' && isReauthRequired(id)) {
    const res = await reverifyCredentials(String(body.password ?? ''), String(body.code ?? ''));
    if (!res.ok) {
      // Don't resolve — leave the action paused so the operator can retry.
      return NextResponse.json(
        { ok: false, error: res.error ?? 'Re-authentication failed.', retryAfter: res.retryAfter },
        { status: 401 },
      );
    }
    grantElevation(); // open the window before resuming the turn
  }

  const accepted = submitDecision(id, decision);
  if (!accepted) {
    return NextResponse.json(
      { ok: false, detail: 'That action is no longer waiting (expired or already decided).' },
      { status: 410 },
    );
  }
  return NextResponse.json({ ok: true });
}
