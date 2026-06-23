// src/lib/stores/find.ts
/**
 * find.ts — Find & Replace state store.
 *
 * Manages search query, flags, computed matches, navigation index, and
 * replace text. Both EditorPane and PreviewPane subscribe to read match
 * ranges and the current index for highlighting.
 *
 * Pattern follows stores/annotations.ts and stores/tabs.ts: a factory
 * function returning a writable with exposed methods.
 */

import { writable, get } from 'svelte/store';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MatchRange {
  /** Character offset in the document source (inclusive). */
  from: number;
  /** Character offset in the document source (exclusive). */
  to: number;
}

export interface FindState {
  /** Whether the find bar is visible. */
  open: boolean;
  /** Current search string. */
  query: string;
  /** Case-sensitive toggle (Aa). */
  caseSensitive: boolean;
  /** Whole-word toggle (W). */
  wholeWord: boolean;
  /** Regex toggle (.*). */
  useRegex: boolean;
  /** Whether the replace row is expanded. */
  replaceOpen: boolean;
  /** Replacement string. */
  replaceWith: string;
  /** Computed match ranges in the document source. */
  matches: MatchRange[];
  /** Index into matches[] for the active (highlighted) match (-1 = none). */
  currentIndex: number;
  /** Error message when useRegex is on and the pattern is invalid, else null. */
  regexError: string | null;
  /** Snapshot of the current document content (for match computation). */
  content: string;
}

// ── Match computation (pure) ───────────────────────────────────────────────

/**
 * Compute all non-overlapping match ranges for the given query in content.
 * Returns { matches, regexError }.
 */
export function computeMatches(
  content: string,
  query: string,
  flags: { caseSensitive: boolean; wholeWord: boolean; useRegex: boolean },
): { matches: MatchRange[]; regexError: string | null } {
  if (!query || !content) return { matches: [], regexError: null };

  let pattern: RegExp;
  try {
    let source: string;
    if (flags.useRegex) {
      source = query;
    } else {
      // Escape regex special characters for literal search.
      source = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    if (flags.wholeWord) {
      source = `\\b${source}\\b`;
    }

    const regexFlags = flags.caseSensitive ? 'g' : 'gi';
    pattern = new RegExp(source, regexFlags);
  } catch (e) {
    return { matches: [], regexError: (e as Error).message };
  }

  // Guard against zero-length matches (e.g. regex `a*`) causing infinite loops.
  const matches: MatchRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (m[0].length === 0) {
      // Advance past zero-length match to avoid infinite loop.
      pattern.lastIndex = m.index + 1;
      continue;
    }
    matches.push({ from: m.index, to: m.index + m[0].length });
  }

  return { matches, regexError: null };
}

// ── Store factory ──────────────────────────────────────────────────────────

const INITIAL_STATE: FindState = {
  open: false,
  query: '',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  replaceOpen: false,
  replaceWith: '',
  matches: [],
  currentIndex: -1,
  regexError: null,
  content: '',
};

function createFindStore() {
  const { subscribe, update, set } = writable<FindState>(INITIAL_STATE);

  /** Recompute matches from current state and update. */
  function recomputeFromState(s: FindState): FindState {
    const { matches, regexError } = computeMatches(s.content, s.query, {
      caseSensitive: s.caseSensitive,
      wholeWord: s.wholeWord,
      useRegex: s.useRegex,
    });
    const currentIndex = matches.length > 0 ? 0 : -1;
    return { ...s, matches, regexError, currentIndex };
  }

  return {
    subscribe,

    /** Open the find bar (find-only mode). */
    openFind() {
      update((s) => {
        if (s.open) return s; // already open — don't reset
        return { ...s, open: true, replaceOpen: false };
      });
    },

    /** Open the find bar with the replace row expanded. */
    openReplace() {
      update((s) => ({ ...s, open: true, replaceOpen: true }));
    },

    /** Close the find bar and clear all state. */
    close() {
      update((s) => ({
        ...s,
        open: false,
        matches: [],
        currentIndex: -1,
        regexError: null,
      }));
    },

    /** Set the search query and recompute matches. */
    setQuery(query: string) {
      update((s) => recomputeFromState({ ...s, query }));
    },

    /** Toggle case-sensitive flag and recompute. */
    toggleCaseSensitive() {
      update((s) => recomputeFromState({ ...s, caseSensitive: !s.caseSensitive }));
    },

    /** Toggle whole-word flag and recompute. */
    toggleWholeWord() {
      update((s) => recomputeFromState({ ...s, wholeWord: !s.wholeWord }));
    },

    /** Toggle regex flag and recompute. */
    toggleRegex() {
      update((s) => recomputeFromState({ ...s, useRegex: !s.useRegex }));
    },

    /** Set the replace-with string. */
    setReplaceWith(replaceWith: string) {
      update((s) => ({ ...s, replaceWith }));
    },

    /** Toggle the replace row open/closed. */
    toggleReplaceOpen() {
      update((s) => ({ ...s, replaceOpen: !s.replaceOpen }));
    },

    /** Navigate to the next match (wraps around). */
    nextMatch() {
      update((s) => {
        if (s.matches.length === 0) return s;
        const next = (s.currentIndex + 1) % s.matches.length;
        return { ...s, currentIndex: next };
      });
    },

    /** Navigate to the previous match (wraps around). */
    prevMatch() {
      update((s) => {
        if (s.matches.length === 0) return s;
        const prev = (s.currentIndex - 1 + s.matches.length) % s.matches.length;
        return { ...s, currentIndex: prev };
      });
    },

    /**
     * Recompute matches against new document content.
     * Called on tab switch or after replace operations.
     */
    recompute(content: string) {
      update((s) => recomputeFromState({ ...s, content }));
    },

    /**
     * After a replace operation, update content and recompute.
     * Adjusts currentIndex to stay at the same position or clamp.
     */
    afterReplace(newContent: string, replacedIndex: number) {
      update((s) => {
        const { matches, regexError } = computeMatches(newContent, s.query, {
          caseSensitive: s.caseSensitive,
          wholeWord: s.wholeWord,
          useRegex: s.useRegex,
        });
        let currentIndex = replacedIndex;
        if (matches.length === 0) {
          currentIndex = -1;
        } else if (currentIndex >= matches.length) {
          currentIndex = 0;
        }
        return { ...s, content: newContent, matches, regexError, currentIndex };
      });
    },

    /** Full reset (used in tests and on document close). */
    reset() {
      set(INITIAL_STATE);
    },

    /** Get current state snapshot (for imperative callers). */
    get snapshot(): FindState {
      return get({ subscribe });
    },
  };
}

export const findStore = createFindStore();
