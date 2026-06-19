/**
 * theme.ts — light / dark / system theme control.
 *
 * Sets `data-theme` on <html> so the token layer (tokens.css) resolves to the
 * Paper (light) or Graphite (dark) palette. "system" follows the OS preference
 * live. The choice is persisted to localStorage; the real app can also seed it
 * from the persisted `theme` setting via setThemeMode().
 */
import { writable, get } from 'svelte/store';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'revenant.theme';

function initialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* ignore */ }
  return 'system';
}

export const themeMode = writable<ThemeMode>(initialMode());

// `mq` is resolved lazily inside initTheme() so that:
//  (a) SSR / non-browser environments that never call initTheme() are safe,
//  (b) tests can stub window.matchMedia before the first call without needing
//      the stub to be in place at module-evaluation time.
let mq: MediaQueryList | null = null;

function getMq(): MediaQueryList | null {
  if (mq !== null) return mq;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  }
  return mq;
}

function resolved(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return getMq()?.matches ? 'dark' : 'light';
}

function apply(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved(mode);
}

/** Set the theme mode (light/dark/system) and persist it. */
export function setThemeMode(mode: ThemeMode) {
  themeMode.set(mode);
}

// Guard: initTheme may only wire up listeners once. Repeated calls (e.g. under
// HMR) would stack duplicate store subscriptions and matchMedia listeners,
// causing ghost theme flips and a memory leak.
let _initialized = false;

/** Apply the current mode now and keep it in sync with the OS + store. */
export function initTheme() {
  if (_initialized) return;
  _initialized = true;

  apply(get(themeMode));

  themeMode.subscribe((mode) => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
    apply(mode);
  });

  function onSystemChange() {
    if (get(themeMode) === 'system') apply('system');
  }
  getMq()?.addEventListener('change', onSystemChange);
}

/** Reset the init guard (for testing purposes only). */
export function _resetThemeInit() {
  _initialized = false;
  // Also reset the cached mq reference so tests that reconfigure matchMedia
  // before calling initTheme() again pick up the fresh stub.
  mq = null;
}
