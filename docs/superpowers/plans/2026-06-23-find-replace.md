# Find & Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a custom find-and-replace UI that highlights matches in both the source (CodeMirror) and preview (CSS Custom Highlight API) panes simultaneously, with full replace support.
**Architecture:** A shared reactive store (`find.ts`) computes match ranges from the raw markdown source. CodeMirror renders those ranges via `StateField` + `Decoration.mark`; the preview pane renders them via the CSS Custom Highlight API (`CSS.highlights`). A floating `FindBar.svelte` component (Svelte 5 runes) provides the search/replace UI.
**Tech Stack:** Svelte 5 (runes), CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), CSS Custom Highlight API, Vitest + jsdom

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| **Create** | `src/lib/stores/find.ts` | Reactive find state store + match computation |
| **Create** | `src/lib/find-highlight.ts` | CM6 extension exports + preview highlight helpers |
| **Create** | `src/lib/FindBar.svelte` | Floating find/replace UI (Svelte 5) |
| **Create** | `src/tests/find_store.test.ts` | Unit tests for find store |
| **Create** | `src/tests/find_highlight.test.ts` | Unit tests for highlight logic |
| **Modify** | `src/lib/styles/markdown.css` | Add `::highlight(find-match)` / `::highlight(find-active)` styles |
| **Modify** | `src/lib/EditorPane.svelte` | Add find CM6 extension + replace methods |
| **Modify** | `src/lib/PreviewPane.svelte` | Add find highlight rendering |
| **Modify** | `src/App.svelte` | Mount FindBar, add Ctrl+F/H, wire replace, position: relative |
| **Modify** | `src/lib/KeyboardShortcutsModal.svelte` | Add Find/Replace shortcut entries |

---

## Task 1: Find Store

**Files:**
- **Create:** `src/lib/stores/find.ts`

### Steps

- [ ] **1.1** Create `src/lib/stores/find.ts` with the complete find store:

```typescript
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
```

- [ ] **1.2** Verify the file compiles:

```
npx tsc --noEmit --pretty 2>&1 | Select-String "find.ts"
```

Expected: no errors mentioning `find.ts`.

- [ ] **1.3** Commit:

