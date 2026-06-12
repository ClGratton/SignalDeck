// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: inline action decisions for the continuous agent loop.
//
// When an agent-mode action needs confirmation, the streaming turn emits a
// `confirm` event and AWAITS the operator's Run/Skip here (the HTTP stream stays
// open). The client posts the decision to /api/assistant/decide, which resolves
// the waiter and the same loop resumes — so the agent keeps going on its own,
// pausing only as long as it takes to get a yes/no.
//
// Per-process, single-instance (same accepted limit as the login throttle).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

export type Decision = 'run' | 'skip';

const waiters = new Map<string, (d: Decision) => void>();
const DECISION_TTL_MS = 5 * 60_000;

/** Await the operator's decision for one action. Resolves 'skip' on timeout or
 *  when the request is aborted (tab closed / Stop pressed). */
export function awaitDecision(id: string, signal?: AbortSignal): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    let settled = false;
    const finish = (d: Decision) => {
      if (settled) return;
      settled = true;
      waiters.delete(id);
      clearTimeout(timer);
      resolve(d);
    };
    const timer = setTimeout(() => finish('skip'), DECISION_TTL_MS);
    waiters.set(id, finish);
    if (signal) {
      if (signal.aborted) finish('skip');
      else signal.addEventListener('abort', () => finish('skip'), { once: true });
    }
  });
}

/** Resolve a pending decision from /api/assistant/decide. Returns false if the
 *  id is unknown (already decided, expired, or never existed). */
export function submitDecision(id: string, decision: Decision): boolean {
  const w = waiters.get(id);
  if (!w) return false;
  w(decision);
  return true;
}
