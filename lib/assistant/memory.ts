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
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(notes, null, 2), 'utf8');
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

export function deleteMemory(id: string): boolean {
  const notes = read();
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) return false;
  write(next);
  return true;
}
