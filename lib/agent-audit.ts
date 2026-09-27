// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: audit trail of every lab tool call made by an EXTERNAL agent over
// the MCP endpoint. Not an approval — the agent's own harness (Claude Code /
// Codex permission modes) is the approval for these calls, by the owner's
// choice. This is the after-the-fact record of what each token did.
//
// Bounded ring in data/agent-audit.json (writeFileAtomic). Request details are
// clipped; secrets must never be in them (the tools don't take credentials).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@/lib/atomic-write';

export interface AgentAuditEntry {
  at: number;
  tokenId: string;
  tokenName: string;
  tool: string;
  /** What was requested (command / method+path), clipped. */
  request: string;
  ok: boolean;
  ms: number;
}

const FILE = path.join(process.cwd(), 'data', 'agent-audit.json');
const MAX_ENTRIES = 1000;

function read(): AgentAuditEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as AgentAuditEntry[]) : [];
  } catch {
    return [];
  }
}

export function recordAgentCall(entry: AgentAuditEntry): void {
  const list = read();
  list.push({ ...entry, request: entry.request.slice(0, 300) });
  try {
    writeFileAtomic(FILE, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch (err) {
    console.error('[agent-audit] write failed:', (err as Error)?.message ?? err);
  }
}

/** Newest first. */
export function recentAgentCalls(limit = 100): AgentAuditEntry[] {
  return read().slice(-limit).reverse();
}
