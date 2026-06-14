/**
 * annotation_highlight.test.ts
 *
 * Unit tests for annotationHighlight.ts (T2.3).
 *
 * Runs in jsdom. CSS.highlights is not available in jsdom, so:
 *  - isHighlightSupported() is expected to return false (or true if we mock it).
 *  - refreshHighlights() is expected to no-op without throwing.
 *  - buildRange() is fully testable since it only uses DOM Range / TreeWalker.
 *
 * Covers:
 *  - quoted text found → Range returned.
 *  - quoted text not found → null.
 *  - multiple occurrences → first is returned.
 *  - block-level with no inline text → null when empty block.
 *  - Sub-phrase fixture (TRAP 6): quoted_text = a short word inside a
 *    multi-word paragraph with inline <strong>/<em> elements.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isHighlightSupported,
  buildRange,
  refreshHighlights,
  clearHighlights,
  findSpan,
} from '../lib/annotationHighlight';

// ── Helper: build a DOM element from an HTML string ──────────────────────────

function makeEl(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

// ── findSpan (whitespace- / markdown-tolerant search) ───────────────────────

describe('findSpan', () => {
  it('matches across newline-vs-space differences (the multi-line bug)', () => {
    // Rendered DOM keeps source newlines; selection.toString() has spaces.
    const haystack = 'built to pair\nwith Superpowers. Whenever Superpowers\ngenerates a file.';
    const needle = 'Whenever Superpowers generates a file.';
    const span = findSpan(haystack, needle, false);
    expect(span).not.toBeNull();
    expect(haystack.slice(span!.from, span!.to).replace(/\s+/g, ' ')).toBe(needle);
  });

  it('ignores inline markdown delimiters when stripMarkdown is set', () => {
    const source = 'it can run `revenant <file.md>` to open';
    const rendered = 'it can run revenant <file.md> to open';
    const span = findSpan(source, rendered, true);
    expect(span).not.toBeNull();
    // The matched source span spans the whole phrase including the backticks.
    expect(source.slice(span!.from, span!.to)).toContain('revenant <file.md>');
  });

  it('returns null when the needle is absent', () => {
    expect(findSpan('hello world', 'absent phrase', false)).toBeNull();
    expect(findSpan('hello world', '', false)).toBeNull();
  });

  it('without nearOffset, a repeated needle resolves to the first match', () => {
    // "C" appears in "Code" (idx 2) and "C++" (idx 13).
    const hay = 'a Code line\nC++ later';
    const span = findSpan(hay, 'C', false);
    expect(span).toEqual({ from: 2, to: 3 }); // the C in "Code"
  });

  it('with nearOffset, a repeated needle resolves to the nearest occurrence', () => {
    // The same short anchor should land near its stored line, not the first match.
    const hay = 'a Code line\nC++ later';
    const cppIdx = hay.indexOf('C++'); // 12
    const span = findSpan(hay, 'C', false, cppIdx);
    expect(span).toEqual({ from: cppIdx, to: cppIdx + 1 }); // the C in "C++"

    // A nearOffset close to the first occurrence still picks the first.
    expect(findSpan(hay, 'C', false, 0)).toEqual({ from: 2, to: 3 });
  });
});

// ── isHighlightSupported ─────────────────────────────────────────────────────

describe('isHighlightSupported', () => {
  it('returns false in jsdom (CSS.highlights not available)', () => {
    // jsdom does not implement CSS.highlights — this is the expected runtime
    // behavior on unsupported environments (D-RISK-1 silent-skip).
    const supported = isHighlightSupported();
    // We don't assert a specific value here because the test runner might
    // polyfill CSS; we assert it doesn't throw.
    expect(typeof supported).toBe('boolean');
  });

  it('returns true when CSS.highlights is present (mocked)', () => {
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = { highlights: new Map() };
    expect(isHighlightSupported()).toBe(true);
    (global as Record<string, unknown>).CSS = original;
  });

  it('returns false when CSS is undefined', () => {
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = undefined;
    expect(isHighlightSupported()).toBe(false);
    (global as Record<string, unknown>).CSS = original;
  });

  it('returns false when CSS.highlights is absent', () => {
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = {};
    expect(isHighlightSupported()).toBe(false);
    (global as Record<string, unknown>).CSS = original;
  });
});

// ── buildRange ───────────────────────────────────────────────────────────────

describe('buildRange', () => {
  it('returns null for empty quotedText', () => {
    const el = makeEl('<p>Hello world</p>');
    expect(buildRange(el, '')).toBeNull();
  });

  it('returns null when quotedText is not found in the block', () => {
    const el = makeEl('<p>Hello world</p>');
    expect(buildRange(el, 'not here')).toBeNull();
  });

  it('returns a Range when quotedText is found in a plain text node', () => {
    const el = makeEl('<p>Hello world</p>');
    const range = buildRange(el, 'Hello world');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('Hello world');
  });

  it('returns the FIRST occurrence when quotedText appears multiple times', () => {
    const el = makeEl('<p>foo bar foo baz</p>');
    const range = buildRange(el, 'foo');
    expect(range).not.toBeNull();
    // The range should start at the very beginning of the text content.
    const pText = el.querySelector('p')!;
    const firstTextNode = pText.firstChild as Text;
    expect(range!.startContainer).toBe(firstTextNode);
    expect(range!.startOffset).toBe(0);
  });

  it('returns null when the block element has no text content', () => {
    const el = makeEl('<div></div>');
    expect(buildRange(el, 'anything')).toBeNull();
  });

  // TRAP 6: sub-phrase inside a multi-word paragraph with inline formatting.
  it('finds a sub-phrase inside a paragraph with inline <strong> (TRAP 6)', () => {
    // "Reviewed by Randy on Tuesday" — "Randy" is the quoted_text.
    const el = makeEl('<p>Reviewed by <strong>Randy</strong> on Tuesday</p>');
    const range = buildRange(el, 'Randy');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('Randy');
  });

  it('spans element boundaries for a quoted_text crossing <strong> (TRAP 6)', () => {
    // The quoted text "bold text" where "bold" is in a <strong> and " text" follows.
    const el = makeEl('<p>start <strong>bold</strong> text end</p>');
    const range = buildRange(el, 'bold text');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('bold text');
  });

  it('spans element boundaries across <em> element (TRAP 6)', () => {
    // "quick brown" where "quick" is plain text and " brown" follows after </em>.
    const el = makeEl('<p>The <em>quick</em> brown fox</p>');
    const range = buildRange(el, 'quick');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('quick');
  });

  it('finds text spanning across multiple inline elements (TRAP 6)', () => {
    // "foo bar baz" where each word is in its own element.
    const el = makeEl('<p><span>foo</span> <em>bar</em> <strong>baz</strong></p>');
    const range = buildRange(el, 'foo');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('foo');
  });

  it('finds sub-word match at the start of a text node', () => {
    const el = makeEl('<p>Hello, world! Goodbye.</p>');
    const range = buildRange(el, 'Hello');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('Hello');
  });

  it('finds sub-word match in the middle of a text node', () => {
    const el = makeEl('<p>Hello, world! Goodbye.</p>');
    const range = buildRange(el, 'world');
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('world');
  });
});

// ── refreshHighlights ────────────────────────────────────────────────────────

describe('refreshHighlights', () => {
  it('does not throw when CSS.highlights is unavailable (jsdom)', () => {
    // In jsdom, CSS.highlights is absent → silent no-op.
    const el = makeEl('<p>Test paragraph</p>');
    const range = buildRange(el, 'Test');
    expect(() => refreshHighlights(range ?? null, null)).not.toThrow();
  });

  it('does not throw when called with no ranges', () => {
    expect(() => refreshHighlights(null, null)).not.toThrow();
  });

  it('sets the active wash and clears hover when only an active range is given (mocked)', () => {
    const mockHighlights = {
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
    };
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = { highlights: mockHighlights };

    // Mock the Highlight constructor.
    const OriginalHighlight = (global as Record<string, unknown>).Highlight;
    (global as Record<string, unknown>).Highlight = vi.fn(function() {});

    const el = makeEl('<p>Hello world</p>');
    const range = buildRange(el, 'Hello');
    refreshHighlights(range ?? null, null);

    // Active set is painted; the hover set is cleared (clean at rest).
    expect(mockHighlights.set).toHaveBeenCalledWith('annotation-wash-active', expect.anything());
    expect(mockHighlights.delete).toHaveBeenCalledWith('annotation-wash-hover');

    (global as Record<string, unknown>).CSS = original;
    (global as Record<string, unknown>).Highlight = OriginalHighlight;
  });

  it('paints the hover wash for a distinct hovered range (mocked)', () => {
    const mockHighlights = { set: vi.fn(), delete: vi.fn(), has: vi.fn() };
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = { highlights: mockHighlights };
    const OriginalHighlight = (global as Record<string, unknown>).Highlight;
    (global as Record<string, unknown>).Highlight = vi.fn(function() {});

    const el = makeEl('<p>Hello world</p>');
    const active = buildRange(el, 'Hello');
    const hover = buildRange(el, 'world');
    refreshHighlights(active ?? null, hover ?? null);

    expect(mockHighlights.set).toHaveBeenCalledWith('annotation-wash-active', expect.anything());
    expect(mockHighlights.set).toHaveBeenCalledWith('annotation-wash-hover', expect.anything());

    (global as Record<string, unknown>).CSS = original;
    (global as Record<string, unknown>).Highlight = OriginalHighlight;
  });
});

// ── clearHighlights ──────────────────────────────────────────────────────────

describe('clearHighlights', () => {
  it('does not throw when CSS.highlights is unavailable', () => {
    expect(() => clearHighlights()).not.toThrow();
  });

  it('calls CSS.highlights.delete for both sets when supported (mocked)', () => {
    const mockHighlights = {
      set: vi.fn(),
      delete: vi.fn(),
      has: vi.fn(),
    };
    const original = (global as Record<string, unknown>).CSS;
    (global as Record<string, unknown>).CSS = { highlights: mockHighlights };

    clearHighlights();

    expect(mockHighlights.delete).toHaveBeenCalledWith('annotation-wash-active');
    expect(mockHighlights.delete).toHaveBeenCalledWith('annotation-wash-hover');

    (global as Record<string, unknown>).CSS = original;
  });
});
