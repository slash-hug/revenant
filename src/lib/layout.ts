/**
 * layout.ts — pure helpers for resizable workspace panes (#18).
 *
 * Kept separate from App.svelte so the clamp/delta math is unit-testable.
 * Widths are device-local UI preferences, persisted in localStorage (not the
 * synced settings store).
 */

export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;
export const SPLIT_DEFAULT = 0.47; // editor's share of the split

export const DRAWER_MIN = 240;
export const DRAWER_MAX = 560;
export const DRAWER_DEFAULT = 350;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * New editor fraction after dragging the editor↔preview handle by `dx` px
 * (positive = rightward = editor grows). Clamped to [SPLIT_MIN, SPLIT_MAX].
 */
export function nextSplitFrac(frac: number, dx: number, panesWidth: number): number {
  if (!Number.isFinite(panesWidth) || panesWidth <= 0) return frac;
  return clamp((frac * panesWidth + dx) / panesWidth, SPLIT_MIN, SPLIT_MAX);
}

/**
 * New drawer width after dragging the document↔drawer handle by `dx` px. The
 * handle is to the LEFT of the drawer, so dragging left (dx < 0) widens it.
 * Clamped to [DRAWER_MIN, DRAWER_MAX].
 */
export function nextDrawerWidth(width: number, dx: number): number {
  return clamp(width - dx, DRAWER_MIN, DRAWER_MAX);
}
