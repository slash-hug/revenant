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