```
git add src/lib/stores/find.ts
git commit -m "feat(find): add reactive find store with match computation

Implements FindState, computeMatches (plain/case-sensitive/whole-word/regex),
navigation (next/prev with wrap), open/close, and recompute for tab switch.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Find Store Tests

**Files:**
- **Create:** `src/tests/find_store.test.ts`

### Steps

- [ ] **2.1** Create `src/tests/find_store.test.ts`:

```typescript
// src/tests/find_store.test.ts
/**
 * Unit tests for the find store (stores/find.ts).
 *
 * Covers: computeMatches (all flag combos), navigation, open/close, recompute,
 * regex error handling, edge cases (empty query, empty document, overlapping).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { findStore, computeMatches } from '../lib/stores/find';
import type { FindState } from '../lib/stores/find';

function state(): FindState {
  return get(findStore);
}

beforeEach(() => {
  findStore.reset();
});

// ── computeMatches (pure function) ─────────────────────────────────────────

describe('computeMatches', () => {
  const FLAGS_DEFAULT = { caseSensitive: false, wholeWord: false, useRegex: false };

  it('finds all occurrences case-insensitively by default', () => {
    const { matches } = computeMatches('Hello hello HELLO', 'hello', FLAGS_DEFAULT);
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ from: 0, to: 5 });
    expect(matches[1]).toEqual({ from: 6, to: 11 });
    expect(matches[2]).toEqual({ from: 12, to: 17 });
  });

  it('respects case-sensitive flag', () => {
    const { matches } = computeMatches('Hello hello HELLO', 'hello', {
      ...FLAGS_DEFAULT,
      caseSensitive: true,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ from: 6, to: 11 });
  });

  it('respects whole-word flag', () => {
    const { matches } = computeMatches('cat concatenate category cat', 'cat', {
      ...FLAGS_DEFAULT,
      wholeWord: true,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ from: 0, to: 3 });
    expect(matches[1]).toEqual({ from: 25, to: 28 });
  });

  it('supports regex mode', () => {
    const { matches } = computeMatches('foo123 bar456 baz', '\\d+', {
      ...FLAGS_DEFAULT,
      useRegex: true,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ from: 3, to: 6 });
    expect(matches[1]).toEqual({ from: 10, to: 13 });
  });

  it('returns regexError for invalid regex', () => {
    const { matches, regexError } = computeMatches('hello', '[invalid', {
      ...FLAGS_DEFAULT,
      useRegex: true,
    });
    expect(matches).toHaveLength(0);
    expect(regexError).toBeTruthy();
  });

  it('returns empty for empty query', () => {
    const { matches, regexError } = computeMatches('hello world', '', FLAGS_DEFAULT);
    expect(matches).toHaveLength(0);
    expect(regexError).toBeNull();
  });

  it('returns empty for empty content', () => {
    const { matches } = computeMatches('', 'hello', FLAGS_DEFAULT);
    expect(matches).toHaveLength(0);
  });

  it('escapes regex special characters in literal mode', () => {
    const { matches } = computeMatches('price is $100.00 or $200', '$100.00', FLAGS_DEFAULT);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ from: 9, to: 16 });
  });

  it('handles zero-length regex matches without infinite loop', () => {
    const { matches } = computeMatches('aaa', 'a*', {
      ...FLAGS_DEFAULT,
      useRegex: true,
    });
    // Should not hang; matches non-empty occurrences
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.to - m.from).toBeGreaterThan(0);
    }
  });

  it('combines whole-word + case-sensitive', () => {
    const { matches } = computeMatches('Cat cat CAT concatenate', 'cat', {
      caseSensitive: true,
      wholeWord: true,
      useRegex: false,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({ from: 4, to: 7 });
  });

  it('handles multi-line content', () => {
    const content = 'line one\nline two\nline three';
    const { matches } = computeMatches(content, 'line', FLAGS_DEFAULT);
    expect(matches).toHaveLength(3);
  });
});

// ── Store integration ──────────────────────────────────────────────────────

describe('findStore', () => {
  describe('open / close', () => {
    it('starts closed with no matches', () => {
      const s = state();
      expect(s.open).toBe(false);
      expect(s.matches).toHaveLength(0);
      expect(s.currentIndex).toBe(-1);
    });

    it('openFind() opens the bar', () => {
      findStore.openFind();
      expect(state().open).toBe(true);
      expect(state().replaceOpen).toBe(false);
    });

    it('openReplace() opens with replace row', () => {
      findStore.openReplace();
      expect(state().open).toBe(true);
      expect(state().replaceOpen).toBe(true);
    });

    it('close() hides bar and clears matches', () => {
      findStore.openFind();
      findStore.recompute('hello world hello');
      findStore.setQuery('hello');
      expect(state().matches.length).toBeGreaterThan(0);

      findStore.close();
      expect(state().open).toBe(false);
      expect(state().matches).toHaveLength(0);
      expect(state().currentIndex).toBe(-1);
    });
  });

  describe('setQuery + recompute', () => {
    it('computes matches when query is set after content', () => {
      findStore.recompute('apple banana apple cherry');
      findStore.setQuery('apple');
      const s = state();
      expect(s.matches).toHaveLength(2);
      expect(s.currentIndex).toBe(0);
    });

    it('updates matches when content changes via recompute', () => {
      findStore.setQuery('hello');
      findStore.recompute('hello world hello');
      expect(state().matches).toHaveLength(2);

      findStore.recompute('goodbye world');
      expect(state().matches).toHaveLength(0);
      expect(state().currentIndex).toBe(-1);
    });
  });

  describe('navigation', () => {
    beforeEach(() => {
      findStore.recompute('aaa');
      findStore.setQuery('a');
      // 3 matches at positions 0, 1, 2
    });

    it('nextMatch advances and wraps', () => {
      expect(state().currentIndex).toBe(0);
      findStore.nextMatch();
      expect(state().currentIndex).toBe(1);
      findStore.nextMatch();
      expect(state().currentIndex).toBe(2);
      findStore.nextMatch();
      expect(state().currentIndex).toBe(0); // wrapped
    });

    it('prevMatch goes backward and wraps', () => {
      expect(state().currentIndex).toBe(0);
      findStore.prevMatch();
      expect(state().currentIndex).toBe(2); // wrapped to end
      findStore.prevMatch();
      expect(state().currentIndex).toBe(1);
    });

    it('nextMatch is no-op with no matches', () => {
      findStore.setQuery('zzz');
      expect(state().matches).toHaveLength(0);
      findStore.nextMatch();
      expect(state().currentIndex).toBe(-1);
    });
  });

  describe('flags', () => {
    it('toggleCaseSensitive recomputes matches', () => {
      findStore.recompute('Hello hello');
      findStore.setQuery('hello');
      expect(state().matches).toHaveLength(2);

      findStore.toggleCaseSensitive();
      expect(state().caseSensitive).toBe(true);
      expect(state().matches).toHaveLength(1);
    });

    it('toggleWholeWord recomputes matches', () => {
      findStore.recompute('cat concatenate');
      findStore.setQuery('cat');
      expect(state().matches).toHaveLength(2);

      findStore.toggleWholeWord();
      expect(state().wholeWord).toBe(true);
      expect(state().matches).toHaveLength(1);
    });

    it('toggleRegex recomputes matches', () => {
      findStore.recompute('foo123 bar');
      findStore.setQuery('\\d+');
      // In literal mode, backslash+d won't match digits
      expect(state().matches).toHaveLength(0);

      findStore.toggleRegex();
      expect(state().useRegex).toBe(true);
      expect(state().matches).toHaveLength(1);
    });
  });

  describe('replace tracking', () => {
    it('setReplaceWith updates the replacement string', () => {
      findStore.setReplaceWith('world');
      expect(state().replaceWith).toBe('world');
    });

    it('afterReplace updates content and recomputes', () => {
      findStore.recompute('aaa');
      findStore.setQuery('a');
      expect(state().matches).toHaveLength(3);

      // Simulate replacing the first 'a' with 'b'
      findStore.afterReplace('baa', 0);
      expect(state().content).toBe('baa');
      expect(state().matches).toHaveLength(2);
      expect(state().currentIndex).toBe(0);
    });

    it('afterReplace clamps currentIndex when matches shrink', () => {
      findStore.recompute('aa');
      findStore.setQuery('a');
      findStore.nextMatch(); // index 1
      expect(state().currentIndex).toBe(1);

      // Replace both → no matches
      findStore.afterReplace('bb', 1);
      expect(state().matches).toHaveLength(0);
      expect(state().currentIndex).toBe(-1);
    });
  });

  describe('reset', () => {
    it('restores initial state', () => {
      findStore.openFind();
      findStore.setQuery('test');
      findStore.recompute('test content');
      findStore.toggleCaseSensitive();

      findStore.reset();
      const s = state();
      expect(s.open).toBe(false);
      expect(s.query).toBe('');
      expect(s.matches).toHaveLength(0);
      expect(s.caseSensitive).toBe(false);
    });
  });
});
```

- [ ] **2.2** Run the tests:

```
npx vitest run src/tests/find_store.test.ts
```

Expected: all tests pass.

- [ ] **2.3** Commit:

```
git add src/tests/find_store.test.ts
git commit -m "test(find): add comprehensive find store tests

Covers computeMatches (case, whole-word, regex, edge cases),
navigation wrap-around, open/close, recompute, flag toggles,
replace tracking, and reset.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Find Highlight Module

**Files:**
- **Create:** `src/lib/find-highlight.ts`

### Steps

- [ ] **3.1** Create `src/lib/find-highlight.ts`:

```typescript
// src/lib/find-highlight.ts
/**
 * find-highlight.ts — Highlight logic for find & replace in both panes.
 *
 * Exports:
 *  - CodeMirror 6 extension pieces (StateEffect, StateField, decorations, theme)
 *  - Preview highlight helpers (CSS Custom Highlight API wrappers)
 *
 * The CM6 extension follows the same pattern as the annotation wash in
 * EditorPane.svelte (StateEffect → StateField → DecorationSet).
 * The preview helpers follow annotationHighlight.ts (CSS.highlights API).
 */

import {
  EditorView,
  Decoration,
} from '@codemirror/view';
import {
  StateField,
  StateEffect,
  RangeSetBuilder,
} from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { MatchRange } from './stores/find';
import { isHighlightSupported } from './annotationHighlight';

// ── CodeMirror 6 extension ─────────────────────────────────────────────────

/** Effect: push new match ranges into the CM6 state. */
export const setFindMatchesEffect = StateEffect.define<MatchRange[]>();

