'use client';

// Renders a DashboardLayout. Tiles are ABSOLUTELY positioned (px rects computed
// from their cell coords) rather than placed by CSS grid — that's what lets them
// ANIMATE between slots, lets a dragged tile follow the cursor exactly while the
// others reflow around it, and lets a resize grow smoothly. View mode is the same
// layout without the edit chrome. Narrow screens fall back to a simple stack.
//
//  • move   = push/reflow (applyMove): the dragged tile follows the pointer, a
//             placeholder shows its target cell, the rest animate out of the way.
//  • resize = free space only (fitResize): grows into empty cells, stops at the
//             grid edge or an occupied neighbour — never shoves anyone to a new
//             row. Android-style handle: a dot whose −/+ appear on hover, with −
//             hidden at min size and + hidden when there's no room to grow.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { widgetById, WIDGETS } from './widgets';
import {
  applyMove,
  resizeEdgeBy,
  canResizeEdge,
  setCols,
  setRows,
  removeTile,
  addTile,
  type Edge,
} from '@/lib/dashboard/reflow';
import type { DashboardLayout, Tile } from '@/lib/dashboard/types';
import styles from './console.module.css';

const EDGES: Edge[] = ['l', 'r', 't', 'b'];

const ROW_REM = 13.5; // cell height
const GAP_REM = 0.75; // matches --space-sm
const NARROW = 760;

interface Metrics {
  cellW: number;
  rowH: number;
  gap: number;
  width: number;
}
interface DragState {
  kind: 'move' | 'resize';
  edge?: Edge;
  id: string;
  base: DashboardLayout;
  startX: number;
  startY: number;
  oLeft: number;
  oTop: number;
  oW: number;
  oH: number;
  // live float (move): the dragged tile's current px position under the pointer.
  left: number;
  top: number;
}

