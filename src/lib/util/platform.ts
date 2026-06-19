/**
 * platform.ts — cross-platform host detection helpers for the frontend.
 *
 * Uses a userAgent-based check rather than the deprecated `navigator.platform`
 * so the result stays reliable on modern browsers/WebViews where `platform`
 * is frozen or unset.
 */

/**
 * Return true when running on macOS (used to pick ⌘ vs Ctrl shortcut glyphs).
 * Guards against `navigator` being undefined (SSR / non-browser test envs).
 */
export function isMac(): boolean {
  return typeof navigator !== 'undefined'
    && (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));
}
