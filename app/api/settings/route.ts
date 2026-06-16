import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import { SERVICE_FIELDS, fieldSource, setOverride, revealField } from '@/lib/service-config';

export const runtime = 'nodejs';

// PRIVILEGED: the dashboard Settings section for backend credentials.
// GET lists the field catalog with each field's SOURCE only (never the value —
// reveal is a separate re-auth-gated route). POST writes an override.

export async function GET() {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const fields = SERVICE_FIELDS.map((f) => ({
    name: f.name,
    label: f.label,
    group: f.group,
    secret: f.secret,
    placeholder: f.placeholder,
    privilegedForActions: f.privilegedForActions === true,
    // Control hints for the panel (toggle / slider) — all non-sensitive metadata.
    control: f.control,
    boolDefault: f.boolDefault,
    min: f.min,
    max: f.max,
    step: f.step,
    unit: f.unit,
    numDefault: f.numDefault,
    zeroLabel: f.zeroLabel,
    source: fieldSource(f.name),
    // Non-secret values (host URLs, ports, zone ids, step cap) are safe to show
    // the authenticated operator directly — no eye/re-auth dance for a hostname.
    // Secret values are NEVER included here; they stay behind the reveal route.
    value: f.secret ? undefined : (revealField(f.name) ?? undefined),
  }));
  return NextResponse.json({ fields }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { name?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (typeof body.name !== 'string' || typeof body.value !== 'string') {
    return NextResponse.json({ error: 'name and value are required' }, { status: 400 });
  }
  const problem = setOverride(body.name, body.value);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  return NextResponse.json({ ok: true, source: fieldSource(body.name) });
}
