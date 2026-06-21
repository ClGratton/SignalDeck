'use client';

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard WIDGET REGISTRY. Each existing console panel is registered here
// as a widget so the grid + the (future) picker treat them uniformly — adding a
// service means adding ONE entry, never editing the layout. A widget is pure
// metadata + a Body component; the Body pulls whatever data it needs from the
// shared DashboardData context (or self-fetches, like Traffic/History).
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, type ComponentType } from 'react';
import { Cpu, HardDrive, Play, Home, Activity, CalendarDays, type LucideIcon } from 'lucide-react';
import type { ConsoleSnapshot } from '@/lib/console';
import {
  ComputePanel,
  StoragePanel,
  MediaPanel,
  AutomationPanel,
  TrafficPanel,
  HistoryStrip,
} from './panels';

// Shared data for the data-driven widgets (the snapshot + first-load flag). Kept
// out of each widget's props so the registry stays a flat list of components.
interface DashboardData {
  snapshot: ConsoleSnapshot | null;
  loading: boolean;
}
const DataCtx = createContext<DashboardData>({ snapshot: null, loading: true });
export function DashboardDataProvider({
  value,
  children,
}: {
  value: DashboardData;
  children: React.ReactNode;
}) {
  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}
export const useDashboardData = () => useContext(DataCtx);

export interface WidgetDef {
  /** Stable widget id, referenced by Tile.widget. NEVER reuse for a new widget. */
  id: string;
  name: string;
  Icon: LucideIcon;
  /** Default cell span when first added from the picker. */
  defaultW: number;
  defaultH: number;
  /** Resize floor (the Android-style handles won't shrink past this). */
  minW: number;
  minH: number;
  /** The tile contents. Pulls its own data from context / providers. */
  Body: ComponentType;
}

const ComputeBody = () => {
  const { snapshot, loading } = useDashboardData();
  return <ComputePanel data={snapshot?.proxmox ?? null} loading={loading} />;
};
const StorageBody = () => {
  const { snapshot, loading } = useDashboardData();
  return <StoragePanel data={snapshot?.truenas ?? null} loading={loading} />;
};
const MediaBody = () => {
  const { snapshot, loading } = useDashboardData();
  return <MediaPanel data={snapshot?.jellyfin ?? null} loading={loading} />;
};
const AutomationBody = () => {
  const { snapshot, loading } = useDashboardData();
  return <AutomationPanel data={snapshot?.homeassistant ?? null} loading={loading} />;
};

export const WIDGETS: WidgetDef[] = [
  { id: 'compute', name: 'Compute', Icon: Cpu, defaultW: 2, defaultH: 1, minW: 1, minH: 1, Body: ComputeBody },
  { id: 'storage', name: 'Storage', Icon: HardDrive, defaultW: 1, defaultH: 1, minW: 1, minH: 1, Body: StorageBody },
  { id: 'media', name: 'Media', Icon: Play, defaultW: 1, defaultH: 1, minW: 1, minH: 1, Body: MediaBody },
  { id: 'automation', name: 'Automation', Icon: Home, defaultW: 1, defaultH: 1, minW: 1, minH: 1, Body: AutomationBody },
  { id: 'traffic', name: 'Traffic', Icon: Activity, defaultW: 1, defaultH: 1, minW: 1, minH: 1, Body: TrafficPanel },
  { id: 'history', name: 'History', Icon: CalendarDays, defaultW: 3, defaultH: 1, minW: 1, minH: 1, Body: HistoryStrip },
];

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));
export const widgetById = (id: string): WidgetDef | undefined => BY_ID.get(id);
