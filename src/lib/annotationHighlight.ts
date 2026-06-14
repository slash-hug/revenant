/**
 * annotationHighlight.ts — CSS Custom Highlight API wrapper for annotation wash.
 *
 * The wash is painted with CSS.highlights (CSS Custom Highlight API), which operates
 * on DOM Ranges without mutating the DOM. This is DOMPurify-safe by construction:
 * no class is added to sanitized content, and highlights survive re-render.
 *
 * Decisions implemented:
 *  - D-RISK-1: Feature-detect CSS.highlights; no-op silently on macOS 13 / old WebKit.
 *  - buildRange: TreeWalker across descendant text nodes to span element boundaries
 *                (handles foo **bar** — quoted_text crossing inline elements, TRAP 6).
 *  - refreshHighlights: register annotation-wash / annotation-wash-active highlight sets.
 */

/** True when the CSS Custom Highlight API is available in the current environment. */
export function isHighlightSupported(): boolean {
  return typeof CSS !== 'undefined' && !!(CSS as unknown as { highlights?: unknown }).highlights;
}

/**
 * Find the first occurrence of quotedText within blockEl, spanning element
 * boundaries (handles inline <strong>, <em>, <code>, etc.).
 *
 * Algorithm:
 *  1. Collect all descendant text nodes in document order via TreeWalker.
 *  2. Concatenate their text content into a virtual string, tracking each node's
 *     start offset within that string.
 *  3. Find the first occurrence of quotedText in the virtual string.
 *  4. Map the start/end back to the appropriate text nodes + character offsets.
 *  5. Create and return a DOM Range spanning the matched region.
 *
 * Returns null if quotedText is not found or is empty.
 */
export function buildRange(blockEl: Element, quotedText: string): Range | null {
  if (!quotedText) return null;

  // Collect all descendant text nodes in order.
  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  if (textNodes.length === 0) return null;

  // Build a virtual string and track each text node's offset within it.
  let virtualText = '';
  const offsets: { node: Text; start: number }[] = [];
  for (const tn of textNodes) {
    offsets.push({ node: tn, start: virtualText.length });
    virtualText += tn.textContent ?? '';
  }

  // Find the first occurrence of quotedText (case-sensitive, exact).
  const matchStart = virtualText.indexOf(quotedText);
  if (matchStart === -1) return null;

  const matchEnd = matchStart + quotedText.length;

  // Map virtual string offsets back to text nodes.
  function resolvePoint(virtualOffset: number): { node: Text; offset: number } | null {
    // Find the last text node that starts at or before this virtual offset.
    let best: { node: Text; start: number } | null = null;
    for (const entry of offsets) {
      if (entry.start <= virtualOffset) {
        best = entry;
      } else {
        break;
      }
    }
    if (!best) return null;
    return { node: best.node, offset: virtualOffset - best.start };
  }

  const startPoint = resolvePoint(matchStart);
  const endPoint = resolvePoint(matchEnd);
  if (!startPoint || !endPoint) return null;

  try {
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    return range;
  } catch {
    // Range construction failed (e.g. offset out of bounds on a collapsed node).
    return null;
  }
}

/**
 * Register or update the CSS Custom Highlight sets for annotation wash.
 *
 * - "annotation-wash"        — one entry per non-active annotation range.
 * - "annotation-wash-active" — the single active annotation range (painted on top).
 *
 * No-op when isHighlightSupported() is false (D-RISK-1 silent-skip).
 */
export function refreshHighlights(
  ranges: Range[],
  activeRange: Range | null,
): void {
  if (!isHighlightSupported()) return;

  const highlights = (CSS as unknown as { highlights: CSSHighlightMap }).highlights;

  // Build the background wash set (all non-active ranges).
  const washRanges = activeRange
    ? ranges.filter((r) => r !== activeRange)
    : ranges;

  if (washRanges.length > 0) {
    highlights.set('annotation-wash', new Highlight(...washRanges));
  } else {
    highlights.delete('annotation-wash');
  }

  // Build the active wash set.
  if (activeRange) {
    highlights.set('annotation-wash-active', new Highlight(activeRange));
  } else {
    highlights.delete('annotation-wash-active');
  }
}

/**
 * Clear all annotation highlight sets from CSS.highlights.
 * Call this when the preview pane unmounts or all annotations are cleared.
 */
export function clearHighlights(): void {
  if (!isHighlightSupported()) return;
  const highlights = (CSS as unknown as { highlights: CSSHighlightMap }).highlights;
  highlights.delete('annotation-wash');
  highlights.delete('annotation-wash-active');
}

// ─── TypeScript shim ───────────────────────────────────────────────────────
// CSS Custom Highlight API types are not yet in all TS lib builds.
// Declare minimal shapes so we avoid `any` casts in calling code.

interface CSSHighlightMap {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
  has(name: string): boolean;
}

declare class Highlight {
  constructor(...ranges: Range[]);
}