/** Effect: update which match index is currently active. */
export const setFindActiveIndexEffect = StateEffect.define<number>();

interface FindCmState {
  matches: MatchRange[];
  activeIndex: number;
}

/**
 * StateField holding find match ranges and the active index.
 * Present in the EditorState.create extensions array from creation.
 */
export const findCmField = StateField.define<FindCmState>({
  create() {
    return { matches: [], activeIndex: -1 };
  },
  update(state, tr) {
    let { matches, activeIndex } = state;
    for (const effect of tr.effects) {
      if (effect.is(setFindMatchesEffect)) matches = effect.value;
      if (effect.is(setFindActiveIndexEffect)) activeIndex = effect.value;
    }
    return { matches, activeIndex };
  },
});

/**
 * Build a DecorationSet from the find matches.
 * All matches get `.cm-find-match`; the active match also gets `.cm-find-match-active`.
 */
export function buildFindDecorations(
  matches: MatchRange[],
  activeIndex: number,
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // Collect marks and sort by `from` (RangeSetBuilder requires ascending order).
  const marks: { from: number; to: number; cls: string }[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    // Guard against out-of-bounds ranges (can happen during document transitions).
    if (m.from < 0 || m.to > docLength || m.from >= m.to) continue;
    const cls = i === activeIndex ? 'cm-find-match cm-find-match-active' : 'cm-find-match';
    marks.push({ from: m.from, to: m.to, cls });
  }
  marks.sort((a, b) => a.from - b.from);

  for (const m of marks) {
    builder.add(m.from, m.to, Decoration.mark({ class: m.cls }));
  }
  return builder.finish();
}

/** Extension: decoration provider derived from findCmField. */
export const findDecorationExt: Extension = EditorView.decorations.of(
  (view) => {
    const { matches, activeIndex } = view.state.field(findCmField);
    return buildFindDecorations(matches, activeIndex, view.state.doc.length);
  },
);

/** Extension: theme for find-match decoration classes. */
export const findThemeExt: Extension = EditorView.theme({
  '.cm-find-match': {
    background: 'var(--accent-soft)',
    border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
    borderRadius: '2px',
  },
  '.cm-find-match-active': {
    background: 'color-mix(in srgb, var(--accent) 30%, transparent)',
    border: '1px solid var(--accent)',
    boxShadow: '0 0 4px color-mix(in srgb, var(--accent) 25%, transparent)',
  },
});

// ── Preview pane highlights (CSS Custom Highlight API) ─────────────────────

/**
 * Refresh find highlights in the preview pane.
 *
 * Walks text nodes in previewEl, maps source-offset match ranges to DOM
 * Range objects, and registers them as CSS Custom Highlights.
 *
 * The source→preview mapping is approximate: we use the `data-source-line`
 * attributes on block elements to find the right region, then walk text
 * nodes to locate the match text. This handles most cases but may miss
 * matches that span across block boundaries (rare in practice).
 */
export function refreshFindHighlights(
  previewEl: HTMLElement,
  matches: MatchRange[],
  activeIndex: number,
  content: string,
): void {
  if (!isHighlightSupported()) return;
  const highlights = (CSS as unknown as { highlights: CSSHighlightMap }).highlights;

  if (matches.length === 0) {
    highlights.delete('find-match');
    highlights.delete('find-active');
    return;
  }

  // Collect all text nodes in the preview in document order.
  const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  if (textNodes.length === 0) {
    highlights.delete('find-match');
    highlights.delete('find-active');
    return;
  }

  // Build a virtual text string from all text nodes and track offsets.
  let virtualText = '';
  const nodeOffsets: { node: Text; start: number }[] = [];
  for (const tn of textNodes) {
    nodeOffsets.push({ node: tn, start: virtualText.length });
    virtualText += tn.textContent ?? '';
  }

  // For each source match, find the corresponding text in the preview's
  // virtual text. We extract the match text from the source content and
  // search for it in the preview text near the expected position.
  const passiveRanges: Range[] = [];
  let activeRange: Range | null = null;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const matchText = content.slice(m.from, m.to);
    if (!matchText) continue;

    // Search for the match text in the virtual preview text.
    // Use a simple progressive search: start from the beginning and find
    // each occurrence in order. This works because matches are sorted by
    // position and the preview text preserves document order.
    const searchResult = findInVirtualText(virtualText, matchText, i, matches, content);
    if (searchResult === null) continue;

    const domRange = buildDomRange(searchResult.from, searchResult.to, nodeOffsets);
    if (!domRange) continue;

    if (i === activeIndex) {
      activeRange = domRange;
    } else {
      passiveRanges.push(domRange);
    }
  }

  if (passiveRanges.length > 0 || activeRange) {
    const allPassive = activeRange
      ? [...passiveRanges]
      : passiveRanges;
    if (allPassive.length > 0) {
      highlights.set('find-match', new Highlight(...allPassive));
    } else {
      highlights.delete('find-match');
    }
  } else {
    highlights.delete('find-match');
  }

  if (activeRange) {
    highlights.set('find-active', new Highlight(activeRange));
  } else {
    highlights.delete('find-active');
  }
}

/**
 * Find the match text in the preview's virtual text.
 * Uses indexOf for simplicity — case-sensitive since the match text is already
 * extracted from the source and the preview renders the same content.
 */
function findInVirtualText(
  virtualText: string,
  matchText: string,
  matchIndex: number,
  _allMatches: MatchRange[],
  _content: string,
): { from: number; to: number } | null {
  // Strip markdown inline syntax from match text for preview matching.
  // The preview renders markdown, so `**bold**` becomes `bold` in the DOM.
  const stripped = matchText.replace(/[*_~`]/g, '');
  if (!stripped) return null;

  // Find all occurrences and pick the one at the Nth position
  // (assuming matches are in document order and preview preserves order).
  let searchFrom = 0;
  let found = 0;
  // Count how many times this same text appears before this match in source
  // to pick the correct occurrence in preview.
  let targetOccurrence = 0;
  for (let i = 0; i < matchIndex; i++) {
    const prevText = _content.slice(_allMatches[i].from, _allMatches[i].to).replace(/[*_~`]/g, '');
    if (prevText === stripped) targetOccurrence++;
  }

  let idx = virtualText.indexOf(stripped, searchFrom);
  while (idx !== -1) {
    if (found === targetOccurrence) {
      return { from: idx, to: idx + stripped.length };
    }
    found++;
    idx = virtualText.indexOf(stripped, idx + 1);
  }
  return null;
}

