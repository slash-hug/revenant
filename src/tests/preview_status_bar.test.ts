/**
 * preview_status_bar.test.ts — structural + store tests for PreviewStatusBar.svelte.
 *
 * Component mounting is not wired for this repo's vitest setup. We test:
 *  - Pure store functions (setZoom/adjustZoom/resetZoom/clampZoom) which are the
 *    actual behaviors driven by the status bar buttons
 *  - Source-text structural invariants to guard the component shape
 *
 * The store tests mirror preview_zoom.test.ts but focus on the subset of
 * operations the status bar exposes: −/+/slider/reset.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { get } from 'svelte/store';
import {
  previewZoom,
  setZoom,
  adjustZoom,
  resetZoom,
  clampZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  ZOOM_DEFAULT,
} from '../lib/stores/previewZoom';

const src = readFileSync(
  resolve(process.cwd(), 'src/lib/PreviewStatusBar.svelte'),
  'utf8',
);

// Mock patchSettings to avoid IPC calls.
vi.mock('../lib/stores/settings', async () => {
  const actual = await vi.importActual<typeof import('../lib/stores/settings')>('../lib/stores/settings');
  return {
    ...actual,
    patchSettings: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  vi.useFakeTimers();
  previewZoom.set(ZOOM_DEFAULT);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Source-text structural invariants
// ---------------------------------------------------------------------------

describe('PreviewStatusBar — structure', () => {
  it('imports from previewZoom store', () => {
    expect(src).toContain("from './stores/previewZoom'");
  });

  it('uses setZoom, adjustZoom, resetZoom from the store', () => {
    expect(src).toContain('adjustZoom');
    expect(src).toContain('resetZoom');
    expect(src).toContain('setZoom');
  });

  it('has an input[type="range"] slider', () => {
    expect(src).toContain('type="range"');
  });

  it('binds slider min/max to ZOOM_MIN/ZOOM_MAX', () => {
    expect(src).toContain('ZOOM_MIN');
    expect(src).toContain('ZOOM_MAX');
  });

  it('renders the current zoom percentage', () => {
    // The reset button or display shows $previewZoom + %
    expect(src).toMatch(/\$previewZoom.*%|%.*\$previewZoom/s);
  });

  it('has minus (−) and plus (+) buttons', () => {
    // Buttons call adjustZoom with negative and positive ZOOM_STEP
    expect(src).toMatch(/adjustZoom\(-ZOOM_STEP\)/);
    expect(src).toMatch(/adjustZoom\(ZOOM_STEP\)/);
  });

  it('has a reset control that calls resetZoom', () => {
    expect(src).toContain('resetZoom');
  });

  it('minus button is disabled at ZOOM_MIN', () => {
    expect(src).toMatch(/disabled=\{.*previewZoom.*<=.*ZOOM_MIN.*\}|\$previewZoom\s*<=\s*ZOOM_MIN/s);
  });

  it('plus button is disabled at ZOOM_MAX', () => {
    expect(src).toMatch(/disabled=\{.*previewZoom.*>=.*ZOOM_MAX.*\}|\$previewZoom\s*>=\s*ZOOM_MAX/s);
  });
});

// ---------------------------------------------------------------------------
// Store function tests (the actual behaviors driven by the UI)
// ---------------------------------------------------------------------------

describe('PreviewStatusBar — minus button behavior (adjustZoom(-ZOOM_STEP))', () => {
  it('decrements previewZoom by ZOOM_STEP', () => {
    previewZoom.set(110);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(100);
  });

  it('clamps at ZOOM_MIN', () => {
    previewZoom.set(ZOOM_MIN);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });

  it('does not go below ZOOM_MIN from one step above', () => {
    previewZoom.set(ZOOM_MIN + ZOOM_STEP);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });
});

describe('PreviewStatusBar — plus button behavior (adjustZoom(+ZOOM_STEP))', () => {
  it('increments previewZoom by ZOOM_STEP', () => {
    previewZoom.set(100);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(110);
  });

  it('clamps at ZOOM_MAX', () => {
    previewZoom.set(ZOOM_MAX);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MAX);
  });

  it('does not go above ZOOM_MAX from one step below', () => {
    previewZoom.set(ZOOM_MAX - ZOOM_STEP);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MAX);
  });
});

describe('PreviewStatusBar — slider behavior (setZoom)', () => {
  it('sets previewZoom to the slider value', () => {
    setZoom(150);
    expect(get(previewZoom)).toBe(150);
  });

  it('clamps slider value to ZOOM_MIN..ZOOM_MAX', () => {
    setZoom(0);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
    setZoom(999);
    expect(get(previewZoom)).toBe(ZOOM_MAX);
  });
});

describe('PreviewStatusBar — reset button behavior (resetZoom)', () => {
  it('resets to ZOOM_DEFAULT', () => {
    previewZoom.set(170);
    resetZoom();
    expect(get(previewZoom)).toBe(ZOOM_DEFAULT);
  });

  it('resets from minimum', () => {
    previewZoom.set(ZOOM_MIN);
    resetZoom();
    expect(get(previewZoom)).toBe(ZOOM_DEFAULT);
  });

  it('resets from maximum', () => {
    previewZoom.set(ZOOM_MAX);
    resetZoom();
    expect(get(previewZoom)).toBe(ZOOM_DEFAULT);
  });
});

describe('PreviewStatusBar — clampZoom (underlying boundary contract)', () => {
  it('clamps below minimum to ZOOM_MIN', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(30)).toBe(ZOOM_MIN);
  });

  it('clamps above maximum to ZOOM_MAX', () => {
    expect(clampZoom(250)).toBe(ZOOM_MAX);
  });

  it('passes through values on step boundaries', () => {
    expect(clampZoom(ZOOM_DEFAULT)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(130)).toBe(130);
  });
});
