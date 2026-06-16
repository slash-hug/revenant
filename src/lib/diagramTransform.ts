/**
 * diagramTransform.ts — pure pan/zoom state logic for Mermaid diagram containers.
 *
 * No DOM dependencies. All functions take a DiagramTransform and return a new one.
 * Extracted for testability — MermaidContainer.svelte uses these to manage its
 * per-diagram viewport state.
 */

/** Zoom boundaries. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;
/** Multiplicative zoom factor per step. */
export const ZOOM_FACTOR = 1.25;
/** Pixels per arrow-button pan click. */
export const PAN_STEP = 50;

export interface DiagramTransform {
  scale: number;
  panX: number;
  panY: number;
}

/** Identity transform — no zoom, no pan. */
export const IDENTITY: DiagramTransform = { scale: 1, panX: 0, panY: 0 };

/** Clamp a scale value to [ZOOM_MIN, ZOOM_MAX]. */
export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * Zoom in (direction=1) or out (direction=-1) anchored to the cursor point.
 * The point under the cursor stays fixed after the zoom.
 */
export function zoomAtPoint(
  t: DiagramTransform,
  direction: 1 | -1,
  cursorX: number,
  cursorY: number,
): DiagramTransform {
  const factor = direction === 1 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const newScale = clampScale(t.scale * factor);
  if (newScale === t.scale) return t;

  const canvasX = (cursorX - t.panX) / t.scale;
  const canvasY = (cursorY - t.panY) / t.scale;
  return {
    scale: newScale,
    panX: cursorX - canvasX * newScale,
    panY: cursorY - canvasY * newScale,
  };
}

/** Translate by (dx, dy) pixels. No bounds clamping — infinite pan is allowed. */
export function pan(t: DiagramTransform, dx: number, dy: number): DiagramTransform {
  return { scale: t.scale, panX: t.panX + dx, panY: t.panY + dy };
}

/**
 * Calculate a transform that fits the SVG (svgW×svgH) into the viewport
 * (vpW×vpH), centered. Never over-enlarges — caps scale at 1.0.
 */
export function fitToView(
  svgW: number,
  svgH: number,
  vpW: number,
  vpH: number,
): DiagramTransform {
  if (svgW <= 0 || svgH <= 0) return { ...IDENTITY };
  const scale = Math.min(1.0, vpW / svgW, vpH / svgH);
  const scaledW = svgW * scale;
  const scaledH = svgH * scale;
  return {
    scale,
    panX: (vpW - scaledW) / 2,
    panY: (vpH - scaledH) / 2,
  };
}
