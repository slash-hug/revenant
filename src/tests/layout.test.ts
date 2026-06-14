/**
 * layout.test.ts — pure resize math for #18.
 */
import { describe, it, expect } from 'vitest';
import {
  clamp, nextSplitFrac, nextDrawerWidth,
  SPLIT_MIN, SPLIT_MAX, DRAWER_MIN, DRAWER_MAX,
} from '../lib/layout';

describe('clamp', () => {
  it('bounds to [lo, hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('nextSplitFrac', () => {
  it('grows the editor share when dragged right', () => {
    // 0.5 of 1000px = 500px; +100px → 600/1000 = 0.6
    expect(nextSplitFrac(0.5, 100, 1000)).toBeCloseTo(0.6, 5);
  });
  it('shrinks the editor share when dragged left', () => {
    expect(nextSplitFrac(0.5, -100, 1000)).toBeCloseTo(0.4, 5);
  });
  it('clamps to the min/max bounds', () => {
    expect(nextSplitFrac(0.5, -10000, 1000)).toBe(SPLIT_MIN);
    expect(nextSplitFrac(0.5, 10000, 1000)).toBe(SPLIT_MAX);
  });
  it('is a no-op for a non-positive container width', () => {
    expect(nextSplitFrac(0.47, 50, 0)).toBe(0.47);
  });
});

describe('nextDrawerWidth', () => {
  it('widens when the handle is dragged left (negative dx)', () => {
    expect(nextDrawerWidth(350, -40)).toBe(390);
  });
  it('narrows when dragged right (positive dx)', () => {
    expect(nextDrawerWidth(350, 40)).toBe(310);
  });
  it('clamps to the drawer min/max', () => {
    expect(nextDrawerWidth(350, 10000)).toBe(DRAWER_MIN);
    expect(nextDrawerWidth(350, -10000)).toBe(DRAWER_MAX);
  });
});
