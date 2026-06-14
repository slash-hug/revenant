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

const mq = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function resolved(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return mq?.matches ? 'dark' : 'light';
}

function apply(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved(mode);
}

/** Set the theme mode (light/dark/system) and persist it. */
export function setThemeMode(mode: ThemeMode) {
  themeMode.set(mode);
}

/** Apply the current mode now and keep it in sync with the OS + store. */
export function initTheme() {
  apply(get(themeMode));
  themeMode.subscribe((mode) => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
    apply(mode);
  });
  mq?.addEventListener('change', () => {
    if (get(themeMode) === 'system') apply('system');
  });
}
