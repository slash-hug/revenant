/**
 * annotation_focus.test.ts
 *
 * Unit tests for the annotationFocus store (T2.2).
 *
 * Covers:
 *  - focusAnnotation sets activeId and bumps scrollNonce (D5).
 *  - clearFocus resets activeId and hoverId (Esc / outside-click path).
 *  - scrollNonce bumps on every focusAnnotation, including re-click of same id (D5).
 *  - hoverAnnotation sets and clears hoverId.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
  annotationFocus,
  focusAnnotation,
  clearFocus,
  hoverAnnotation,
} from '../lib/stores/annotationFocus';

function getState() {
  return get(annotationFocus);
}

describe('annotationFocus store', () => {
  beforeEach(() => {
    // Reset to initial state before each test.
    clearFocus();
    // Also reset scrollNonce explicitly via a fresh write.
    annotationFocus.set({ activeId: null, hoverId: null, scrollNonce: 0 });
  });

  // ── focusAnnotation ─────────────────────────────────────────────────────────

  it('focusAnnotation sets activeId', () => {
    focusAnnotation('ann-1');
    expect(getState().activeId).toBe('ann-1');
  });

  it('focusAnnotation bumps scrollNonce from 0 to 1', () => {
    expect(getState().scrollNonce).toBe(0);
    focusAnnotation('ann-1');
    expect(getState().scrollNonce).toBe(1);
  });

  it('focusAnnotation bumps scrollNonce on re-click of the same id (D5)', () => {
    focusAnnotation('ann-1');
    const nonceAfterFirst = getState().scrollNonce;
    focusAnnotation('ann-1'); // re-click same id
    expect(getState().scrollNonce).toBe(nonceAfterFirst + 1);
    expect(getState().activeId).toBe('ann-1');
  });

  it('focusAnnotation bumps scrollNonce on every distinct call', () => {
    focusAnnotation('ann-1');
    focusAnnotation('ann-2');
    focusAnnotation('ann-1');
    expect(getState().scrollNonce).toBe(3);
    expect(getState().activeId).toBe('ann-1');
  });

  // ── clearFocus ──────────────────────────────────────────────────────────────

  it('clearFocus resets activeId to null', () => {
    focusAnnotation('ann-1');
    clearFocus();
    expect(getState().activeId).toBeNull();
  });

  it('clearFocus resets hoverId to null', () => {
    hoverAnnotation('ann-2');
    clearFocus();
    expect(getState().hoverId).toBeNull();
  });

  it('clearFocus does not reset scrollNonce', () => {
    focusAnnotation('ann-1');
    focusAnnotation('ann-2');
    const nonceBefore = getState().scrollNonce;
    clearFocus();
    expect(getState().scrollNonce).toBe(nonceBefore);
  });

  it('clearFocus is a no-op when already cleared', () => {
    expect(getState().activeId).toBeNull();
    clearFocus();
    expect(getState().activeId).toBeNull();
    expect(getState().hoverId).toBeNull();
  });

  // ── hoverAnnotation ─────────────────────────────────────────────────────────

  it('hoverAnnotation sets hoverId', () => {
    hoverAnnotation('ann-3');
    expect(getState().hoverId).toBe('ann-3');
  });

  it('hoverAnnotation with null clears hoverId', () => {
    hoverAnnotation('ann-3');
    hoverAnnotation(null);
    expect(getState().hoverId).toBeNull();
  });

  it('hoverAnnotation does not change activeId or scrollNonce', () => {
    focusAnnotation('ann-1');
    const before = getState();
    hoverAnnotation('ann-2');
    const after = getState();
    expect(after.activeId).toBe(before.activeId);
    expect(after.scrollNonce).toBe(before.scrollNonce);
  });
});
