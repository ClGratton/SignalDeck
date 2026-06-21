// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the assistant's durable memory — short notes about the lab that
// outlive a chat ("jellyfin is a community LXC", "datapool degraded is known").
//
// Fully operator-visible: the sidebar lists every note and can delete any of
// them, and the assistant itself adds notes via the save_memory tool. Notes are
// injected into the system prompt, so they must stay short and few. Stored in
// data/assistant-memory.json (gitignored runtime state). Never store secrets.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';
import { randomUUID } from 'node:crypto';

export interface MemoryNote {
  id: string;
  text: string;
  createdAt: string;
}

const FILE = path.join(process.cwd(), 'data', 'assistant-memory.json');
const MAX_NOTES = 60;
const MAX_CHARS = 400;

let cached: MemoryNote[] | null = null;

function read(): MemoryNote[] {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    cached = Array.isArray(raw)
      ? raw.filter(
          (n): n is MemoryNote =>
            !!n &&
            typeof (n as MemoryNote).id === 'string' &&
            typeof (n as MemoryNote).text === 'string',
        )
      : [];
  } catch {
    cached = [];
  }
  return cached;
}

function write(notes: MemoryNote[]): void {
  try {
    writeFileAtomic(FILE, JSON.stringify(notes, null, 2));
  } catch {
    /* best-effort; memory cache still holds it */
  }
  cached = notes;
}

export function listMemories(): MemoryNote[] {
  return read();
}

export function addMemory(text: string): { ok: boolean; detail: string; note?: MemoryNote } {
  const trimmed = text.trim().slice(0, MAX_CHARS);
  if (trimmed.length < 3) return { ok: false, detail: 'Note is empty.' };
  const notes = read();
  if (notes.some((n) => n.text.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, detail: 'An identical note already exists.' };
  }
  if (notes.length >= MAX_NOTES) {
    return { ok: false, detail: `Memory is full (${MAX_NOTES} notes). Delete some first.` };
  }
  const note: MemoryNote = { id: randomUUID(), text: trimmed, createdAt: new Date().toISOString() };
  write([...notes, note]);
  return { ok: true, detail: 'Saved.', note };
}

/** Resolve a full id OR a short prefix (the prompt shows 8-char ids) to a note. */
function resolve(idOrPrefix: string): MemoryNote | undefined {
  const notes = read();
  return notes.find((n) => n.id === idOrPrefix) ?? notes.find((n) => n.id.startsWith(idOrPrefix));
}

export function deleteMemory(idOrPrefix: string): boolean {
  const target = resolve(idOrPrefix);
  if (!target) return false;
  write(read().filter((n) => n.id !== target.id));
  return true;
}

/** Correct a note in place (the assistant fixing a fact it found to be wrong). */
export function updateMemory(idOrPrefix: string, text: string): { ok: boolean; detail: string } {
  const target = resolve(idOrPrefix);
  if (!target) return { ok: false, detail: 'No memory note matches that id.' };
  const trimmed = text.trim().slice(0, MAX_CHARS);
  if (trimmed.length < 3) return { ok: false, detail: 'New text is empty.' };
  write(read().map((n) => (n.id === target.id ? { ...n, text: trimmed } : n)));
  return { ok: true, detail: 'Updated.' };
}