/**
 * Build a DOM Range from virtual text offsets using the node offset map.
 */
function buildDomRange(
  from: number,
  to: number,
  nodeOffsets: { node: Text; start: number }[],
): Range | null {
  function resolvePoint(offset: number): { node: Text; offset: number } | null {
    let best: { node: Text; start: number } | null = null;
    for (const entry of nodeOffsets) {
      if (entry.start <= offset) {
        best = entry;
      } else {
        break;
      }
    }
    if (!best) return null;
    const localOffset = offset - best.start;
    const nodeLen = best.node.textContent?.length ?? 0;
    if (localOffset > nodeLen) return null;
    return { node: best.node, offset: localOffset };
  }

  const startPoint = resolvePoint(from);
  const endPoint = resolvePoint(to);
  if (!startPoint || !endPoint) return null;

  try {
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  } catch {
    return null;
  }
}

/** Clear all find highlights from the preview. */
export function clearFindHighlights(): void {
  if (!isHighlightSupported()) return;
  const highlights = (CSS as unknown as { highlights: CSSHighlightMap }).highlights;
  highlights.delete('find-match');
  highlights.delete('find-active');
}

// ── TypeScript shims ───────────────────────────────────────────────────────
// Reuse the same shapes as annotationHighlight.ts.

interface CSSHighlightMap {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
  has(name: string): boolean;
}

declare class Highlight {
  constructor(...ranges: Range[]);
}
```

- [ ] **3.2** Verify compilation:

```
npx tsc --noEmit --pretty 2>&1 | Select-String "find-highlight"
```

Expected: no errors mentioning `find-highlight.ts`.

- [ ] **3.3** Commit:

```
git add src/lib/find-highlight.ts
git commit -m "feat(find): add CM6 extension + preview highlight helpers

CodeMirror: StateField, DecorationSet with .cm-find-match/.cm-find-match-active,
theme with accent tokens. Preview: CSS Custom Highlight API wrappers using
the same pattern as annotationHighlight.ts.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Find Highlight Tests

**Files:**
- **Create:** `src/tests/find_highlight.test.ts`

### Steps

- [ ] **4.1** Create `src/tests/find_highlight.test.ts`:

```typescript
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
  let mockHighlights: Map<string, unknown>;

  beforeEach(() => {
    mockHighlights = new Map();
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
```

- [ ] **4.2** Run the tests:

```
npx vitest run src/tests/find_highlight.test.ts
```

Expected: all tests pass.

- [ ] **4.3** Commit:

