// ─────────────────────────────────────────────────────────────────────────────
// Sanitized aggregate health shape for the public landing.
//
// This module is CLIENT-SAFE: it holds only types and pure helpers (no secrets,
// no server-only imports), so client components can import `loadLevel` and the
// types. The actual fan-out to the real backends lives in lib/status-source.ts
// (server-only). Everything here is readable by anyone who loads the front page.
// ─────────────────────────────────────────────────────────────────────────────

import type { SystemHealth } from '@/lib/config';

export type HealthLevel = 'operational' | 'partial' | 'degraded';

export interface SystemEntry {
  name: string;
  health: SystemHealth;
  /** Pre-formatted uptime label, e.g. "31d", or "" when the backend can't report it. */
  uptimeLabel: string;
}

export interface AggregateStatus {
  level: HealthLevel;
  services: {
    total: number;
    healthy: number;
    affected: number;
  };
  /** Seconds since the lab last came up. */
  uptimeSeconds: number;
  /** Aggregate compute load 0–100 (CPU pressure across the cluster). Non-identifying. */
  load: number;
  /** Per-system health for the status popover. */
  systems: SystemEntry[];
  /** ISO timestamp of this check. */
  checkedAt: string;
}

/** Load thresholds → health color. Shared so the tile and any future gauge agree. */
export function loadLevel(load: number): HealthLevel {
  if (load >= 85) return 'degraded';
  if (load >= 60) return 'partial';
  return 'operational';
}
