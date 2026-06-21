// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SAFE: the dashboard layout model (no node:*, no React) — importable by
// the client grid AND the server store/route.
//
// The dashboard is a tile grid: `cols` × `rows` cells, and each tile occupies a
// rectangle of cells at (x, y) spanning (w, h). This is the Android-home-screen
// model (fixed cells, widgets span them), chosen so "resize a widget" means
// "change its cell span" and "add a column/row" means "grow the grid" — both
// trivially serializable and consistent across devices.
// ─────────────────────────────────────────────────────────────────────────────

export interface Tile {
  /** Stable per-tile id (so a tile keeps its identity across edits/reorders). */
  id: string;
  /** Which registered widget renders here (WidgetDef.id). */
  widget: string;
  x: number; // 0-based column of the top-left cell
  y: number; // 0-based row of the top-left cell
  w: number; // column span (>= 1)
  h: number; // row span (>= 1)
}

export interface DashboardLayout {
  cols: number;
  rows: number;
  tiles: Tile[];
}

export const GRID_LIMITS = { minCols: 1, maxCols: 8, minRows: 1, maxRows: 16 } as const;

// The DEFAULT layout reproduces the original fixed dashboard exactly (3 cols):
//   compute(2×1) storage(1×1)
//   media(1×1)  automation(1×1)  traffic(1×1)
//   history(3×1)
export const DEFAULT_LAYOUT: DashboardLayout = {
  cols: 3,
  rows: 3,
  tiles: [
    { id: 't-compute', widget: 'compute', x: 0, y: 0, w: 2, h: 1 },
    { id: 't-storage', widget: 'storage', x: 2, y: 0, w: 1, h: 1 },
    { id: 't-media', widget: 'media', x: 0, y: 1, w: 1, h: 1 },
    { id: 't-automation', widget: 'automation', x: 1, y: 1, w: 1, h: 1 },
    { id: 't-traffic', widget: 'traffic', x: 2, y: 1, w: 1, h: 1 },
    { id: 't-history', widget: 'history', x: 0, y: 2, w: 3, h: 1 },
  ],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Coerce arbitrary JSON into a sound layout: clamp the grid size, keep only
 *  well-formed tiles, and fit each tile inside the grid (drop ones that can't
 *  fit). Never throws — a corrupt/edited file degrades to the default. */
export function normalizeLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT;
  const o = raw as Record<string, unknown>;
  const cols = clamp(Number(o.cols), GRID_LIMITS.minCols, GRID_LIMITS.maxCols) || DEFAULT_LAYOUT.cols;
  const rows = clamp(Number(o.rows), GRID_LIMITS.minRows, GRID_LIMITS.maxRows) || DEFAULT_LAYOUT.rows;
  const tilesIn = Array.isArray(o.tiles) ? o.tiles : [];
  const tiles: Tile[] = [];
  const seen = new Set<string>();
  for (const t of tilesIn) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const widget = typeof r.widget === 'string' ? r.widget : '';
    if (!id || !widget || seen.has(id)) continue;
    const w = clamp(Number(r.w), 1, cols);
    const h = clamp(Number(r.h), 1, rows);
    const x = clamp(Number(r.x), 0, cols - w);
    const y = clamp(Number(r.y), 0, rows - h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    seen.add(id);
    tiles.push({ id, widget, x, y, w, h });
  }
  return { cols, rows, tiles };
}