```
git add src/tests/find_highlight.test.ts
git commit -m "test(find): add find highlight tests

Covers CM6 buildFindDecorations (normal, out-of-bounds, zero-length, unsorted),
preview highlight no-throw in jsdom, and mocked CSS.highlights integration.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: CSS Highlight Styles

**Files:**
- **Modify:** `src/lib/styles/markdown.css`

### Steps

- [ ] **5.1** Add `::highlight(find-match)` and `::highlight(find-active)` styles to the end of `src/lib/styles/markdown.css` (before the closing comment or at the very end):

Find the last rule in the file and add after it:

```css
/* ---- Find & Replace highlights (CSS Custom Highlight API) ---- */
::highlight(find-match) {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
::highlight(find-active) {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
}
```

To apply this edit, find the last CSS rule block in `markdown.css` and append these styles after it.

- [ ] **5.2** Verify the CSS file is syntactically valid:

```
npm run build 2>&1 | Select-String -Pattern "error|Error" | Select-Object -First 5
```

Expected: no CSS-related errors.

- [ ] **5.3** Commit:

```
git add src/lib/styles/markdown.css
git commit -m "style(find): add ::highlight CSS for find-match and find-active

Uses accent color at 18% (passive) and 35% (active) via color-mix,
matching the annotation-wash pattern. Renders via CSS Custom Highlight API.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: FindBar Component

**Files:**
- **Create:** `src/lib/FindBar.svelte`

### Steps

- [ ] **6.1** Create `src/lib/FindBar.svelte`:

```svelte
<script lang="ts">
  /**
   * FindBar.svelte — Floating find/replace bar.
   *
   * Svelte 5 runes. Positioned absolutely over the content area (ws-body),
   * centered horizontally, pinned near the top. Styled with Revenant design tokens.
   *
   * Props:
   *  - open (bindable) — whether the bar is visible
   *
   * Events:
   *  - replace  — replace the current active match (detail: { from, to, replacement })
   *  - replaceAll — replace all matches (detail: { matches, replacement })
   *  - close — emitted when the bar is dismissed
   */
  import { findStore } from './stores/find';
  import type { MatchRange } from './stores/find';

  interface Props {
    open?: boolean;
    viewMode?: 'source' | 'split' | 'preview';
  }
  let { open = $bindable(false), viewMode = 'split' }: Props = $props();

  let searchInput: HTMLInputElement | null = $state(null);
  let replaceInput: HTMLInputElement | null = $state(null);

  // Local mirror of store state for reactivity.
  let query = $state('');
  let replaceWith = $state('');
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let useRegex = $state(false);
  let replaceOpen = $state(false);
  let matches: MatchRange[] = $state([]);
  let currentIndex = $state(-1);
  let regexError: string | null = $state(null);

  // Subscribe to the find store.
  const unsubscribe = findStore.subscribe((s) => {
    matches = s.matches;
    currentIndex = s.currentIndex;
    regexError = s.regexError;
    caseSensitive = s.caseSensitive;
    wholeWord = s.wholeWord;
    useRegex = s.useRegex;
    replaceOpen = s.replaceOpen;
  });

  // Auto-focus the search input when the bar opens.
  $effect(() => {
    if (open && searchInput) {
      // Delay to ensure the element is rendered and visible.
      requestAnimationFrame(() => searchInput?.focus());
    }
  });

  // Clean up subscription on destroy.
  import { onDestroy } from 'svelte';
  onDestroy(() => unsubscribe());

  // ── Match count display ──────────────────────────────────────────────────

  const matchCountText = $derived(
    regexError
      ? 'Invalid regex'
      : matches.length === 0
        ? query
          ? 'No results'
          : ''
        : `${currentIndex + 1} of ${matches.length}`,
  );

  // Replace row is disabled in preview-only mode.
  const replaceDisabled = $derived(viewMode === 'preview');

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleQueryInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    query = value;
    findStore.setQuery(value);
  }

  function handleReplaceInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    replaceWith = value;
    findStore.setReplaceWith(value);
  }

  function handleClose() {
    open = false;
    findStore.close();
  }

  function handleNext() {
    findStore.nextMatch();
  }

  function handlePrev() {
    findStore.prevMatch();
  }

  function handleReplace() {
    if (replaceDisabled || matches.length === 0 || currentIndex < 0) return;
    const match = matches[currentIndex];
    // Dispatch a custom event for the parent to handle the CM6 transaction.
    barEl?.dispatchEvent(
      new CustomEvent('findreplace', {
        bubbles: true,
        detail: { type: 'replace', from: match.from, to: match.to, replacement: replaceWith },
      }),
    );
  }

  function handleReplaceAll() {
    if (replaceDisabled || matches.length === 0) return;
    barEl?.dispatchEvent(
      new CustomEvent('findreplace', {
        bubbles: true,
        detail: { type: 'replaceAll', matches: [...matches], replacement: replaceWith },
      }),
    );
  }

  function handleToggleReplace() {
    if (replaceDisabled) return;
    findStore.toggleReplaceOpen();
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrev();
      } else if (e.altKey) {
        handleReplace();
      } else {
        handleNext();
      }
      return;
    }
    // Ctrl+Alt+Enter → Replace All
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      handleReplaceAll();
    }
  }

  function handleReplaceKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        handleReplaceAll();
      } else if (e.altKey) {
        handleReplace();
      } else {
        handleReplace();
      }
    }
  }

  let barEl: HTMLDivElement | null = $state(null);
</script>

{#if open}
  <div
    class="find-bar"
    class:has-error={!!regexError}
    bind:this={barEl}
    role="search"
    aria-label="Find and replace"
  >
    <!-- Row 1: Find -->
    <div class="fb-row">
      <button
        class="fb-chevron"
        class:fb-chevron-open={replaceOpen}
        on:click={handleToggleReplace}
        aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
        aria-expanded={replaceOpen}
        disabled={replaceDisabled}
        title={replaceDisabled ? 'Replace is unavailable in preview-only mode' : ''}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>

      <div class="fb-input-wrap">
        <input
          bind:this={searchInput}
          class="fb-input"
          class:fb-input-error={!!regexError}
          type="text"
          placeholder="Find…"
          value={query}
          on:input={handleQueryInput}
          on:keydown={handleSearchKeydown}
          spellcheck="false"
          autocomplete="off"
          aria-label="Search"
        />
        <span class="fb-count" class:fb-count-error={!!regexError}>
          {matchCountText}
        </span>
      </div>

      <div class="fb-toggles">
        <button
          class="fb-toggle"
          class:fb-toggle-active={caseSensitive}
          on:click={() => findStore.toggleCaseSensitive()}
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
        >Aa</button>
        <button
          class="fb-toggle"
          class:fb-toggle-active={wholeWord}
          on:click={() => findStore.toggleWholeWord()}
          aria-label="Match whole word"
          aria-pressed={wholeWord}
          title="Match whole word"
        >W</button>
        <button
          class="fb-toggle"
          class:fb-toggle-active={useRegex}
          on:click={() => findStore.toggleRegex()}
          aria-label="Use regular expression"
          aria-pressed={useRegex}
          title="Use regular expression"
        >.*</button>
      </div>

      <div class="fb-nav">
        <button class="fb-btn" on:click={handlePrev} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matches.length === 0}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 4l-5 5h10z"/></svg>
        </button>
        <button class="fb-btn" on:click={handleNext} aria-label="Next match" title="Next match (Enter)" disabled={matches.length === 0}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12l5-5H3z"/></svg>
        </button>
      </div>

      <button class="fb-btn fb-close" on:click={handleClose} aria-label="Close find bar" title="Close (Escape)">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
      </button>
    </div>

    <!-- Row 2: Replace (collapsible) -->
    {#if replaceOpen && !replaceDisabled}
      <div class="fb-row fb-replace-row">
        <div class="fb-chevron-spacer"></div>
        <div class="fb-input-wrap">
          <input
            bind:this={replaceInput}
            class="fb-input"
            type="text"
            placeholder="Replace…"
            value={replaceWith}
            on:input={handleReplaceInput}
            on:keydown={handleReplaceKeydown}
            spellcheck="false"
            autocomplete="off"
            aria-label="Replace"
          />
        </div>
        <div class="fb-replace-actions">
          <button
            class="fb-btn fb-replace-btn"
            on:click={handleReplace}
            disabled={matches.length === 0 || currentIndex < 0}
            title="Replace (Alt+Enter)"
          >Replace</button>
          <button
            class="fb-btn fb-replace-btn"
            on:click={handleReplaceAll}
            disabled={matches.length === 0}
            title="Replace all (Ctrl+Alt+Enter)"
          >All</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .find-bar {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-pop);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 420px;
    max-width: 600px;
    animation: fb-in var(--dur-slow) var(--ease-out);
  }
  @keyframes fb-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .find-bar { animation: none; }
  }

  .fb-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Chevron toggle */
  .fb-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--r-sm);
    flex: none;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .fb-chevron svg { width: 14px; height: 14px; }
  .fb-chevron:hover { color: var(--text); background: var(--surface-2); }
  .fb-chevron-open { transform: rotate(90deg); }
  .fb-chevron:disabled { opacity: 0.4; cursor: not-allowed; }
  .fb-chevron-spacer { width: 22px; flex: none; }

  /* Input wrapper (search/replace) */
  .fb-input-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    background: var(--editor-bg);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0 6px;
    min-width: 0;
    transition: border-color var(--dur-fast);
  }
  .fb-input-wrap:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .fb-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12.5px;
    padding: 5px 0;
    outline: none;
    min-width: 0;
  }
  .fb-input::placeholder { color: var(--text-faint); }
  .fb-input-error { color: var(--detached-text); }

  /* Match count inside search input */
  .fb-count {
    flex: none;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    padding-left: 6px;
    white-space: nowrap;
    user-select: none;
  }
  .fb-count-error { color: var(--detached-text); }

  /* Toggle buttons (Aa, W, .*) */
  .fb-toggles {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .fb-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 24px;
    padding: 0 5px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .fb-toggle:hover { background: var(--surface-2); color: var(--text); }
  .fb-toggle-active {
    background: var(--accent-soft);
    color: var(--accent-text);
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  }

  /* Navigation and action buttons */
  .fb-nav {
    display: flex;
    gap: 1px;
    flex: none;
  }
  .fb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .fb-btn svg { width: 14px; height: 14px; }
  .fb-btn:hover { background: var(--surface-2); color: var(--text); }
  .fb-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .fb-close { margin-left: 2px; }

  /* Replace row */
  .fb-replace-row {
    animation: fb-slide var(--dur-base) var(--ease-out);
  }
  @keyframes fb-slide {
    from { opacity: 0; max-height: 0; }
    to   { opacity: 1; max-height: 40px; }
  }
  .fb-replace-actions {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .fb-replace-btn {
    width: auto;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    white-space: nowrap;
  }
</style>
```

- [ ] **6.2** Verify the component compiles:

```
npm run check 2>&1 | Select-String "FindBar"
```

Expected: no errors mentioning FindBar.

- [ ] **6.3** Commit:

```
git add src/lib/FindBar.svelte
git commit -m "feat(find): add FindBar floating component (Svelte 5)

Centered over ws-body, styled with design tokens. Find row with toggles
(Aa/W/.*), navigation (prev/next), match count. Collapsible replace row
with Replace and All buttons. Keyboard shortcuts: Enter, Shift+Enter,
Alt+Enter, Ctrl+Alt+Enter, Escape.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: EditorPane Integration

**Files:**
- **Modify:** `src/lib/EditorPane.svelte`

### Steps

- [ ] **7.1** Add imports at the top of the `<script>` block (after the existing imports, around line 32):

After this line:
```typescript
  import { isMac } from './util/platform';
```

Add:
```typescript
  import { findStore } from './stores/find';
  import {
    findCmField,
    findDecorationExt,
    findThemeExt,
    setFindMatchesEffect,
    setFindActiveIndexEffect,
  } from './find-highlight';
```

- [ ] **7.2** Add the find CM6 extensions to the `EditorState.create` extensions array (around line 392–398).

After this line (line 398):
```typescript
        annotationWashExt,
```

Add:
```typescript
        // Find & Replace decoration field + decoration provider + theme.
        findCmField,
        findDecorationExt,
        findThemeExt,
```

- [ ] **7.3** Add the find store subscription inside the `onMount` callback, after the annotation focus subscription block (after line 560, before the `});` that closes `onMount`).

After the closing of `unsubFocus = annotationFocus.subscribe(...)` block and before the `});` of `onMount`:

```typescript
    // Subscribe to the find store: push match ranges and active index into
    // the CM6 state, and scroll the active match into view.
    let lastFindMatches: import('./stores/find').MatchRange[] = [];
    let lastFindActive = -1;
    const unsubFind = findStore.subscribe((s) => {
      if (!view) return;
      if (s.matches !== lastFindMatches) {
        lastFindMatches = s.matches;
        view.dispatch({ effects: [setFindMatchesEffect.of(s.matches)] });
      }
      if (s.currentIndex !== lastFindActive) {
        lastFindActive = s.currentIndex;
        view.dispatch({ effects: [setFindActiveIndexEffect.of(s.currentIndex)] });
        // Scroll the active match into view.
        if (s.currentIndex >= 0 && s.currentIndex < s.matches.length) {
          const match = s.matches[s.currentIndex];
          if (match.from >= 0 && match.from <= view.state.doc.length) {
            view.dispatch({
              effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
            });
          }
        }
      }
    });
