// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: in-memory store of action proposals awaiting user confirmation.
//
// The assistant NEVER executes an action. Calling an action tool only registers
// a proposal here; the executable closure stays server-side, and the client gets
// a ProposalCard. Execution happens only when the signed-in operator clicks
// Confirm, which consumes the proposal (single-use) via /api/assistant/execute.
//
// Per-process state, same accepted limit as the login throttle (single-instance
// deploy — see CLAUDE.md "Known accepted limits").
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { randomUUID } from 'node:crypto';
import type { ProposalCard } from '@/lib/assistant/types';

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 20;

interface StoredProposal extends ProposalCard {
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const store = new Map<string, StoredProposal>();

function sweep() {
  const now = Date.now();
  for (const [id, p] of store) {
    if (p.expiresAt <= now) store.delete(id);
  }
}

export function addProposal(
  title: string,
  detail: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
): ProposalCard {
  sweep();
  // Cap pending proposals so a runaway turn can't grow the map unbounded.
  while (store.size >= MAX_PENDING) {
    const oldest = store.keys().next().value;
    if (oldest == null) break;
    store.delete(oldest);
  }
  const card: ProposalCard = {
    id: randomUUID(),
    title,
    detail,
    expiresAt: Date.now() + TTL_MS,
  };
  store.set(card.id, { ...card, run });
  return card;
}

/** Single-use: returns and removes the proposal, or null if unknown/expired. */
export function consumeProposal(id: string): StoredProposal | null {
  sweep();
  const p = store.get(id) ?? null;
  if (p) store.delete(id);
  return p;
}
