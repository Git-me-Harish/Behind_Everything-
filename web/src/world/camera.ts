/**
 * Isometric camera maths. The camera looks along -(1,1,1); a view is the point of the screen plane at
 * the centre of the viewport (in world units along the screen's right/up axes) and a zoom in pixels
 * per world unit. Kept free of three.js so panning, pinching and fitting are unit-tested.
 */
export type V3 = readonly [number, number, number];

const s2 = Math.SQRT2, s3 = Math.sqrt(3), s6 = Math.sqrt(6);
export const RIGHT: V3 = [1 / s2, 0, -1 / s2];
export const UP: V3 = [-1 / s6, 2 / s6, -1 / s6];
/** From the scene towards the camera. */
export const BACK: V3 = [1 / s3, 1 / s3, 1 / s3];

export interface View { x: number; y: number; zoom: number }
export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }
export interface Viewport { width: number; height: number }

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A world point's position on the screen plane, in world units. */
export const onScreen = (p: V3) => ({ x: dot(p, RIGHT), y: dot(p, UP) });

export function bounds(points: V3[]): Bounds {
  const s = points.map(onScreen);
  return { minX: Math.min(...s.map(p => p.x)), maxX: Math.max(...s.map(p => p.x)), minY: Math.min(...s.map(p => p.y)), maxY: Math.max(...s.map(p => p.y)) };
}

/** The view that shows all the points, centred, with `pad` pixels to spare on each side. */
export function fit(points: V3[], vp: Viewport, pad: { x: number; top: number; bottom: number }): View {
  const b = bounds(points);
  const zoom = Math.max(0.01, Math.min((vp.width - 2 * pad.x) / (b.maxX - b.minX), (vp.height - pad.top - pad.bottom) / (b.maxY - b.minY)));
  // Shift the centre so the asymmetric padding (labels above, controls below) is honoured.
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 + (pad.top - pad.bottom) / 2 / zoom, zoom };
}

/** Screen pixel → screen-plane world position under it. */
export function unproject(v: View, vp: Viewport, px: number, py: number) {
  return { x: v.x + (px - vp.width / 2) / v.zoom, y: v.y - (py - vp.height / 2) / v.zoom };
}

/** Zooms by `factor` keeping the point under (px, py) where it is — wheel, pinch and +/- buttons. */
export function zoomAround(v: View, vp: Viewport, factor: number, px: number, py: number, limits: { min: number; max: number }): View {
  const zoom = Math.min(limits.max, Math.max(limits.min, v.zoom * factor));
  const anchor = unproject(v, vp, px, py);
  return { x: anchor.x - (px - vp.width / 2) / zoom, y: anchor.y + (py - vp.height / 2) / zoom, zoom };
}

/** Drags the scene by a pixel delta. */
export const panBy = (v: View, dx: number, dy: number): View => ({ x: v.x - dx / v.zoom, y: v.y + dy / v.zoom, zoom: v.zoom });

/** Keeps the centre of the viewport over the building, so it can never be lost off-screen. */
export function clampView(v: View, b: Bounds, limits: { min: number; max: number }): View {
  const zoom = Math.min(limits.max, Math.max(limits.min, v.zoom));
  return { x: Math.min(b.maxX, Math.max(b.minX, v.x)), y: Math.min(b.maxY, Math.max(b.minY, v.y)), zoom };
}

/** Smooth step between two views; zoom eases geometrically so zooming feels even. */
export function mix(a: View, b: View, t: number): View {
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: a.zoom * (b.zoom / a.zoom) ** e };
}

export const sameView = (a: View, b: View) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.zoom / b.zoom - 1) < 1e-3;
