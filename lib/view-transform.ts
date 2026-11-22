// Pure zoom/pan maths for the image editor viewport. The view is a CSS transform
// (translate(tx,ty) scale(k), origin top-left) applied to a wrapper that exactly
// fills the untransformed viewport box. Client-safe, no DOM access.
export type View = { k: number; tx: number; ty: number };
export type Box = { left: number; top: number; width: number; height: number };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
export const IDENTITY: View = { k: 1, tx: 0, ty: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Clamp zoom to [1,8] and pan so the image always covers the viewport (no empty margins). */
export function clampView(v: View, vw: number, vh: number): View {
  const k = clamp(v.k, MIN_ZOOM, MAX_ZOOM);
  return { k, tx: clamp(v.tx, vw - vw * k, 0), ty: clamp(v.ty, vh - vh * k, 0) };
}

/**
 * Two-finger step: the image point that sat under `from` (viewport-local px) is kept under `to`,
 * after scaling by `factor` (pinch) — gives pinch-about-midpoint and pan in one formula.
 */
export function gestureView(v: View, vw: number, vh: number, from: { x: number; y: number }, to: { x: number; y: number }, factor: number): View {
  const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
  const px = (from.x - v.tx) / v.k, py = (from.y - v.ty) / v.k; // point in unscaled viewport space
  return clampView({ k, tx: to.x - px * k, ty: to.y - py * k }, vw, vh);
}

/** Zoom about a fixed viewport point (wheel / buttons). */
export function zoomAt(v: View, vw: number, vh: number, at: { x: number; y: number }, factor: number): View {
  return gestureView(v, vw, vh, at, at, factor);
}

/**
 * Client (screen) px -> source-image px. `box` is the UNTRANSFORMED viewport rect (the wrapper's parent),
 * `dims` the source image size. `scale` = image px per screen px (for screen-space thresholds).
 */
export function screenToImage(v: View, box: Box, dims: { w: number; h: number }, cx: number, cy: number) {
  const ux = (cx - box.left - v.tx) / v.k, uy = (cy - box.top - v.ty) / v.k;
  return { x: ux * dims.w / box.width, y: uy * dims.h / box.height, scale: dims.w / (box.width * v.k) };
}

/** Inverse: image px -> client px. */
export function imageToScreen(v: View, box: Box, dims: { w: number; h: number }, ix: number, iy: number) {
  return { x: box.left + v.tx + ix * box.width / dims.w * v.k, y: box.top + v.ty + iy * box.height / dims.h * v.k };
}
