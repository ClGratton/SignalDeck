// SERVER-ONLY: small, owner-tunable knobs for the assistant, read from the same
// override store as backend creds (data/service-config.json) so they're editable
// from Settings without a restart. Not secrets.

import 'server-only';
import { cfg } from '@/lib/service-config';

const DEFAULT_MAX_STEPS = 60;

/** Tool steps the agent may take in one turn before pausing to ask you to
 *  continue. Configurable via Settings (ASSISTANT_MAX_STEPS); clamped to a sane
 *  range so a typo can't wedge a turn forever or end it after one step. */
export function maxAgentSteps(): number {
  const n = Number(cfg('ASSISTANT_MAX_STEPS'));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_STEPS;
  return Math.min(Math.floor(n), 200);
}
