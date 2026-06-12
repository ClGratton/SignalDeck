// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: builds the sanitized AggregateStatus from real homelab telemetry,
// falling back to static placeholders when the backends are unreachable. Kept out
// of lib/status.ts so the (client-imported) types/helpers there never pull in the
// node:http probes in lib/homelab.ts.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import { getHomelabSummary, peekHomelabSummary, type HomelabSummary } from '@/lib/homelab';
import { systems as configSystems } from '@/lib/config';
import type { AggregateStatus, HealthLevel, SystemEntry } from '@/lib/status';

function daysLabel(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  if (d >= 1) return `${d}d`;
  return `${Math.floor(seconds / 3600)}h`;
}

// Placeholder "up since", used only when Proxmox is unreachable.
const BOOT_EPOCH_MS = Date.UTC(2026, 0, 18, 4, 12, 0);

function levelFor(affected: number): HealthLevel {
  if (affected === 0) return 'operational';
  if (affected <= 2) return 'partial';
  return 'degraded';
}

function toAggregate(summary: HomelabSummary | null): AggregateStatus {
  if (summary) {
    return {
      level: summary.level,
      services: summary.services,
      uptimeSeconds: summary.uptimeSeconds,
      load: summary.load,
      systems: summary.systems.map((s) => ({
        name: s.name,
        health: s.health,
        uptimeLabel: s.uptimeSeconds != null ? daysLabel(s.uptimeSeconds) : '',
      })),
      checkedAt: new Date().toISOString(),
    };
  }

  // Unreachable/unconfigured: fall back to the static placeholders.
  const fallbackSystems: SystemEntry[] = configSystems.map((s) => ({
    name: s.name,
    health: s.health,
    uptimeLabel: s.uptime,
  }));
  const affected = fallbackSystems.filter((s) => s.health !== 'ok').length;
  return {
    level: levelFor(affected),
    services: { total: 12, healthy: 12 - affected, affected },
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - BOOT_EPOCH_MS) / 1000)),
    load: 38,
    systems: fallbackSystems,
    checkedAt: new Date().toISOString(),
  };
}

export async function getAggregateStatus(): Promise<AggregateStatus> {
  return toAggregate(await getHomelabSummary());
}

/**
 * Never-blocking variant for the root layout: shapes whatever the homelab
 * cache holds right now (placeholders on a cold start) and lets the
 * background refresh + client polling deliver real data moments later.
 */
export function peekAggregateStatus(): AggregateStatus {
  return toAggregate(peekHomelabSummary());
}
