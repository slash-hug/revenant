/**
 * theme_store.test.ts — unit tests for the theme store.
 *
 * Covers:
 *  - initTheme() is idempotent: calling it twice does NOT stack duplicate
 *    store subscriptions or matchMedia listeners.
 *  - Theme resolution still works correctly after init (light / dark / system).
 *  - setThemeMode() updates data-theme on the document element.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  themeMode,
  initTheme,
  setThemeMode,
  _resetThemeInit,
} from '../lib/stores/theme';

// ---------------------------------------------------------------------------
// matchMedia stub
// ---------------------------------------------------------------------------
// theme.ts lazily acquires the MediaQueryList inside initTheme(), so installing
// the stub in beforeEach (before any initTheme() call) is sufficient.

let mqListeners: Array<() => void>;
let mqDarkMatches: boolean;
let mqAddListenerSpy: ReturnType<typeof vi.fn>;

function installMatchMediaStub() {
  mqListeners = [];
  mqDarkMatches = false;
  mqAddListenerSpy = vi.fn((_type: string, fn: () => void) => {
    mqListeners.push(fn);
  });

  const stub = {
    get matches() { return mqDarkMatches; },
    addEventListener: mqAddListenerSpy,
    removeEventListener: vi.fn(),
  };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => stub),
  });
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  installMatchMediaStub();
  _resetThemeInit();             // clears the init guard + cached mq ref
  themeMode.set('system');
  try { localStorage.clear(); } catch { /* ignore */ }
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Idempotency — regression tests for issues #32 and #13
// ---------------------------------------------------------------------------

describe('initTheme idempotency', () => {
  it('calling initTheme twice registers addEventListener exactly once', () => {
    initTheme();
    initTheme();
    expect(mqAddListenerSpy).toHaveBeenCalledTimes(1);
  });

  it('calling initTheme three times still only registers one listener', () => {
    initTheme();
    initTheme();
    initTheme();
    expect(mqAddListenerSpy).toHaveBeenCalledTimes(1);
  });

  it('after double init, setThemeMode resolves to the correct final value', () => {
    initTheme();
    initTheme();
    setThemeMode('dark');
    setThemeMode('light');
    // With a single subscription, the last write wins cleanly.
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(get(themeMode)).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

describe('theme resolution', () => {
  beforeEach(() => initTheme());

  it('sets data-theme="dark" when mode is dark', () => {
    setThemeMode('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sets data-theme="light" when mode is light', () => {
    setThemeMode('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows OS preference for system mode when OS is dark', () => {
    mqDarkMatches = true;
    // Force a re-apply by transitioning through a non-system mode so the
    // subscriber fires and picks up the updated OS preference.
    setThemeMode('light');
    setThemeMode('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('follows OS preference for system mode when OS is light', () => {
    mqDarkMatches = false;
    setThemeMode('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('responds to OS change event when mode is system', () => {
    setThemeMode('system');
    mqDarkMatches = true;
    // Simulate the matchMedia 'change' event.
    mqListeners.forEach((fn) => fn());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores OS change event when mode is not system', () => {
    setThemeMode('dark');
    // OS flips to light — must stay 'dark' because user pinned the mode.
    mqDarkMatches = false;
    mqListeners.forEach((fn) => fn());
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

describe('localStorage persistence', () => {
  it('persists the mode to localStorage on change', () => {
    initTheme();
    setThemeMode('dark');
    expect(localStorage.getItem('revenant.theme')).toBe('dark');
    setThemeMode('light');
    expect(localStorage.getItem('revenant.theme')).toBe('light');
  });
});

// ---------------------------------------------------------------------------
// setThemeMode without initTheme
// ---------------------------------------------------------------------------

describe('setThemeMode before initTheme', () => {
  it('updates the store value even without initTheme', () => {
    setThemeMode('dark');
    expect(get(themeMode)).toBe('dark');
  });
});
