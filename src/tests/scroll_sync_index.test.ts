/**
 * scroll_sync_index.test.ts — binary-search nearest-line lookup (#3).
 */
import { describe, it, expect } from 'vitest';
import { nearestLineIndex } from '../lib/scrollSync';

describe('nearestLineIndex', () => {
  const lines = [1, 5, 9, 20, 21, 40]; // ascending, as rebuildScrollIndex sorts

  it('returns -1 for an empty array', () => {
    expect(nearestLineIndex([], 7)).toBe(-1);
  });

  it('finds an exact match', () => {
    expect(nearestLineIndex(lines, 9)).toBe(2);
    expect(nearestLineIndex(lines, 1)).toBe(0);
    expect(nearestLineIndex(lines, 40)).toBe(5);
  });

  it('finds the nearest when between two lines', () => {
    expect(nearestLineIndex(lines, 7)).toBe(1);  // 5 (d2) vs 9 (d2) → earlier wins → 5
    expect(nearestLineIndex(lines, 8)).toBe(2);  // 9 closer
    expect(nearestLineIndex(lines, 19)).toBe(3); // 20 closer than 9
  });

  it('clamps below the first / above the last', () => {
    expect(nearestLineIndex(lines, -5)).toBe(0);
    expect(nearestLineIndex(lines, 999)).toBe(5);
  });

  it('keeps the earlier block on an exact tie (matches the old linear scan)', () => {
    // target 7 is equidistant from 5 and 9; the earlier (index 1) must win.
    expect(nearestLineIndex(lines, 7)).toBe(1);
  });

  it('matches a brute-force nearest scan across a range', () => {
    const brute = (target: number) => {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < lines.length; i++) {
        const d = Math.abs(lines[i] - target);
        if (d < bestDist) { bestDist = d; best = i; } // strict < → earliest on tie
      }
      return best;
    };
    for (let t = -3; t <= 45; t++) {
      expect(nearestLineIndex(lines, t)).toBe(brute(t));
    }
  });
});
