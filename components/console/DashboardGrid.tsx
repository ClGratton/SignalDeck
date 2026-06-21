'use client';

// Renders a DashboardLayout: a CSS grid of `cols` columns, each tile placed at
// its (x,y) spanning (w,h) cells. Phase 1 is render-only (no editing yet); the
// visual result matches the original fixed dashboard because the default layout
// reproduces it. On narrow screens the grid collapses to one column and tiles
// stack in layout order (the editable grid is a desktop affordance).

import { widgetById } from './widgets';
import type { DashboardLayout } from '@/lib/dashboard/types';
import styles from './console.module.css';

export function DashboardGrid({ layout }: { layout: DashboardLayout }) {
  return (
    <div
      className={styles.dashGrid}
      style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
      aria-label="Homelab widgets"
    >
      {layout.tiles.map((t) => {
        const widget = widgetById(t.widget);
        if (!widget) return null; // unknown widget id (e.g. a removed service) — skip
        const Body = widget.Body;
        return (
          <div
            key={t.id}
            className={styles.dashTile}
            style={{
              gridColumn: `${t.x + 1} / span ${t.w}`,
              gridRow: `${t.y + 1} / span ${t.h}`,
            }}
          >
            <Body />
          </div>
        );
      })}
    </div>
  );
}
