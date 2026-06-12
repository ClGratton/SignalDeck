import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { consumeProposal } from '@/lib/assistant/proposals';

export const runtime = 'nodejs';

/** PRIVILEGED + CONFIRM-GATED: executes ONE previously proposed action.
 *  The proposal id is single-use and expires after 5 minutes; the executable
 *  closure never leaves the server. This is the only path from the assistant
 *  to a real mutation on the homelab. */
export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let id = '';
  try {
    const body = (await req.json()) as { id?: string };
    id = typeof body.id === 'string' ? body.id : '';
  } catch {
    /* fall through to the invalid-id response */
  }
  if (!id) return NextResponse.json({ error: 'missing proposal id' }, { status: 400 });

  const proposal = consumeProposal(id);
  if (!proposal) {
    return NextResponse.json(
      { ok: false, detail: 'Proposal expired or already handled. Ask the assistant again.' },
      { status: 410 },
    );
  }
  const result = await proposal.run();
  console.warn(`[assistant] action ${result.ok ? 'executed' : 'FAILED'}: ${proposal.title}`);
  return NextResponse.json(result);
}
