// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: the persisted dashboard layout (one shared layout — single-user
// gate, like the chat store). Stored in data/dashboard-layout.json (gitignored).
//
// Writes go through writeFileAtomic (see lib/atomic-write.ts — load-bearing). The
// mem cache re-reads on mtime change so every worker instance converges on the
// one file (same discipline as the session/auth stores).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';
import { DEFAULT_LAYOUT, normalizeLayout, type DashboardLayout } from '@/lib/dashboard/types';

const FILE = path.join(process.cwd(), 'data', 'dashboard-layout.json');

let mem: DashboardLayout | null = null;
let memMtime = -1;

function fileMtimeMs(): number {
  try {
    return fs.statSync(FILE).mtimeMs;
  } catch {
    return 0;
  }
}

/** The stored layout, or the default when nothing is saved yet. */
export function getLayout(): DashboardLayout {
  const mtime = fileMtimeMs();
  if (mem && mtime === memMtime) return mem;
  if (mtime === 0) {
    // No file yet — serve the default but DON'T cache it as if persisted.
    mem = DEFAULT_LAYOUT;
    memMtime = 0;
    return mem;
  }
  try {
    mem = normalizeLayout(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    mem = DEFAULT_LAYOUT;
  }
  memMtime = mtime;
  return mem;
}

/** Persist a layout (normalized first). Returns the normalized result. */
export function setLayout(raw: unknown): DashboardLayout {
  const layout = normalizeLayout(raw);
  writeFileAtomic(FILE, JSON.stringify(layout, null, 2));
  mem = layout;
  memMtime = fileMtimeMs();
  return layout;
}

/** Reset to the default (delete the override). */
export function resetLayout(): DashboardLayout {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already gone */
  }
  mem = DEFAULT_LAYOUT;
  memMtime = 0;
  return DEFAULT_LAYOUT;
}
