/**
 * editor_pane_flush.test.ts
 *
 * T2.6/C-FLUSH-TABID: Test that when a pending debounce timer is active and
 * the EditorPane is destroyed (tab switch / close), the latest content is
 * flushed to tabsStore.updateContent() under the correct tab id.
 *
 * FIDELITY: These tests import and call `flushPendingDebounce` from
 * `src/lib/editor-flush.ts` — the same function that EditorPane.svelte's
 * onDestroy hook calls in production. This closes the previous fidelity gap
 * where the test re-implemented the flush logic inline. A regression in the
 * production helper (e.g. inverted guard, wrong tabId captured) will now fail
 * these tests.
 *
 * The CodeMirror EditorView is simulated with a minimal stub that exposes only
 * the `state.doc.toString()` surface used by `flushPendingDebounce`, avoiding
 * the need to mount a live CodeMirror instance in jsdom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { tabsStore } from '../lib/stores/tabs';
import { flushPendingDebounce } from '../lib/editor-flush';
import type { EditorView } from '@codemirror/view';

// ---------------------------------------------------------------------------
// Minimal EditorView stub
// Satisfies the `view.state.doc.toString()` call in flushPendingDebounce.
// ---------------------------------------------------------------------------
function makeView(content: string): EditorView {
  return {
    state: {
      doc: {
        toString: () => content,
      },
    },
  } as unknown as EditorView;
}

describe('EditorPane flush on unmount (T2.6/C-FLUSH-TABID) — production code path', () => {
  const TEST_HASH = 'abc123';

  let testCounter = 0;
  function uniquePath(): string {
    return `/test/doc-${testCounter++}.md`;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── T1: pending debounce is flushed under the correct tab id ─────────────

  it('flushPendingDebounce writes content to the store under the correct tab id', () => {
    const tabId = tabsStore.openTab(uniquePath(), 'initial content', TEST_HASH);
    const myTabId = tabId; // snapshot at mount time, as EditorPane does

    // Simulate a pending debounce timer.
    const latestContent = 'content after keystroke';
    const debounceTimer = setTimeout(() => {
      // This path is cleared by flushPendingDebounce — should not run.
      tabsStore.updateContent(myTabId, 'timer-fired (should not happen)');
    }, 400);

    // Content is still stale before the flush.
    const before = get(tabsStore).tabs.find((t) => t.id === tabId);
    expect(before?.content).toBe('initial content');

    // Call the production flush function with a minimal view stub.
    const view = makeView(latestContent);
    const returnedTimer = flushPendingDebounce(debounceTimer, view, myTabId, tabsStore);

    // The function must clear the timer (return null).
    expect(returnedTimer).toBeNull();

    // The store must have been updated with the latest content.
    const after = get(tabsStore).tabs.find((t) => t.id === tabId);
    expect(after?.content).toBe('content after keystroke');
    expect(after?.id).toBe(tabId);

    // Advancing fake timers must NOT trigger the original setTimeout
    // (it was cleared inside flushPendingDebounce).
    vi.advanceTimersByTime(1000);
    const final = get(tabsStore).tabs.find((t) => t.id === tabId);
    expect(final?.content).toBe('content after keystroke');
  });

  // ── T2: no flush when no timer is pending ────────────────────────────────

  it('flushPendingDebounce is a no-op when debounceTimer is null', () => {
    const tabId = tabsStore.openTab(uniquePath(), 'stable content', TEST_HASH);

    const returnedTimer = flushPendingDebounce(null, makeView('should not appear'), tabId, tabsStore);

    expect(returnedTimer).toBeNull();
    const state = get(tabsStore).tabs.find((t) => t.id === tabId);
    expect(state?.content).toBe('stable content');
  });

  // ── T3: no flush when view is null (before onMount completes) ────────────

  it('flushPendingDebounce is a no-op when view is null', () => {
    const tabId = tabsStore.openTab(uniquePath(), 'original', TEST_HASH);

    const debounceTimer = setTimeout(() => {}, 400);
    // view is null — simulates onDestroy racing with onMount
    const returnedTimer = flushPendingDebounce(debounceTimer, null, tabId, tabsStore);

    expect(returnedTimer).toBeNull();
    const state = get(tabsStore).tabs.find((t) => t.id === tabId);
    // Content must not be corrupted by a null view.
    expect(state?.content).toBe('original');
  });

  // ── T4: myTabId isolation — flush targets the mounted tab, not the active ─

  it('flush uses myTabId so a rapid tab switch does not corrupt the new active tab', () => {
    const tabId1 = tabsStore.openTab(uniquePath(), 'tab 1 content', 'hash1');
    const tabId2 = tabsStore.openTab(uniquePath(), 'tab 2 content', 'hash2');

    // EditorPane for tab1 snapshots myTabId at mount.
    const myTabId = tabId1;
    const latestContent = 'tab 1 new content';

    const debounceTimer = setTimeout(() => {}, 400);
    tabsStore.switchTab(tabId2);

    // onDestroy fires for tab1's EditorPane — must write to tab1, not tab2.
    flushPendingDebounce(debounceTimer, makeView(latestContent), myTabId, tabsStore);

    const state = get(tabsStore);
    const tab1 = state.tabs.find((t) => t.id === tabId1);
    const tab2 = state.tabs.find((t) => t.id === tabId2);

    expect(tab1?.content).toBe('tab 1 new content');
    expect(tab2?.content).toBe('tab 2 content'); // must not be corrupted
  });
});
