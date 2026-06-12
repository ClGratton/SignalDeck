import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { submitDecision } from '@/lib/assistant/decisions';

export const runtime = 'nodejs';

/** PRIVILEGED: resolve ONE inline agent-mode action the operator approved or
 *  skipped. The matching turn (a still-open /api/assistant stream) resumes. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { id?: unknown; decision?: unknown };
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
  const accepted = submitDecision(id, decision);
  if (!accepted) {
    return NextResponse.json(
      { ok: false, detail: 'That action is no longer waiting (expired or already decided).' },
      { status: 410 },
    );
  }
  return NextResponse.json({ ok: true });
}
