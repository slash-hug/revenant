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

import type { Annotation, Sidecar } from './types/ipc';
import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Build the line-range label for an annotation anchor.
 * Source anchors get "L<start>–L<end>"; block anchors get "block:<id>".
 */
function formatAnchorLabel(ann: Annotation): string {
  if (ann.anchor.type === 'source') {
    const { start_line, end_line } = ann.anchor.anchor;
    if (start_line === end_line) {
      return `L${start_line}`;
    }
    return `L${start_line}–L${end_line}`;
  }
  // Block-level anchor (Mermaid / table / footnote fallback per C8 ruling)
  const { block_id, block_type } = ann.anchor.anchor;
  return `block:${block_type}:${block_id}`;
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
 * Format a single open (non-resolved) annotation as a numbered comment block.
 *
 * Output shape:
 * ### Comment N — L42–L45
 * > quoted snippet line 1
 * > quoted snippet line 2
 *
 * Body text here.
 */
function formatAnnotation(ann: Annotation, index: number): string {
  const anchorLabel = formatAnchorLabel(ann);
  const quotedText =
    ann.anchor.type === 'source'
      ? ann.anchor.anchor.quoted_text
      : ann.anchor.anchor.quoted_text;

  const quote = formatQuote(quotedText);
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
  /** Count of open (non-resolved) annotations included. */
  openCount: number;
  /** Count of detached annotations included. */
  detachedCount: number;
}

/**
 * Format a Sidecar's annotations + general notes into review markdown.
 *
 * Only open and detached annotations are included. Resolved annotations
 * are omitted (they have been addressed).
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
  const filename = docPath.split('/').pop() ?? docPath;
  const openAnnotations = sidecar.annotations.filter((a) => a.status === 'open');
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
      const quote = formatQuote(
        ann.anchor.type === 'source'
          ? ann.anchor.anchor.quoted_text
          : ann.anchor.anchor.quoted_text
      );
      const lines = [`### Comment ${openAnnotations.length + i + 1} — ${label}`];
      if (quote) {
        lines.push('', quote);
      }
      lines.push('', ann.body.trim());
      sections.push(lines.join('\n'), '');
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
    openCount: openAnnotations.length,
    detachedCount: detachedAnnotations.length,
  };
}

/**
 * Format the sidecar and invoke the Rust generate_review command,
 * which writes <doc>.review.md next to the source file.
 *
 * Returns the payload for callers that want to show a confirmation.
 */
export async function generateReview(sidecar: Sidecar, docPath: string): Promise<ReviewPayload> {
  const payload = formatReview(sidecar, docPath);
  await invoke('generate_review', {
    doc_path: docPath,
    review_markdown: payload.markdown,
  });
  return payload;
}
