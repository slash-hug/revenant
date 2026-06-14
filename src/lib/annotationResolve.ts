/**
 * annotationResolve.ts — Shared block-resolution logic for annotation seals.
 *
 * This module is the single source of truth for resolving an annotation's
 * DOM block element.  Both AnnotationSeals.svelte and PreviewPane.svelte
 * import from here so they cannot drift.
 *
 * Rules (D7 / D8):
 *  - anchored  : exact data-source-line match (line_start + 1), then
 *                nearest-block fallback.
 *  - block_level: text-search of quoted_text across [data-block-id] elements.
 *  - detached  : always null (filtered upstream; the guard is kept here too).
 */

import type { Annotation } from './types/ipc';

/**
 * Resolve the DOM block element for an annotation inside `previewEl`.
 *
 * @param ann       - The annotation to resolve.
 * @param previewEl - The `.preview-content` element to query inside.
 * @returns The matching block element, or null if unresolvable.
 */
export function resolveBlock(
  ann: Pick<Annotation, 'status' | 'line_start' | 'quoted_text'>,
  previewEl: HTMLElement,
): Element | null {
  if (ann.status === 'anchored') {
    // D8: data-source-line is 1-based; line_start is 0-based.
    const targetLine = ann.line_start + 1;
    const blocks = Array.from(
      previewEl.querySelectorAll<HTMLElement>('[data-source-line]'),
    );

    // Exact match first.
    const exact = blocks.find(
      (el) => parseInt(el.dataset.sourceLine ?? '0', 10) === targetLine,
    );
    if (exact) return exact;

    // Nearest-block fallback (same logic as syncScrollToLine in PreviewPane).
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const el of blocks) {
      const dist = Math.abs(parseInt(el.dataset.sourceLine ?? '0', 10) - targetLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }
    return best;
  }

  if (ann.status === 'block_level') {
    // D7: resolve by text-search of quoted_text across rendered blocks.
    if (!ann.quoted_text) return null;
    const blocks = Array.from(
      previewEl.querySelectorAll<HTMLElement>('[data-block-id]'),
    );
    for (const el of blocks) {
      if ((el.textContent ?? '').includes(ann.quoted_text)) {
        return el;
      }
    }
    return null;
  }

  // detached → no seal
  return null;
}
