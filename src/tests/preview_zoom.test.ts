/**
 * preview_zoom.test.ts — unit tests for the previewZoom store.
 *
 * Covers:
 *  - clampZoom clamps to 50–200 range and rounds to nearest step
 *  - setZoom / adjustZoom / resetZoom update the store correctly
 *  - initPreviewZoom reads from settings store
 *  - setZoom persists via patchSettings (debounced)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  previewZoom,
  clampZoom,
  setZoom,
  adjustZoom,
  resetZoom,
  initPreviewZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  ZOOM_STEP,
} from '../lib/stores/previewZoom';
import { settings } from '../lib/stores/settings';

// Mock patchSettings to avoid IPC calls.
vi.mock('../lib/stores/settings', async () => {
  const actual = await vi.importActual<typeof import('../lib/stores/settings')>('../lib/stores/settings');
  return {
    ...actual,
    patchSettings: vi.fn().mockResolvedValue(undefined),
  };
});

import { patchSettings } from '../lib/stores/settings';
const mockPatch = vi.mocked(patchSettings);

beforeEach(() => {
  vi.useFakeTimers();
  previewZoom.set(ZOOM_DEFAULT);
  mockPatch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// clampZoom
// ---------------------------------------------------------------------------

describe('clampZoom', () => {
  it('returns value unchanged when within range and on a step', () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(50)).toBe(50);
    expect(clampZoom(200)).toBe(200);
    expect(clampZoom(130)).toBe(130);
  });

  it('clamps below minimum to ZOOM_MIN', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(-10)).toBe(ZOOM_MIN);
    expect(clampZoom(30)).toBe(ZOOM_MIN);
  });

  it('clamps above maximum to ZOOM_MAX', () => {
    expect(clampZoom(250)).toBe(ZOOM_MAX);
    expect(clampZoom(210)).toBe(ZOOM_MAX);
  });

  it('rounds to nearest step', () => {
    expect(clampZoom(93)).toBe(90);
    expect(clampZoom(97)).toBe(100);
    expect(clampZoom(105)).toBe(110);
    expect(clampZoom(55)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// setZoom / adjustZoom / resetZoom
// ---------------------------------------------------------------------------

describe('setZoom', () => {
  it('sets the store to the clamped value', () => {
    setZoom(150);
    expect(get(previewZoom)).toBe(150);
  });

  it('clamps out-of-range values', () => {
    setZoom(999);
    expect(get(previewZoom)).toBe(ZOOM_MAX);
    setZoom(0);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });

  it('debounce-persists via patchSettings', () => {
    setZoom(120);
    // Not called immediately.
    expect(mockPatch).not.toHaveBeenCalled();
    // After debounce delay.
    vi.advanceTimersByTime(500);
    expect(mockPatch).toHaveBeenCalledWith({ preview_zoom: 120 });
  });

  it('coalesces rapid calls (only last value persists)', () => {
    setZoom(110);
    setZoom(120);
    setZoom(130);
    vi.advanceTimersByTime(500);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith({ preview_zoom: 130 });
  });
});

describe('adjustZoom', () => {
  it('increments by ZOOM_STEP', () => {
    previewZoom.set(100);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(110);
  });

  it('decrements by ZOOM_STEP', () => {
    previewZoom.set(100);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(90);
  });

  it('clamps at boundaries', () => {
    previewZoom.set(ZOOM_MAX);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MAX);

    previewZoom.set(ZOOM_MIN);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });
});

describe('resetZoom', () => {
  it('resets to ZOOM_DEFAULT', () => {
    previewZoom.set(170);
    resetZoom();
    expect(get(previewZoom)).toBe(ZOOM_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// initPreviewZoom
// ---------------------------------------------------------------------------

describe('initPreviewZoom', () => {
  it('reads preview_zoom from settings store', () => {
    settings.set({
      schema_version: 1,
      vaults: [],
      default_export_subfolder: '',
      theme: 'system',
      export_on_save: false,
      rest_key_ref: null,
      preview_zoom: 140,
      agent_nudge_template: "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.",
      agent_nudge_path_style: "relative",
    });
    initPreviewZoom();
    expect(get(previewZoom)).toBe(140);
  });

  it('clamps invalid settings value', () => {
    settings.set({
      schema_version: 1,
      vaults: [],
      default_export_subfolder: '',
      theme: 'system',
      export_on_save: false,
      rest_key_ref: null,
      preview_zoom: 999,
      agent_nudge_template: "Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.",
      agent_nudge_path_style: "relative",
    });
    initPreviewZoom();
    expect(get(previewZoom)).toBe(ZOOM_MAX);
  });

  it('uses default when settings store is null', () => {
    previewZoom.set(150);
    settings.set(null);
    initPreviewZoom();
    // Should remain unchanged (no settings loaded yet).
    expect(get(previewZoom)).toBe(150);
  });
});