```

- [ ] **7.4** Clean up the find subscription in `onDestroy`. In the existing `onDestroy` block (around line 563–574), add `unsubFind?.();` alongside the other cleanup:

After this line:
```typescript
    unsubFocus?.();
```

Add:
```typescript
    unsubFind?.();
```

Note: `unsubFind` is defined inside `onMount`, so it needs to be declared at the component scope level (alongside `unsubAnnotations` and `unsubFocus`). Add this line near the existing `let unsubFocus` declaration (around line 385):

```typescript
  let unsubFind: (() => void) | null = null;
```

Then change the subscription assignment in the `onMount` to use:
```typescript
    unsubFind = findStore.subscribe((s) => {
```

(Replace `const unsubFind =` with `unsubFind =`.)

- [ ] **7.5** Add exported replace methods. After the `export async function save()` block (around line 621), add:

```typescript
  /**
   * Replace a single match range in the editor.
   * Dispatches a CM6 transaction that flows through the existing change pipeline.
   */
  export function replaceMatch(from: number, to: number, replacement: string): void {
    if (!view) return;
    view.dispatch({
      changes: { from, to, insert: replacement },
    });
    // The CM6 updateListener fires scheduleChange(), which updates the tab store
    // and triggers a PreviewPane re-render automatically.
  }

  /**
   * Replace all match ranges at once.
   * Applies replacements bottom-to-top to preserve character offsets.
   */
  export function replaceAllMatches(
    matches: { from: number; to: number }[],
    replacement: string,
  ): void {
    if (!view || matches.length === 0) return;
    // Sort descending by `from` so earlier offsets remain valid as we replace.
    const sorted = [...matches].sort((a, b) => b.from - a.from);
    const changes = sorted.map((m) => ({ from: m.from, to: m.to, insert: replacement }));
    view.dispatch({ changes });
  }
```

- [ ] **7.6** Verify the file compiles:

```
npm run check 2>&1 | Select-String "EditorPane"
```

Expected: no errors mentioning EditorPane.

- [ ] **7.7** Commit:

```
git add src/lib/EditorPane.svelte
git commit -m "feat(find): integrate CM6 find decorations into EditorPane

Adds findCmField/findDecorationExt/findThemeExt to the extensions array.
Subscribes to findStore for match/index updates. Exports replaceMatch()
and replaceAllMatches() for parent orchestration.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: PreviewPane Integration

**Files:**
- **Modify:** `src/lib/PreviewPane.svelte`

### Steps

- [ ] **8.1** Add imports at the top of the `<script>` block (after the existing `annotationHighlight` imports, around line 46):

After this line:
```typescript
  import { annotationsStore } from './stores/annotations';
```

Add:
```typescript
  import { findStore } from './stores/find';
  import { refreshFindHighlights, clearFindHighlights } from './find-highlight';
```

- [ ] **8.2** Add a `$effect` block to render find highlights. Place this after the existing annotation-wash-related code in the component (after `refreshAnnotationWash` function, around line 345). Add a new `$effect` block:

Find a suitable location in the component's reactive section. After the annotation-focus subscription or in the `$effect` section. Add:

```typescript
  // ── Find & Replace highlight sync ──────────────────────────────────────
  // Watch the find store and repaint CSS Custom Highlights in the preview.
  let lastFindQuery = '';
  let lastFindIndex = -1;
  let lastFindMatchCount = 0;

  const unsubFindPreview = findStore.subscribe((s) => {
    if (!previewEl) return;
    if (!s.open || s.matches.length === 0) {
      if (lastFindMatchCount > 0) {
        clearFindHighlights();
        lastFindMatchCount = 0;
      }
      lastFindQuery = s.query;
      lastFindIndex = s.currentIndex;
      return;
    }
    // Only repaint when something actually changed.
    if (
      s.query === lastFindQuery &&
      s.currentIndex === lastFindIndex &&
      s.matches.length === lastFindMatchCount
    ) {
      return;
    }
    lastFindQuery = s.query;
    lastFindIndex = s.currentIndex;
    lastFindMatchCount = s.matches.length;

    // Delay slightly to let the DOM settle after a content re-render.
    requestAnimationFrame(() => {
      if (!previewEl) return;
      refreshFindHighlights(previewEl, s.matches, s.currentIndex, s.content);

      // Scroll the active match into view in the preview.
      if (s.currentIndex >= 0 && s.currentIndex < s.matches.length && pvScrollEl) {
        // The active highlight is in the find-active CSS highlight set.
        // To scroll, find the block containing the match text.
        const matchText = s.content.slice(
          s.matches[s.currentIndex].from,
          s.matches[s.currentIndex].to,
        );
        if (matchText) {
          const stripped = matchText.replace(/[*_~`]/g, '');
          const walker = document.createTreeWalker(previewEl, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode())) {
            if ((node.textContent ?? '').includes(stripped)) {
              const parent = node.parentElement;
              if (parent) {
                parent.scrollIntoView({ block: 'center', behavior: 'smooth' });
              }
              break;
            }
          }
        }
      }
    });
  });
