// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SAFE: the tile reflow engine — pure functions, no React/DOM, so it's
// unit-testable and shared by BOTH drag-move and resize.
//
// Model: "push down + compact up" (the Android / react-grid-layout feel the
// operator picked). When a tile moves or grows into occupied cells, the tiles it
// overlaps are pushed DOWN until clear (cascading), then everything is compacted
// UPWARD so the grid has no needless gaps. The actively-edited tile always wins
// its cell; among the rest, the higher/left-er tile wins (stable, predictable).
// ─────────────────────────────────────────────────────────────────────────────

import type { DashboardLayout, Tile } from '@/lib/dashboard/types';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

function overlaps(a: Tile, b: Tile): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Push every tile that collides with a higher-priority one straight down until
 *  the grid has no overlaps. `pinnedId` (the tile being edited) never moves. */
function resolveCollisions(tiles: Tile[], pinnedId: string): Tile[] {
  const out = tiles.map((t) => ({ ...t }));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 2000) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const a = out[i];
        const b = out[j];
        if (!overlaps(a, b)) continue;
        // Decide who stays. The pinned (edited) tile always stays. Otherwise the
        // one that's higher up stays (ties: the left-er one), and the other drops.
        let winner = a;
        let loser = b;
        if (b.id === pinnedId) {
          winner = b;
          loser = a;
        } else if (a.id !== pinnedId) {
          const aFirst = a.y < b.y || (a.y === b.y && a.x <= b.x);
          winner = aFirst ? a : b;
          loser = aFirst ? b : a;
        }
        loser.y = winner.y + winner.h;
        changed = true;
      }
    }
  }
  return out;
}

/** Gravity: pull every tile up as far as it can go without colliding, so a move
 *  or shrink doesn't strand empty rows. Stable order (top-to-bottom, left-first). */
function compactUp(tiles: Tile[]): Tile[] {
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Tile[] = [];
  for (const t of sorted) {
    let y = t.y;
    while (y > 0 && !placed.some((p) => overlaps({ ...t, y: y - 1 }, p))) y--;
    placed.push({ ...t, y });
  }
  return placed;
}

/** Rows actually needed to hold every tile (so the grid grows to fit a reflow,
 *  but never shrinks below the operator's chosen row count). */
function neededRows(tiles: Tile[], minRows: number): number {
  return Math.max(minRows, ...tiles.map((t) => t.y + t.h), 1);
}

function settle(layout: DashboardLayout, tiles: Tile[], pinnedId: string): DashboardLayout {
  const compacted = compactUp(resolveCollisions(tiles, pinnedId));
  return { ...layout, rows: neededRows(compacted, layout.rows), tiles: compacted };
}

/** Move a tile to (x, y) — clamped into the grid — then reflow the rest. */
export function applyMove(layout: DashboardLayout, id: string, x: number, y: number): DashboardLayout {
  const tiles = layout.tiles.map((t) =>
    t.id === id ? { ...t, x: clamp(x, 0, layout.cols - t.w), y: Math.max(0, Math.round(y)) } : t,
  );
  return settle(layout, tiles, id);
}

/** Resize a tile to (w, h) — clamped to the grid and to the widget's floor — then
 *  reflow (PUSH other tiles). Kept for any caller that wants push-on-resize. */
export function applyResize(
  layout: DashboardLayout,
  id: string,
  w: number,
  h: number,
  minW = 1,
  minH = 1,
): DashboardLayout {
  const tiles = layout.tiles.map((t) =>
    t.id === id
      ? { ...t, w: clamp(w, minW, layout.cols - t.x), h: Math.max(minH, Math.round(h)) }
      : t,
  );
  return settle(layout, tiles, id);
}

/** The widest/tallest a tile can grow WITHOUT overlapping another tile (free
 *  space only) — width capped by the grid edge, height free to extend downward
 *  (the grid grows rows for it). Used both to clamp a resize and to decide
 *  whether the + handle should show. */
export function freeSize(
  layout: DashboardLayout,
  id: string,
  reqW: number,
  reqH: number,
  minW = 1,
  minH = 1,
): { w: number; h: number } {
  const tile = layout.tiles.find((t) => t.id === id);
  if (!tile) return { w: minW, h: minH };
  const others = layout.tiles.filter((t) => t.id !== id);
  const hits = (w: number, h: number) =>
    others.some((o) => tile.x < o.x + o.w && tile.x + w > o.x && tile.y < o.y + o.h && tile.y + h > o.y);
  // Width: clamp to the grid, then shrink until it no longer collides (at the
  // desired height). Resize NEVER pushes — it stops at occupied cells.
  let h0 = Math.max(minH, Math.round(reqH));
  let w = clamp(reqW, minW, layout.cols - tile.x);
  while (w > minW && hits(w, h0)) w--;
  // Height: free to grow downward into empty space (rows auto-grow); stop at a
  // tile directly below.
  let h = h0;
  while (h > minH && hits(w, h)) h--;
  return { w, h };
}