export function DashboardGrid({
  layout,
  editing = false,
  onChange,
}: {
  layout: DashboardLayout;
  editing?: boolean;
  onChange?: (next: DashboardLayout) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics>({ cellW: 0, rowH: 0, gap: 0, width: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<DashboardLayout | null>(null);
  const previewRef = useRef<DashboardLayout | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const shown = preview ?? layout;

  const recalc = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const width = el.clientWidth;
    const gap = GAP_REM * root;
    const rowH = ROW_REM * root;
    const cellW = (width - gap * (shown.cols - 1)) / shown.cols;
    setMetrics({ cellW, rowH, gap, width });
  }, [shown.cols]);

  useLayoutEffect(() => {
    recalc();
  }, [recalc]);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recalc]);

  const isNarrow = metrics.width > 0 && metrics.width < NARROW;
  const stepX = metrics.cellW + metrics.gap;
  const stepY = metrics.rowH + metrics.gap;

  const rectOf = (t: Pick<Tile, 'x' | 'y' | 'w' | 'h'>) => ({
    left: t.x * stepX,
    top: t.y * stepY,
    width: Math.max(0, t.w * metrics.cellW + (t.w - 1) * metrics.gap),
    height: Math.max(0, t.h * metrics.rowH + (t.h - 1) * metrics.gap),
  });

  const beginDrag = useCallback(
    (kind: 'move' | 'resize', edge: Edge | undefined, id: string, e: React.PointerEvent) => {
      if (!editing || isNarrow) return;
      const tile = layout.tiles.find((t) => t.id === id);
      if (!tile) return;
      e.preventDefault();
      e.stopPropagation();
      const r = rectOf(tile);
      const s: DragState = {
        kind,
        edge,
        id,
        base: layout,
        startX: e.clientX,
        startY: e.clientY,
        oLeft: r.left,
        oTop: r.top,
        oW: tile.w,
        oH: tile.h,
        left: r.left,
        top: r.top,
      };
      dragRef.current = s;
      previewRef.current = layout;
      setPreview(layout);
      setDrag(s);
    },
    // rectOf depends on metrics; layout/editing/isNarrow captured fresh each render
    [editing, isNarrow, layout, stepX, stepY, metrics.cellW, metrics.gap, metrics.rowH],
  );

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      const w = widgetById(s.base.tiles.find((t) => t.id === s.id)?.widget ?? '');
      if (s.kind === 'move') {
        s.left = s.oLeft + dx;
        s.top = s.oTop + dy;
        const tx = Math.max(0, Math.round(s.left / stepX));
        const ty = Math.max(0, Math.round(s.top / stepY));
        const next = applyMove(s.base, s.id, tx, ty);
        previewRef.current = next;
        setPreview(next);
        setDrag({ ...s });
      } else if (s.edge) {
        // Steps along the edge's axis; growing means dragging AWAY from the tile
        // (right/down = +, left/up = +, since each edge grows outward).
        const edge = s.edge;
        const steps =
          edge === 'r' ? Math.round(dx / stepX)
          : edge === 'l' ? -Math.round(dx / stepX)
          : edge === 'b' ? Math.round(dy / stepY)
          : -Math.round(dy / stepY); // 't'
        const next = resizeEdgeBy(s.base, s.id, edge, steps, w?.minW ?? 1, w?.minH ?? 1);
        previewRef.current = next;
        setPreview(next);
      }
    };
    const onUp = () => {
      if (previewRef.current && onChange) onChange(previewRef.current);
      dragRef.current = null;
      previewRef.current = null;
      setDrag(null);
      setPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, onChange, stepX, stepY]);

  const stepCols = (d: number) => onChange?.(setCols(layout, layout.cols + d));
  const stepRows = (d: number) => onChange?.(setRows(layout, layout.rows + d));
  const resizeStep = (id: string, edge: Edge, dir: 1 | -1) => {
    const t = layout.tiles.find((x) => x.id === id);
    const w = widgetById(t?.widget ?? '');
    if (!t) return;
    onChange?.(resizeEdgeBy(layout, id, edge, dir, w?.minW ?? 1, w?.minH ?? 1));
  };
  const addWidget = (id: string) => {
    const w = widgetById(id);
    if (w) onChange?.(addTile(layout, id, w.defaultW, w.defaultH));
    setPickerOpen(false);
  };

  // ── Narrow stack (mobile) ──────────────────────────────────────────────────
  if (isNarrow) {
    return (
      <div ref={gridRef} className={styles.dashStack} aria-label="Homelab widgets">
        {shown.tiles.map((t) => {
          const widget = widgetById(t.widget);
          if (!widget) return null;
          const Body = widget.Body;
          return (
            <div key={t.id} className={styles.dashTile} style={{ minHeight: `${ROW_REM}rem` }}>
              <Body />
            </div>
          );
        })}
      </div>
    );
  }

  const containerH = shown.rows * stepY - metrics.gap;

  const grid = (
    <div
      ref={gridRef}
      className={styles.dashGrid}
      data-editing={editing || undefined}
      style={{ height: metrics.cellW > 0 ? `${containerH}px` : undefined }}
      aria-label="Homelab widgets"
    >
      {/* Drop placeholder for the tile being moved. */}
      {drag?.kind === 'move'
        ? (() => {
            const t = shown.tiles.find((x) => x.id === drag.id);
            if (!t) return null;
            const r = rectOf(t);
            return (
              <div
                className={styles.dropGhost}
                style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
                aria-hidden
              />
            );
          })()
        : null}

      {shown.tiles.map((t) => {
        const widget = widgetById(t.widget);
        if (!widget) return null;
        const Body = widget.Body;
        const dragging = drag?.id === t.id;
        const moving = dragging && drag?.kind === 'move';
        const r = rectOf(t);
        // The moving tile floats under the pointer (no transition); everyone else
        // animates to their reflowed slot.
        const style = moving
          ? { left: drag!.left, top: drag!.top, width: r.width, height: r.height }
          : { left: r.left, top: r.top, width: r.width, height: r.height };

        const zoneClass: Record<Edge, string> = {
          l: styles.zoneL,
          r: styles.zoneR,
          t: styles.zoneT,
          b: styles.zoneB,
        };
        const edgeLabel: Record<Edge, string> = { l: 'left', r: 'right', t: 'top', b: 'bottom' };

        return (
          <div
            key={t.id}
            className={styles.dashTile}
            data-dragging={dragging || undefined}
            data-moving={moving || undefined}
            style={style}
            onPointerDown={editing ? (e) => beginDrag('move', undefined, t.id, e) : undefined}
          >
            <Body />
            {editing ? (
              <>
                <div className={styles.tileEditMask} aria-hidden />
                <button
                  type="button"
                  className={styles.tileRemove}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onChange?.(removeTile(layout, t.id))}
                  aria-label={`Remove ${widget.name}`}
                  title="Remove"
                >
                  <X size={14} strokeWidth={2.4} />
                </button>

                {/* A dot on every edge (always shown). Hover reveals −/+ ONLY where
                    a resize is possible: + when it can grow that side, − when it can
                    shrink; both stay centered on the dot. L/R buttons sit
                    horizontally, T/B vertically (per the design). */}
                {EDGES.map((edge) => {
                  const canGrow = canResizeEdge(layout, t.id, edge, 1, widget.minW, widget.minH);
                  const canShrink = canResizeEdge(layout, t.id, edge, -1, widget.minW, widget.minH);
                  return (
                    <span
                      key={edge}
                      className={`${styles.handleZone} ${zoneClass[edge]}`}
                      data-active={canGrow || canShrink || undefined}
                    >
                      <span
                        className={styles.handleDot}
                        onPointerDown={(e) => beginDrag('resize', edge, t.id, e)}
                        aria-hidden
                      />
                      <span className={styles.handleBtns}>
                        {canShrink ? (
                          <button
                            type="button"
                            className={styles.handleBtn}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => resizeStep(t.id, edge, -1)}
                            aria-label={`Shrink ${widget.name} from ${edgeLabel[edge]}`}
                          >
                            <Minus size={14} strokeWidth={2.6} />
                          </button>
                        ) : null}
                        {canGrow ? (
                          <button
                            type="button"
                            className={styles.handleBtn}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => resizeStep(t.id, edge, 1)}
                            aria-label={`Grow ${widget.name} ${edgeLabel[edge]}`}
                          >
                            <Plus size={14} strokeWidth={2.6} />
                          </button>
                        ) : null}
                      </span>
                    </span>
                  );
                })}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  if (!editing) return grid;

  return (
    <div className={styles.editWrap}>
      <div className={styles.editTopBar}>
        <div className={styles.stepper} role="group" aria-label="Columns">
          <button type="button" onClick={() => stepCols(-1)} aria-label="Remove column" disabled={layout.cols <= 1}>
            <Minus size={15} strokeWidth={2.4} />
          </button>
          <span className={`${styles.stepVal} mono`}>{layout.cols} cols</span>
          <button type="button" onClick={() => stepCols(1)} aria-label="Add column" disabled={layout.cols >= 8}>
            <Plus size={15} strokeWidth={2.4} />
          </button>
        </div>
        <div className={styles.editTopRight}>
          <button type="button" className={styles.addWidgetBtn} onClick={() => setPickerOpen((v) => !v)}>
            <Plus size={15} strokeWidth={2.4} /> Add widget
          </button>
        </div>
        {pickerOpen ? (
          <div className={styles.picker} role="menu">
            {WIDGETS.map((w) => (
              <button key={w.id} type="button" className={styles.pickerItem} onClick={() => addWidget(w.id)}>
                <w.Icon size={16} strokeWidth={2.2} aria-hidden />
                <span>{w.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className={styles.editRow}>
        <div className={styles.rowRail} role="group" aria-label="Rows">
          <button type="button" onClick={() => stepRows(1)} aria-label="Add row" disabled={layout.rows >= 16}>
            <Plus size={15} strokeWidth={2.4} />
          </button>
          <span className={`${styles.stepVal} mono`}>{layout.rows}</span>
          <button type="button" onClick={() => stepRows(-1)} aria-label="Remove row" disabled={layout.rows <= 1}>
            <Minus size={15} strokeWidth={2.4} />
          </button>
        </div>
        {grid}
      </div>
    </div>
  );
}