```

- [ ] **8.3** Clean up the find subscription in the component's `onDestroy`. Find the existing `onDestroy` block and add `unsubFindPreview()`:

Locate the `onDestroy` callback in PreviewPane.svelte and add:

```typescript
    unsubFindPreview();
```

If there's no `onDestroy`, add one. The component already imports `onDestroy` at line 25. Find where `onDestroy(() => { ... })` is called and add the cleanup there.

- [ ] **8.4** Also repaint find highlights after the HTML re-render. In the existing `$effect` that runs after `html` changes (the hydration effect around line 208), add a call to refresh find highlights at the end of the hydration callback:

After the existing post-render work (seal recompute, annotation wash), add:

```typescript
      // Refresh find highlights after re-render (matches may need remapping).
      const findState = findStore.snapshot;
      if (findState.open && findState.matches.length > 0 && previewEl) {
        refreshFindHighlights(previewEl, findState.matches, findState.currentIndex, findState.content);
      }
```

- [ ] **8.5** Verify:

```
npm run check 2>&1 | Select-String "PreviewPane"
```

Expected: no errors mentioning PreviewPane.

- [ ] **8.6** Commit:

```
git add src/lib/PreviewPane.svelte
git commit -m "feat(find): integrate find highlights into PreviewPane

Subscribes to findStore, renders CSS Custom Highlights for find-match and
find-active. Scrolls active match into view. Refreshes after HTML re-render.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 9: App.svelte Integration

**Files:**
- **Modify:** `src/App.svelte`

### Steps

- [ ] **9.1** Add imports. After the existing imports at the top (around line 30), add:

After:
```typescript
  import AnnotationPopover from './lib/AnnotationPopover.svelte';
```

Add:
```typescript
  import FindBar from './lib/FindBar.svelte';
  import { findStore } from './lib/stores/find';
```

- [ ] **9.2** Add keyboard shortcuts to `handleGlobalKeydown`. After the no-tabs guard at line 638 (`if ($tabList.length === 0) return;`), and before the `if (e.altKey)` block at line 641, add Find/Replace shortcuts:

After:
```typescript
    if ($tabList.length === 0) return;
```

Add:
```typescript
    // Ctrl+F → open Find bar; Ctrl+H → open Find & Replace.
    if (!e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        findStore.openFind();
        findStore.recompute($activeTab?.content ?? '');
        return;
      }
      if (k === 'h') {
        e.preventDefault();
        findStore.openReplace();
        findStore.recompute($activeTab?.content ?? '');
        return;
      }
    }
```

- [ ] **9.3** Add Find/Replace commands to `buildCommands()`. After the no-tabs guard in `buildCommands` (after `if (!$activeTab) return cmds;` at line 562), add:

After the line:
```typescript
    if (!$activeTab) return cmds;
```

Add:
```typescript
    // Edit — Find & Replace
    cmds.push({
      id: 'find', title: 'Find', section: 'Edit', hint: `${mod}F`,
      keywords: 'search text query',
      run: () => { findStore.openFind(); findStore.recompute($activeTab?.content ?? ''); },
    });
    cmds.push({
      id: 'find-replace', title: 'Find and Replace', section: 'Edit', hint: `${mod}H`,
      keywords: 'search replace text substitute',
      run: () => { findStore.openReplace(); findStore.recompute($activeTab?.content ?? ''); },
    });
```

- [ ] **9.4** Mount the `<FindBar>` component inside `.ws-body`. In the template, inside the `<div class="ws-body">` (line 756), add FindBar as the first child:

After `<div class="ws-body">` and before `<div class="panes ...">`, add:

```svelte
        <FindBar bind:open={findBarOpen} viewMode={viewMode} on:findreplace={handleFindReplace} />
```

Also add the `findBarOpen` state variable and `handleFindReplace` handler in the `<script>` section.

Add the state variable near the other state variables:

```typescript
  // Find bar
  let findBarOpen = $state(false);
```

Wire the findBarOpen to the store. Add a `$effect` to sync:

```typescript
  // Sync findStore.open ↔ findBarOpen.
  const unsubFindBar = findStore.subscribe((s) => {
    findBarOpen = s.open;
  });
```

