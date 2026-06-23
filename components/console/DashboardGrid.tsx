'use client';

// Renders a DashboardLayout as a CSS grid of uniform cells. In VIEW mode it's a
// plain grid. In EDIT mode each tile is draggable and resizable (Android-style
// handles), with column/row steppers and a widget picker; every change runs the
// reflow engine (push-down + compact-up) and is reported via onChange, which the
// shell debounce-saves to the server.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, X, GripVertical } from 'lucide-react';
import { widgetById, WIDGETS } from './widgets';
import { applyMove, applyResize, setCols, setRows, removeTile, addTile } from '@/lib/dashboard/reflow';
import type { DashboardLayout } from '@/lib/dashboard/types';
import styles from './console.module.css';

type DragKind = 'move' | 'resize';
interface DragState {
  kind: DragKind;
  id: string;
  /** The layout as it was when the drag began — the drag operates on this base. */
  base: DashboardLayout;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  originW: number;
  originH: number;
  stepX: number;
  stepY: number;
  dx: number;
  dy: number;
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
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<DashboardLayout | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Render the live preview while dragging/resizing, otherwise the real layout.
  const shown = preview ?? layout;

  // Measure a cell's pitch (size + gap) from the rendered grid so pointer pixels
  // map to grid cells regardless of zoom/width.
  const measure = useCallback((cols: number) => {
    const el = gridRef.current;
    if (!el) return { stepX: 1, stepY: 1 };
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const colGap = parseFloat(cs.columnGap) || 0;
    const rowGap = parseFloat(cs.rowGap) || 0;
    const rowH = parseFloat(cs.gridAutoRows) || 216;
    const cellW = (rect.width - colGap * (cols - 1)) / cols;
    return { stepX: cellW + colGap, stepY: rowH + rowGap };
  }, []);

  const beginDrag = useCallback(
    (kind: DragKind, id: string, e: React.PointerEvent) => {
      if (!editing) return;
      const tile = layout.tiles.find((t) => t.id === id);
      if (!tile) return;
      e.preventDefault();
      e.stopPropagation();
      const { stepX, stepY } = measure(layout.cols);
      const s: DragState = {
        kind,
        id,
        base: layout,
        startX: e.clientX,
        startY: e.clientY,
        originX: tile.x,
        originY: tile.y,
        originW: tile.w,
        originH: tile.h,
        stepX,
        stepY,
        dx: 0,
        dy: 0,
      };
      dragRef.current = s;
      previewRef.current = null;
      setDrag(s);
    },
    [editing, layout, measure],
  );

  // Window-level move/up while dragging — robust against pointer-capture quirks
  // and the conditional-binding race (the element handlers aren't bound until the
  // re-render after pointerdown). Operates on the layout captured at drag start.
  const previewRef = useRef<DashboardLayout | null>(null);
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const s = dragRef.current;
      if (!s) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      s.dx = dx;
      s.dy = dy;
      const stepsX = Math.round(dx / s.stepX);
      const stepsY = Math.round(dy / s.stepY);
      const w = widgetById(s.base.tiles.find((t) => t.id === s.id)?.widget ?? '');
      const next =
        s.kind === 'move'
          ? applyMove(s.base, s.id, s.originX + stepsX, s.originY + stepsY)
          : applyResize(s.base, s.id, s.originW + stepsX, s.originH + stepsY, w?.minW ?? 1, w?.minH ?? 1);
      previewRef.current = next;
      setPreview(next);
      setDrag({ ...s });
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
  }, [drag, onChange]);

  const stepCols = (d: number) => onChange?.(setCols(layout, layout.cols + d));
  const stepRows = (d: number) => onChange?.(setRows(layout, layout.rows + d));
  const addWidget = (id: string) => {
    const w = widgetById(id);
    if (w) onChange?.(addTile(layout, id, w.defaultW, w.defaultH));
    setPickerOpen(false);
  };

  const gridEl = (
    <div
      ref={gridRef}
      className={styles.dashGrid}
      data-editing={editing || undefined}
      style={{ gridTemplateColumns: `repeat(${shown.cols}, minmax(0, 1fr))` }}
      aria-label="Homelab widgets"
    >
      {shown.tiles.map((t) => {
        const widget = widgetById(t.widget);
        if (!widget) return null;
        const Body = widget.Body;
        const isDragging = drag?.id === t.id;
        const follow =
          isDragging && drag?.kind === 'move'
            ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` }
            : undefined;
        return (
          <div
            key={t.id}
            className={styles.dashTile}
            data-dragging={isDragging || undefined}
            style={{
              gridColumn: `${t.x + 1} / span ${t.w}`,
              gridRow: `${t.y + 1} / span ${t.h}`,
              ...follow,
            }}
            onPointerDown={editing ? (e) => beginDrag('move', t.id, e) : undefined}
          >
            <Body />
            {editing ? (
              <>
                <div className={styles.tileEditMask} aria-hidden />
                <span className={styles.tileGrab} aria-hidden>
                  <GripVertical size={16} strokeWidth={2.2} />
                </span>
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
                {/* Resize handles — right (width), bottom (height), corner (both). */}
                <span
                  className={`${styles.tileHandle} ${styles.handleE}`}
                  onPointerDown={(e) => beginDrag('resize', t.id, e)}
                  aria-hidden
                />
                <span
                  className={`${styles.tileHandle} ${styles.handleS}`}
                  onPointerDown={(e) => beginDrag('resize', t.id, e)}
                  aria-hidden
                />
                <span
                  className={`${styles.tileHandle} ${styles.handleSE}`}
                  onPointerDown={(e) => beginDrag('resize', t.id, e)}
                  aria-hidden
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );

  if (!editing) return gridEl;

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
        {gridEl}
      </div>
    </div>
  );
}
