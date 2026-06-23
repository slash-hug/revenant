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
