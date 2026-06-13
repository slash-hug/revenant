/**
 * tabs.ts — Tab state store.
 *
 * Manages the collection of open document tabs. Each tab owns:
 *  - the file path and current in-memory content
 *  - a dirty flag (unsaved changes)
 *  - the last-known content hash from the Rust core (for optimistic-concurrency saves)
 *
 * Decisions implemented here:
 *  - C1 tab open/close/switch, dirty dot, focus-existing-tab on duplicate open.
 *  - A5 expected_hash tracked per tab so save_file can pass it.
 */

import { writable, derived, get } from 'svelte/store';
import type { Writable } from 'svelte/store';

export interface Tab {
  id: string;
  path: string;
  content: string;
  /** The hash the Rust core gave us on last open/save — fed back to save_file. */
  contentHash: string;
  dirty: boolean;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
}

function createTabsStore() {
  const store: Writable<TabsState> = writable({
    tabs: [],
    activeTabId: null,
  });

  const { subscribe, update } = store;

  function generateId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Open a file in a tab. If the path is already open, switch to that tab
   * instead of duplicating (focus-existing-tab rule from C1).
   */
  function openTab(path: string, content: string, contentHash: string): string {
    let existingId: string | null = null;

    update((state) => {
      const existing = state.tabs.find((t) => t.path === path);
      if (existing) {
        existingId = existing.id;
        return { ...state, activeTabId: existing.id };
      }

      const newTab: Tab = {
        id: generateId(),
        path,
        content,
        contentHash,
        dirty: false,
      };
      existingId = newTab.id;
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      };
    });

    return existingId!;
  }

  /**
   * Close a tab. If it was the active tab, activate the nearest remaining tab.
   */
  function closeTab(id: string): void {
    update((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return state;

      const newTabs = state.tabs.filter((t) => t.id !== id);

      let newActiveId: string | null = null;
      if (state.activeTabId === id) {
        // Prefer the tab to the left, else the one to the right, else null.
        if (newTabs.length > 0) {
          const targetIdx = Math.max(0, idx - 1);
          newActiveId = newTabs[Math.min(targetIdx, newTabs.length - 1)].id;
        }
      } else {
        newActiveId = state.activeTabId;
      }

      return { tabs: newTabs, activeTabId: newActiveId };
    });
  }

  /** Make a tab the active (focused) one. */
  function switchTab(id: string): void {
    update((state) => {
      if (!state.tabs.find((t) => t.id === id)) return state;
      return { ...state, activeTabId: id };
    });
  }

  /**
   * Update the in-memory content of a tab and mark it dirty.
   * Called on every debounced editor change.
   */
  function updateContent(id: string, content: string): void {
    update((state) => ({
      ...state,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, dirty: true } : t
      ),
    }));
  }

  /**
   * Called after a successful save: clear the dirty flag and update
   * the stored content hash so the next save uses the correct expected_hash.
   */
  function markSaved(id: string, newHash: string): void {
    update((state) => ({
      ...state,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, dirty: false, contentHash: newHash } : t
      ),
    }));
  }

  /**
   * Called after a Reload conflict resolution: replace in-memory content
   * with the fresh disk content and clear dirty flag.
   */
  function reloadTab(id: string, content: string, newHash: string): void {
    update((state) => ({
      ...state,
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, contentHash: newHash, dirty: false } : t
      ),
    }));
  }

  return {
    subscribe,
    openTab,
    closeTab,
    switchTab,
    updateContent,
    markSaved,
    reloadTab,
    /** Snapshot of the current state (for imperative callers). */
    get snapshot(): TabsState {
      return get(store);
    },
  };
}

export const tabsStore = createTabsStore();

/** Derived: just the active Tab object, or null. */
export const activeTab = derived(tabsStore, ($tabs) =>
  $tabs.tabs.find((t) => t.id === $tabs.activeTabId) ?? null
);

/** Derived: list of tabs (for the tab bar). */
export const tabList = derived(tabsStore, ($tabs) => $tabs.tabs);