Add the `handleFindReplace` handler function (near the other handler functions):

```typescript
  function handleFindReplace(e: CustomEvent<{ type: string; from?: number; to?: number; replacement: string; matches?: { from: number; to: number }[] }>) {
    const { type, from, to, replacement, matches } = e.detail;
    if (type === 'replace' && editorRef && from != null && to != null) {
      editorRef.replaceMatch(from, to, replacement);
      // After a tick, grab the new content and recompute matches.
      setTimeout(() => {
        const newContent = $activeTab?.content ?? '';
        const snap = findStore.snapshot;
        findStore.afterReplace(newContent, snap.currentIndex);
      }, 50);
    } else if (type === 'replaceAll' && editorRef && matches) {
      editorRef.replaceAllMatches(matches, replacement);
      setTimeout(() => {
        const newContent = $activeTab?.content ?? '';
        findStore.afterReplace(newContent, 0);
      }, 50);
    }
  }
```

- [ ] **9.5** Recompute find matches on tab switch. In the reactive section that handles tab changes, add find store recompute. Find where `$activeTab` is used reactively and add:

Add a `$effect` that watches `$activeTab`:

```typescript
  // Re-run find search when the active tab changes.
  $effect(() => {
    const tab = $activeTab;
    if (tab && findStore.snapshot.open) {
      findStore.recompute(tab.content);
    }
  });
```

- [ ] **9.6** Add `position: relative` to `.ws-body` CSS. In the `<style>` section, find the `.ws-body` rule (line 1065):

Change:
```css
  .ws-body { flex: 1; min-height: 0; display: flex; min-width: 0; }
```

To:
```css
  .ws-body { flex: 1; min-height: 0; display: flex; min-width: 0; position: relative; }
```

- [ ] **9.7** Clean up the find bar subscription in the component lifecycle. Add to the existing cleanup (or add an `onDestroy` if there isn't one for this):

```typescript
  onDestroy(() => {
    unsubFindBar();
  });
```

If App.svelte doesn't have an `onDestroy`, it may use `onMount` with a return cleanup. Check the existing pattern and add `unsubFindBar()` alongside other cleanup.

Note: if `onDestroy` is not already imported, add it to the `import { onMount } from 'svelte'` line.

- [ ] **9.8** Verify:

```
npm run check 2>&1 | Select-String "error|Error" | Select-Object -First 10
```

Expected: no new errors.

- [ ] **9.9** Commit:

```
git add src/App.svelte
git commit -m "feat(find): wire FindBar into App shell

Mounts FindBar in ws-body with position:relative. Adds Ctrl+F/H shortcuts
to handleGlobalKeydown. Adds find/replace commands to palette. Wires
replace events to EditorPane methods. Recomputes on tab switch.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 10: KeyboardShortcutsModal Update

**Files:**
- **Modify:** `src/lib/KeyboardShortcutsModal.svelte`

### Steps

- [ ] **10.1** Add Find and Replace entries to the `groups` array. In the 'General' group (the last group in the array, around line 53–59), add two new entries before the existing items:

Change the General group from:
```typescript
    {
      title: 'General',
      items: [
        { keys: [mod, 'K'], label: 'Command palette' },
        { keys: [mod, ','], label: 'Settings' },
        { keys: ['Esc'], label: 'Close dialog / popover' },
      ],
    },
```

To:
```typescript
    {
      title: 'General',
      items: [
        { keys: [mod, 'F'], label: 'Find' },
        { keys: [mod, 'H'], label: 'Find and replace' },
        { keys: [mod, 'K'], label: 'Command palette' },
        { keys: [mod, ','], label: 'Settings' },
        { keys: ['Esc'], label: 'Close dialog / popover' },
      ],
    },
```

- [ ] **10.2** Verify:

```
npm run check 2>&1 | Select-String "KeyboardShortcutsModal"
```

Expected: no errors.

- [ ] **10.3** Commit:

```
git add src/lib/KeyboardShortcutsModal.svelte
git commit -m "docs(find): add Find/Replace shortcuts to keyboard reference

Adds Ctrl+F (Find) and Ctrl+H (Find and replace) entries to the General
group in KeyboardShortcutsModal.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 11: Full Verification

### Steps

- [ ] **11.1** Run the full frontend verification gate:

```
npm run verify
```

Expected output: `svelte-check` passes, all Vitest tests pass, `vite build` succeeds.

- [ ] **11.2** Run Rust tests to confirm no backend regressions:

```
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: all Rust tests pass (this is a frontend-only change, so no changes expected).

- [ ] **11.3** If any failures occur, fix them and re-run until clean, then amend the relevant commit.

---

## Implementation Notes

### Debouncing
The design spec calls for ~50ms debounce on match computation. In this implementation, `findStore.setQuery()` recomputes synchronously — which is fine for documents under ~50K characters. If performance issues arise on very large documents, add a debounce wrapper around `setQuery()` using `setTimeout`. The store's `recompute()` is also called synchronously on tab switch — same caveat applies.

### Preview Highlight Limitations
The preview highlight mapping (source offset → DOM text node) is approximate. It works well for:
- Plain text matches
- Matches within a single block element
- Matches that don't span markdown syntax boundaries

It may miss or mis-highlight:
- Matches that cross block boundaries (e.g., spanning from one paragraph into the next)
- Matches inside code blocks rendered by highlight.js (the syntax-highlighted spans fragment the text nodes)
- Matches that include markdown syntax characters (`**`, `_`, etc.) — these are stripped from the rendered DOM

These are acceptable trade-offs for v1. The source pane highlighting is always correct since it operates on the raw content.

### Replace Safety
Replace operations flow through the existing CodeMirror → `scheduleChange()` → `tabsStore.updateContent()` → save pipeline. This means:
- Replace triggers the dirty flag
- Replace triggers the preview re-render
- The user must still Ctrl+S to persist
- Optimistic concurrency (hash check) is preserved
- Undo works (CodeMirror's `history()` extension is in the extensions array)

### WebView2 Native Find Interception
`Ctrl+F` is intercepted by `e.preventDefault()` in the global keydown handler **before** WebView2's native find activates. This works because the Svelte handler runs on the DOM `keydown` event, which fires before the browser's built-in accelerator. If the find bar is not open (no document open), the event falls through to the no-tabs guard and is ignored — the native find will not activate either since we `return` before the switch statement.
