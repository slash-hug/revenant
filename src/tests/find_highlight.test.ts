// src/tests/find_highlight.test.ts
/**
 * Unit tests for find-highlight.ts.
 *
 * Runs in jsdom. CSS.highlights is not available, so preview highlight
 * functions are tested for no-throw behavior. The CM6 decoration builder
 * is tested directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildFindDecorations,
  clearFindHighlights,
  refreshFindHighlights,
} from '../lib/find-highlight';
import type { MatchRange } from '../lib/stores/find';

// ── buildFindDecorations (CM6 decoration builder) ──────────────────────────

describe('buildFindDecorations', () => {
  it('returns empty set for no matches', () => {
    const set = buildFindDecorations([], -1, 100);
    expect(set.size).toBe(0);
  });

  it('creates decorations for each match', () => {
    const matches: MatchRange[] = [
      { from: 0, to: 5 },
      { from: 10, to: 15 },
    ];
    const set = buildFindDecorations(matches, 0, 20);
    expect(set.size).toBe(2);
  });

  it('skips out-of-bounds ranges', () => {
    const matches: MatchRange[] = [
      { from: 0, to: 5 },
      { from: 15, to: 25 }, // beyond docLength=20
    ];
    const set = buildFindDecorations(matches, 0, 20);
    expect(set.size).toBe(1);
  });

  it('skips zero-length ranges', () => {
    const matches: MatchRange[] = [
      { from: 5, to: 5 }, // zero-length
      { from: 0, to: 3 },
    ];
    const set = buildFindDecorations(matches, 0, 20);
    expect(set.size).toBe(1);
  });

  it('handles unsorted matches by sorting internally', () => {
    const matches: MatchRange[] = [
      { from: 10, to: 15 },
      { from: 0, to: 5 },
    ];
    // Should not throw — RangeSetBuilder requires sorted input
    const set = buildFindDecorations(matches, 1, 20);
    expect(set.size).toBe(2);
  });
});

// ── Preview highlights (CSS.highlights not available in jsdom) ──────────────

describe('preview highlights (jsdom)', () => {
  it('refreshFindHighlights does not throw when CSS.highlights is unavailable', () => {
    const el = document.createElement('div');
    el.textContent = 'hello world';
    expect(() =>
      refreshFindHighlights(el, [{ from: 0, to: 5 }], 0, 'hello world'),
    ).not.toThrow();
  });

  it('clearFindHighlights does not throw when CSS.highlights is unavailable', () => {
    expect(() => clearFindHighlights()).not.toThrow();
  });
});

// ── Preview highlights with mocked CSS.highlights ──────────────────────────

describe('preview highlights (mocked CSS.highlights)', () => {
  const originalCSS = (globalThis as Record<string, unknown>).CSS;
  const originalHighlight = (globalThis as Record<string, unknown>).Highlight;
  let mockHighlights: Map<string, unknown>;

  beforeEach(() => {
    mockHighlights = new Map();
    // Mock the Highlight class
    (globalThis as Record<string, unknown>).Highlight = class {
      constructor(..._ranges: Range[]) {}
    };
    (globalThis as Record<string, unknown>).CSS = {
      highlights: {
        set: (name: string, hl: unknown) => mockHighlights.set(name, hl),
        delete: (name: string) => mockHighlights.delete(name),
        has: (name: string) => mockHighlights.has(name),
      },
    };
  });

  afterEach(() => {
    if (originalCSS === undefined) {
      delete (globalThis as Record<string, unknown>).CSS;
    } else {
      (globalThis as Record<string, unknown>).CSS = originalCSS;
    }
    if (originalHighlight === undefined) {
      delete (globalThis as Record<string, unknown>).Highlight;
    } else {
      (globalThis as Record<string, unknown>).Highlight = originalHighlight;
    }
  });

  it('registers find-match highlights for matching text', () => {
    const el = document.createElement('div');
    el.textContent = 'hello world hello';
    const content = 'hello world hello';
    const matches: MatchRange[] = [
      { from: 0, to: 5 },
      { from: 12, to: 17 },
    ];

    refreshFindHighlights(el, matches, 0, content);
    // Active match goes to find-active, passive to find-match
    expect(mockHighlights.has('find-active')).toBe(true);
    expect(mockHighlights.has('find-match')).toBe(true);
  });

  it('clears highlights when matches is empty', () => {
    const el = document.createElement('div');
    el.textContent = 'hello';
    mockHighlights.set('find-match', {});
    mockHighlights.set('find-active', {});

    refreshFindHighlights(el, [], -1, 'hello');
    expect(mockHighlights.has('find-match')).toBe(false);
    expect(mockHighlights.has('find-active')).toBe(false);
  });

  it('clearFindHighlights removes both highlight sets', () => {
    mockHighlights.set('find-match', {});
    mockHighlights.set('find-active', {});

    clearFindHighlights();
    expect(mockHighlights.has('find-match')).toBe(false);
    expect(mockHighlights.has('find-active')).toBe(false);
  });
});
