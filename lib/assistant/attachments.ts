// SERVER-ONLY: attachment bytes and authoritative metadata. Chat transcripts
// hold opaque references only; provider adapters resolve bytes immediately
// before a request. Every write remains atomic like the other data/ stores.

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '@/lib/atomic-write';
import type { AttachmentKind, ChatAttachment, ChatTurn } from '@/lib/assistant/types';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;

const DIR = path.join(process.cwd(), 'data', 'assistant-attachments');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

const EXT_KIND: Record<string, AttachmentKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.csv': 'text', '.tsv': 'text',
  '.js': 'text', '.jsx': 'text', '.ts': 'text', '.tsx': 'text', '.py': 'text',
  '.sh': 'text', '.yaml': 'text', '.yml': 'text', '.xml': 'text', '.html': 'text',
  '.css': 'text', '.sql': 'text', '.log': 'text',
  '.doc': 'document', '.docx': 'document', '.rtf': 'document', '.ppt': 'document',
  '.pptx': 'document', '.odt': 'document',
  '.xls': 'spreadsheet', '.xlsx': 'spreadsheet', '.ods': 'spreadsheet',
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/html',
  'text/css', 'text/javascript', 'application/json', 'application/xml', 'text/xml',
  'application/javascript', 'application/x-yaml', 'text/yaml',
]);

function cleanName(value: string): string {
  const base = path.basename(value || 'attachment').replace(/[\u0000-\u001f\u007f]/g, '');
  return (base.trim() || 'attachment').slice(0, 160);
}

function kindFor(name: string, mimeType: string): AttachmentKind | null {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (TEXT_MIMES.has(mime) || mime.startsWith('text/')) return 'text';
  return EXT_KIND[path.extname(name).toLowerCase()] ?? null;
}

function normalizedMime(name: string, mimeType: string, kind: AttachmentKind): string {
  const current = mimeType.toLowerCase().split(';')[0].trim();
  if (current && current !== 'application/octet-stream') return current;
  const ext = path.extname(name).toLowerCase();
  if (kind === 'image') {
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
  }
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'text') return ext === '.json' ? 'application/json' : 'text/plain';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

function paths(id: string): { bytes: string; meta: string } {
  if (!ID_RE.test(id)) throw new Error('Invalid attachment id.');
  return {
    // Runtime user data must never become a Next build trace input.
    bytes: path.join(process.cwd(), 'data', 'assistant-attachments', /*turbopackIgnore: true*/ `${id}.bin`),
    meta: path.join(process.cwd(), 'data', 'assistant-attachments', /*turbopackIgnore: true*/ `${id}.json`),
  };
}

export function storeAttachment(input: {
  name: string;
  mimeType: string;
  bytes: Buffer;
}): ChatAttachment {
  const name = cleanName(input.name);
  const claimedMime = input.mimeType.toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  const kind = kindFor(name, claimedMime);
  if (!kind) throw new Error(`${name} is not a supported file type.`);
  const mimeType = normalizedMime(name, claimedMime, kind);
  if (input.bytes.length === 0) throw new Error(`${name} is empty.`);
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} exceeds the 7 MB per-file limit.`);
  }
  if (kind === 'text') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
    } catch {
      throw new Error(`${name} is not valid UTF-8 text.`);
    }
  }
  const id = randomUUID();
  const attachment: ChatAttachment = { id, name, mimeType, size: input.bytes.length, kind };
  const target = paths(id);
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(target.bytes, input.bytes);
  writeFileAtomic(target.meta, JSON.stringify(attachment));
  return attachment;
}

export interface ResolvedAttachment extends ChatAttachment {
  bytes: Buffer;
}

export function readAttachment(id: string): ResolvedAttachment {
  const target = paths(id);
  const parsed = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ target.meta, 'utf8')) as ChatAttachment;
  if (!parsed || parsed.id !== id || !kindFor(parsed.name, parsed.mimeType)) {
    throw new Error('Attachment metadata is invalid.');
  }
  const bytes = fs.readFileSync(/*turbopackIgnore: true*/ target.bytes);
  if (bytes.length !== parsed.size || bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attachment bytes do not match their metadata.');
  }
  return { ...parsed, bytes };
}

export function attachmentDisposition(attachment: ChatAttachment): 'inline' | 'attachment' {
  return attachment.kind === 'image' || attachment.kind === 'pdf' ? 'inline' : 'attachment';
}

/** Replace client claims with stored metadata and enforce one-message limits. */
export function resolveAttachmentRefs(
  refs: ChatAttachment[] | undefined,
  allowedKinds: readonly AttachmentKind[],
): ChatAttachment[] | undefined {
  if (!refs?.length) return undefined;
  if (refs.length > MAX_ATTACHMENTS) throw new Error(`Attach at most ${MAX_ATTACHMENTS} files.`);
  const seen = new Set<string>();
  const resolved: ChatAttachment[] = [];
  let total = 0;
  for (const ref of refs) {
    if (!ref || typeof ref.id !== 'string' || seen.has(ref.id)) continue;
    seen.add(ref.id);
    const { bytes: _bytes, ...meta } = readAttachment(ref.id);
    if (!allowedKinds.includes(meta.kind)) {
      throw new Error(`The selected model does not support ${meta.kind} attachments.`);
    }
    total += meta.size;
    resolved.push(meta);
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) throw new Error('Attachments exceed the 12 MB combined limit.');
  return resolved.length ? resolved : undefined;
}

/** The inline ceiling applies to the whole provider request, not each turn. */
export function enforceAttachmentRequestLimits(turns: ChatTurn[]): void {
  const unique = new Map<string, ChatAttachment>();
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) unique.set(attachment.id, attachment);
  }
  if (unique.size > MAX_ATTACHMENTS) {
    throw new Error(`This context contains more than ${MAX_ATTACHMENTS} files. Use /compact before adding more.`);
  }
  const total = [...unique.values()].reduce((sum, attachment) => sum + attachment.size, 0);
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('This context exceeds the 12 MB attachment limit. Use /compact before continuing.');
  }
}

export function deleteAttachment(id: string): boolean {
  const target = paths(id);
  let removed = false;
  for (const file of [target.bytes, target.meta]) {
    try {
      fs.unlinkSync(/*turbopackIgnore: true*/ file);
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}
