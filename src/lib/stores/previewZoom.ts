/**
 * previewZoom.ts — reactive preview zoom level store.
 *
 * Drives CSS transform: scale() on the .prose reading column.
 * Initialized from Settings.preview_zoom on app load; persisted via
 * debounced patchSettings on change.
 */

import { writable, get } from 'svelte/store';
import { settings, patchSettings } from './settings';

/** Zoom boundaries. */
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

/** Clamp a raw value to the valid zoom range. */
export function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v / ZOOM_STEP) * ZOOM_STEP));
}

/** The preview zoom percentage (50–200). */
export const previewZoom = writable<number>(ZOOM_DEFAULT);

/**
 * Initialize zoom from loaded settings.
 * Called once after loadSettings() in the app startup path.
 */
export function initPreviewZoom(): void {
  const s = get(settings);
  if (s) {
    previewZoom.set(clampZoom(s.preview_zoom));
  }
}

// ---------------------------------------------------------------------------
// Debounced persistence
// ---------------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DELAY_MS = 400;

function debouncedPersist(zoom: number): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void patchSettings({ preview_zoom: zoom });
    persistTimer = null;
  }, PERSIST_DELAY_MS);
}

/**
 * Set zoom to an absolute value (clamped). Persists to settings.
 */
export function setZoom(raw: number): void {
  const clamped = clampZoom(raw);
  previewZoom.set(clamped);
  debouncedPersist(clamped);
}

/**
 * Adjust zoom by a signed delta (e.g. +10 or -10). Persists to settings.
 */
export function adjustZoom(delta: number): void {
  setZoom(get(previewZoom) + delta);
}

/**
 * Reset zoom to 100%. Persists to settings.
 */
export function resetZoom(): void {
  setZoom(ZOOM_DEFAULT);
}
