/**
 * editor-flush.ts — EditorPane onDestroy flush helper (T2.6/C-FLUSH-TABID).
 *
 * Extracted from EditorPane.svelte so the flush logic can be unit-tested
 * without mounting a live CodeMirror instance. EditorPane imports and calls
 * this function; tests import and call it directly — both exercise the same
 * production code path (closes the fidelity gap documented in T2.6).
 */

import type { EditorView } from '@codemirror/view';
import type { tabsStore as TabsStoreType } from './stores/tabs';

/**
 * Flush any pending debounce timer on EditorPane unmount (onDestroy).
 *
 * If a debounce timer is active, the latest editor content has NOT yet been
 * pushed to the tab store — this flush ensures keystrokes typed within
 * DEBOUNCE_MS of an unmount (e.g. rapid tab switch via {#key $activeTab.id})
 * are not silently discarded.
 *
 * The function is intentionally pure w.r.t. side effects beyond the store
 * write so it can be called from a test without a live Svelte component.
 *
 * @param debounceTimer  - The pending timer id, or null if no timer is active.
 * @param view           - The CodeMirror EditorView, or null if not yet mounted.
 * @param myTabId        - The tab id captured at mount time (stable per instance).
 * @param store          - The tabs store (or a compatible mock in tests).
 * @returns              - The timer id to assign back to the caller's variable
 *                         (always null — signals the timer has been cleared).
 */
export function flushPendingDebounce(
  debounceTimer: ReturnType<typeof setTimeout> | null,
  view: EditorView | null,
  myTabId: string,
  store: Pick<typeof TabsStoreType, 'updateContent'>,
): null {
  if (debounceTimer !== null && view !== null) {
    store.updateContent(myTabId, view.state.doc.toString());
    clearTimeout(debounceTimer);
  }
  return null;
}
