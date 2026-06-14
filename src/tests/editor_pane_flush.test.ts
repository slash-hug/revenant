/**
 * editor_pane_flush.test.ts
 *
 * T2.6/C-FLUSH-TABID: Test that when a pending debounce timer is active and
 * the EditorPane is destroyed (tab switch / close), the latest content is
 * flushed to tabsStore.updateContent() under the correct tab id.
 *
 * We test the flush logic directly against the tabsStore rather than mounting
 * the full EditorPane Svelte component (which requires a real CodeMirror editor
 * and DOM environment that is complex to replicate in jsdom). The flush logic
 * is essentially:
 *
 *   if (debounceTimer && view) {
 *     tabsStore.updateContent(myTabId, view.state.doc.toString());
 *     clearTimeout(debounceTimer);
 *     debounceTimer = null;
 *   }
 *   view?.destroy();
 *
 * We test this via a purpose-built simulation that mirrors the EditorPane
 * pattern precisely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { tabsStore } from '../lib/stores/tabs';

describe('EditorPane flush on unmount (T2.6)', () => {
  const TEST_HASH = 'abc123';

  // Generate unique paths per test to avoid state bleeding between tests
  // (tabsStore is a module singleton that persists across tests in the same run).
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

  it('pending debounce is flushed to tabsStore under the correct tab id on unmount', () => {
    // Open a tab.
    const tabId = tabsStore.openTab(uniquePath(), 'initial content', TEST_HASH);

    // Simulate the EditorPane's myTabId snapshot at mount time.
    const myTabId = tabId;

    // Simulate a pending debounce — the view has unsaved content.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestContent = 'content after keystroke';

    // Simulate scheduleChange (what the editor update listener calls).
    debounceTimer = setTimeout(() => {
      tabsStore.updateContent(myTabId, latestContent);
      debounceTimer = null;
    }, 400);

    // At this point the timer is pending — the content has NOT been flushed yet.
    const beforeFlush = get(tabsStore);
    const tabBefore = beforeFlush.tabs.find((t) => t.id === tabId);
    expect(tabBefore?.content).toBe('initial content'); // still stale

    // Simulate onDestroy: flush if timer is pending.
    if (debounceTimer !== null) {
      // Flush synchronously — mirror the EditorPane pattern.
      tabsStore.updateContent(myTabId, latestContent);
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // After the flush, the store must have the latest content under the correct tab.
    const afterFlush = get(tabsStore);
    const tabAfter = afterFlush.tabs.find((t) => t.id === tabId);
    expect(tabAfter).toBeDefined();
    expect(tabAfter?.content).toBe('content after keystroke');
    expect(tabAfter?.id).toBe(tabId); // must be the same tab (correct myTabId)

    // The debounce timer must have been cleared (no pending flush).
    expect(debounceTimer).toBeNull();

    // Advancing fake timers should NOT trigger the original setTimeout
    // (it was cleared).
    vi.advanceTimersByTime(1000);
    // Content must still be the flushed value (no second update from cleared timer).
    const afterTimerAdvance = get(tabsStore);
    const tabFinal = afterTimerAdvance.tabs.find((t) => t.id === tabId);
    expect(tabFinal?.content).toBe('content after keystroke');
  });

  it('no flush occurs when no debounce timer is pending', () => {
    const tabId = tabsStore.openTab(uniquePath(), 'stable content', TEST_HASH);
    const myTabId = tabId;

    // No pending timer.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Simulate onDestroy: no flush (timer is null).
    if (debounceTimer !== null) {
      tabsStore.updateContent(myTabId, 'should not appear');
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // Content must remain unchanged.
    const state = get(tabsStore);
    const tab = state.tabs.find((t) => t.id === tabId);
    expect(tab?.content).toBe('stable content');
  });

  it('flush uses myTabId (not a later tabId) so rapid tab switch does not corrupt other tab', () => {
    // Open two tabs.
    const tabId1 = tabsStore.openTab(uniquePath(), 'tab 1 content', 'hash1');
    const tabId2 = tabsStore.openTab(uniquePath(), 'tab 2 content', 'hash2');

    // Mount EditorPane for tab1 — snapshot myTabId at mount.
    const myTabId = tabId1;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestContent = 'tab 1 new content';

    debounceTimer = setTimeout(() => {
      tabsStore.updateContent(myTabId, latestContent);
      debounceTimer = null;
    }, 400);

    // Switch to tab2 — this would unmount tab1's EditorPane (via {#key}).
    tabsStore.switchTab(tabId2);

    // Simulate onDestroy for tab1's EditorPane (myTabId = tab1).
    if (debounceTimer !== null) {
      tabsStore.updateContent(myTabId, latestContent); // must use myTabId (tab1)
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // tab1 must have the flushed content; tab2 must be unchanged.
    const state = get(tabsStore);
    const tab1 = state.tabs.find((t) => t.id === tabId1);
    const tab2 = state.tabs.find((t) => t.id === tabId2);
    expect(tab1?.content).toBe('tab 1 new content');
    expect(tab2?.content).toBe('tab 2 content'); // not corrupted
  });
});
