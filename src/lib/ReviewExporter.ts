/**
 * ReviewExporter.ts — formats annotations → agent-agnostic review markdown.
 *
 * Decisions implemented here:
 *  - TRAP 2 (agent-agnostic export): no hardcoded "Claude", "Copilot", or
 *    any other assistant name anywhere in this module. Button label is
 *    "Generate review"; output is plain markdown any agent can read.
 *  - C4 export format: numbered open comments with line range + quoted
 *    snippet + body, then General Notes section.
 *
 * The formatted string is passed to the Rust core's generate_review command,
 * which writes it to <doc>.review.md beside the source file.
 */

import type { Annotation, Sidecar, ReviewResult } from './types/ipc';
import { generateReview as ipcGenerateReview } from './types/ipc';
import { basename } from './util/path';

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Build the line-range label for an annotation.
 * Source anchors get "L<start>–L<end>" (1-indexed for human display).
 * Block-level anchors get "block:<line>".
 */
function formatAnchorLabel(ann: Annotation): string {
  if (ann.status === 'block_level') {
    // Block-level anchor: show the line as a reference point.
    return `block:L${ann.line_start + 1}`;
  }
  // 0-indexed internally; display as 1-indexed.
  const start = ann.line_start + 1;
  const end = ann.line_end + 1;
  if (start === end) {
    return `L${start}`;
  }
  return `L${start}–L${end}`;
}

/**
 * Format a quoted snippet for the review. Limits to first 3 lines to keep
 * the review file concise.
 */
function formatQuote(text: string): string {
  if (!text.trim()) return '';
  const lines = text.split('\n').slice(0, 3);
  return lines.map((l) => `> ${l}`).join('\n');
}

/**
 * Format a single annotation as a numbered comment block.
 *
 * Output shape:
 * ### Comment N — L42–L45
 * > quoted snippet line 1
 * > quoted snippet line 2
 *
 * Body text here.
 *
 * @param ann         The annotation to format.
 * @param index       The 1-based comment number.
 * @param labelOverride  When supplied, replaces the default anchor label
 *                       (e.g. "[detached] L99" for detached comments).
 */
function formatAnnotation(ann: Annotation, index: number, labelOverride?: string): string {
  const anchorLabel = labelOverride ?? formatAnchorLabel(ann);
  const quote = formatQuote(ann.quoted_text);
  const lines: string[] = [`### Comment ${index} — ${anchorLabel}`];
  if (quote) {
    lines.push('');
    lines.push(quote);
  }
  lines.push('');
  lines.push(ann.body.trim());

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReviewPayload {
  /** The formatted review markdown string. */
  markdown: string;
  /** Count of anchored (active) annotations included. */
  anchoredCount: number;
  /** Count of detached annotations included. */
  detachedCount: number;
  /** Count of block_level annotations included. */
  blockLevelCount: number;
}

/**
 * Format a Sidecar's annotations + general notes into review markdown.
 *
 * Anchored and block_level annotations are included as "Open comments".
 * Detached annotations are listed separately with a warning note.
 *
 * Output structure:
 *   # Review — <filename>
 *
 *   ## Open comments (N)
 *   ### Comment 1 — L5
 *   ...
 *
 *   ## Detached comments (N)
 *   ### Comment X — [detached]
 *   ...
 *
 *   ## General notes
 *   <general_notes text>
 */
export function formatReview(sidecar: Sidecar, docPath: string): ReviewPayload {
  const filename = basename(docPath);

  // "Open" = anchored + block_level (active anchors that the reviewer cares about).
  const openAnnotations = sidecar.annotations.filter(
    (a) => a.status === 'anchored' || a.status === 'block_level'
  );
  const detachedAnnotations = sidecar.annotations.filter((a) => a.status === 'detached');

  const sections: string[] = [`# Review — ${filename}`, ''];

  // Open comments
  if (openAnnotations.length > 0) {
    sections.push(`## Open comments (${openAnnotations.length})`, '');
    openAnnotations.forEach((ann, i) => {
      sections.push(formatAnnotation(ann, i + 1), '');
    });
  } else {
    sections.push('## Open comments', '', '_No open comments._', '');
  }

  // Detached comments (anchors that could not be re-anchored after edits)
  if (detachedAnnotations.length > 0) {
    sections.push(`## Detached comments (${detachedAnnotations.length})`, '');
    sections.push(
      '_These comments lost their anchor after document edits. Review manually._',
      ''
    );
    detachedAnnotations.forEach((ann, i) => {
      const label = `[detached] ${formatAnchorLabel(ann)}`;
      sections.push(formatAnnotation(ann, openAnnotations.length + i + 1, label), '');
    });
  }

  // General notes
  sections.push('## General notes', '');
  if (sidecar.general_notes?.trim()) {
    sections.push(sidecar.general_notes.trim(), '');
  } else {
    sections.push('_No general notes._', '');
  }

  return {
    markdown: sections.join('\n'),
    anchoredCount: openAnnotations.filter((a) => a.status === 'anchored').length,
    detachedCount: detachedAnnotations.length,
    blockLevelCount: openAnnotations.filter((a) => a.status === 'block_level').length,
  };
}

/**
 * Format the sidecar and invoke the Rust generate_review command,
 * which writes <doc>.review.md next to the source file.
 *
 * Returns the payload for callers that want to show a confirmation.
 */
export async function generateReview(sidecar: Sidecar, docPath: string): Promise<ReviewResult> {
  const payload = formatReview(sidecar, docPath);
  // Use the typed IPC wrapper which sends { payload: { doc_path, markdown } }.
  return ipcGenerateReview({ doc_path: docPath, markdown: payload.markdown });
}
