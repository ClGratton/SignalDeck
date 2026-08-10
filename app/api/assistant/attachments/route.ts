import { NextResponse, type NextRequest } from 'next/server';
import { hasValidSession } from '@/lib/session';
import {
  deleteAttachment,
  attachmentDisposition,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  readAttachment,
  storeAttachment,
} from '@/lib/assistant/attachments';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (!(await hasValidSession())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart file data.' }, { status: 400 });
  }
  const files = form.getAll('files').filter((value): value is File => value instanceof File);
  if (files.length === 0 || files.length > MAX_ATTACHMENTS) {
    return NextResponse.json({ error: `Upload 1-${MAX_ATTACHMENTS} files at a time.` }, { status: 400 });
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) {
    return NextResponse.json({ error: 'Attachments exceed the 12 MB combined limit.' }, { status: 413 });
  }
  const attachments = [];
  try {
    for (const file of files) {
      attachments.push(storeAttachment({
        name: file.name,
        mimeType: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      }));
    }
    return NextResponse.json({ attachments });
  } catch (error) {
    for (const attachment of attachments) {
      try { deleteAttachment(attachment.id); } catch { /* best-effort rollback */ }
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed.' },
      { status: 400 },
    );
  }
}

export async function GET(req: NextRequest) {
  if (!(await hasValidSession())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id') ?? '';
  try {
    const attachment = readAttachment(id);
    return new Response(new Uint8Array(attachment.bytes), {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Disposition': `${attachmentDisposition(attachment)}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Attachment not found.' }, { status: 404 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await hasValidSession())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  let id = '';
  try {
    const body = (await req.json()) as { id?: unknown };
    if (typeof body.id === 'string') id = body.id;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  try {
    return NextResponse.json({ removed: deleteAttachment(id) });
  } catch {
    return NextResponse.json({ error: 'Attachment could not be removed.' }, { status: 400 });
  }
}