/** Resize into free space only (no pushing); the grid grows rows to fit height. */
export function fitResize(
  layout: DashboardLayout,
  id: string,
  reqW: number,
  reqH: number,
  minW = 1,
  minH = 1,
): DashboardLayout {
  const { w, h } = freeSize(layout, id, reqW, reqH, minW, minH);
  const tiles = layout.tiles.map((t) => (t.id === id ? { ...t, w, h } : t));
  const rows = Math.max(layout.rows, ...tiles.map((t) => t.y + t.h), 1);
  return { ...layout, rows, tiles };
}

// ── Per-edge resize (free space only; the grid grows rows downward) ───────────
export type Edge = 'l' | 'r' | 't' | 'b';

/** Whether a tile can resize on `edge` in `dir` (+1 grow, −1 shrink) — i.e. the
 *  − shows only when shrink is possible and the + only when grow is. */
export function canResizeEdge(
  layout: DashboardLayout,
  id: string,
  edge: Edge,
  dir: 1 | -1,
  minW = 1,
  minH = 1,
): boolean {
  const t = layout.tiles.find((x) => x.id === id);
  if (!t) return false;
  const others = layout.tiles.filter((x) => x.id !== id);
  const free = (cx: number, cy: number) =>
    !others.some((o) => cx >= o.x && cx < o.x + o.w && cy >= o.y && cy < o.y + o.h);
  const colFree = (cx: number) => {
    for (let cy = t.y; cy < t.y + t.h; cy++) if (!free(cx, cy)) return false;
    return true;
  };
  const rowFree = (cy: number) => {
    for (let cx = t.x; cx < t.x + t.w; cx++) if (!free(cx, cy)) return false;
    return true;
  };
  if (dir === -1) return edge === 'l' || edge === 'r' ? t.w > minW : t.h > minH;
  switch (edge) {
    case 'r':
      return t.x + t.w < layout.cols && colFree(t.x + t.w);
    case 'l':
      return t.x > 0 && colFree(t.x - 1);
    case 't':
      return t.y > 0 && rowFree(t.y - 1);
    case 'b':
      return rowFree(t.y + t.h); // beyond the last row is empty → grid grows
  }
}

function edgeStep(t: Tile, edge: Edge, dir: 1 | -1): Tile {
  switch (edge) {
    case 'r':
      return { ...t, w: t.w + dir };
    case 'l':
      return { ...t, x: t.x - dir, w: t.w + dir };
    case 't':
      return { ...t, y: t.y - dir, h: t.h + dir };
    case 'b':
      return { ...t, h: t.h + dir };
  }
}

/** Resize a tile by `steps` cells on one edge, stopping the moment it can't go
 *  further (free space / grid bounds / min size). No pushing. */
export function resizeEdgeBy(
  layout: DashboardLayout,
  id: string,
  edge: Edge,
  steps: number,
  minW = 1,
  minH = 1,
): DashboardLayout {
  if (!steps) return layout;
  const dir: 1 | -1 = steps > 0 ? 1 : -1;
  let cur = layout;
  for (let i = 0; i < Math.abs(steps); i++) {
    if (!canResizeEdge(cur, id, edge, dir, minW, minH)) break;
    cur = { ...cur, tiles: cur.tiles.map((t) => (t.id === id ? edgeStep(t, edge, dir) : t)) };
  }
  const rows = Math.max(layout.rows, ...cur.tiles.map((t) => t.y + t.h), 1);
  return { ...cur, rows };
}

/** Change the column count: clamp tiles that now stick out (shrink, then shove
 *  left), and reflow. Growing columns just leaves room on the right. */
export function setCols(layout: DashboardLayout, cols: number): DashboardLayout {
  const next = clamp(cols, 1, 8);
  const tiles = layout.tiles.map((t) => {
    const w = Math.min(t.w, next);
    const x = Math.min(t.x, next - w);
    return { ...t, w, x };
  });
  return settle({ ...layout, cols: next }, tiles, '');
}

/** Change the row count (a floor; reflow can still grow it to fit tiles). */
export function setRows(layout: DashboardLayout, rows: number): DashboardLayout {
  const next = clamp(rows, 1, 16);
  return { ...layout, rows: neededRows(layout.tiles, next) };
}

/** Remove a tile, then compact. */
export function removeTile(layout: DashboardLayout, id: string): DashboardLayout {
  const tiles = layout.tiles.filter((t) => t.id !== id);
  return settle(layout, tiles, '');
}

/** Add a widget as a new tile at the first free spot (or the bottom), then reflow. */
export function addTile(
  layout: DashboardLayout,
  widget: string,
  w: number,
  h: number,
): DashboardLayout {
  const id = `t-${widget}-${Date.now().toString(36)}`;
  const ww = clamp(w, 1, layout.cols);
  // Drop it at the bottom-left; compaction pulls it up into the first gap it fits.
  const y = Math.max(0, ...layout.tiles.map((t) => t.y + t.h));
  const tile: Tile = { id, widget, x: 0, y, w: ww, h: Math.max(1, h) };
  return settle(layout, [...layout.tiles, tile], id);
}
