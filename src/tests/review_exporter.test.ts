/**
 * review_exporter.test.ts
 *
 * Contract + snapshot tests for ReviewExporter.formatReview().
 *
 * Key assertions:
 *  - Format contract: numbered open comments with line range + quoted snippet + body.
 *  - General notes section present.
 *  - NO assistant-specific strings (TRAP 2 enforcement — "Claude", "Copilot", etc.).
 *  - Detached annotations land in their own section.
 *  - Anchored + block_level are "open" for review purposes; detached goes in its own section.
 */
import { describe, it, expect } from 'vitest';
import { formatReview } from '../lib/ReviewExporter';
import type { Sidecar, Annotation } from '../lib/types/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnnotation(
  id: string,
  status: Annotation['status'],
  body: string,
  lineStart = 10,
  lineEnd = 10,
  quotedText = 'sample text',
): Annotation {
  return {
    id,
    status,
    body,
    quoted_text: quotedText,
    line_start: lineStart,
    line_end: lineEnd,
    char_start: 0,
    char_end: quotedText.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeSidecar(
  annotations: Annotation[],
  generalNotes = ''
): Sidecar {
  return {
    schema_version: 1,
    doc_content_hash: 'abc123',
    general_notes: generalNotes,
    annotations,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('formatReview', () => {
  it('includes the filename in the heading', () => {
    const sidecar = makeSidecar([]);
    const { markdown } = formatReview(sidecar, '/path/to/spec.md');
    expect(markdown).toContain('# Review — spec.md');
  });

  it('numbers anchored comments sequentially starting at 1 (1-indexed display)', () => {
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'First issue', 4, 4),   // line_start=4 → display L5
      makeAnnotation('a2', 'anchored', 'Second issue', 19, 21), // line_start=19 → display L20–L22
    ]);
    const { markdown, anchoredCount } = formatReview(sidecar, '/docs/spec.md');
    expect(anchoredCount).toBe(2);
    expect(markdown).toContain('### Comment 1 — L5');
    expect(markdown).toContain('First issue');
    expect(markdown).toContain('### Comment 2 — L20–L22');
    expect(markdown).toContain('Second issue');
  });

  it('includes the quoted snippet for anchored annotations', () => {
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'Check this', 3, 3, 'important sentence'),
    ]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    expect(markdown).toContain('> important sentence');
  });

  it('omits detached annotations from the open section', () => {
    // "detached" should NOT appear as an open comment — it goes in Detached section.
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'Open comment'),
      makeAnnotation('a2', 'detached', 'Lost anchor'),
    ]);
    const { markdown, anchoredCount } = formatReview(sidecar, '/docs/spec.md');
    expect(anchoredCount).toBe(1);
    // The open section should only contain the anchored comment.
    expect(markdown).toContain('## Open comments (1)');
  });

  it('puts detached annotations in a separate section', () => {
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'Still relevant', 6),
      makeAnnotation('a2', 'detached', 'Lost anchor', 99),
    ]);
    const { markdown, detachedCount } = formatReview(sidecar, '/docs/spec.md');
    expect(detachedCount).toBe(1);
    expect(markdown).toContain('## Detached comments (1)');
    expect(markdown).toContain('Lost anchor');
    expect(markdown).toContain('[detached]');
  });

  it('includes block_level annotations in the open section', () => {
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'block_level', 'Wrong diagram', 5, 5, ''),
    ]);
    const { markdown, blockLevelCount } = formatReview(sidecar, '/docs/spec.md');
    expect(blockLevelCount).toBe(1);
    // block_level should appear in "Open comments"
    expect(markdown).toContain('## Open comments (1)');
    expect(markdown).toContain('Wrong diagram');
    expect(markdown).toContain('block:');
  });

  it('includes the general notes section', () => {
    const sidecar = makeSidecar([], 'Overall the spec looks solid, but section 3 needs work.');
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    expect(markdown).toContain('## General notes');
    expect(markdown).toContain('Overall the spec looks solid');
  });

  it('shows placeholder when general notes is empty', () => {
    const sidecar = makeSidecar([]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    expect(markdown).toContain('_No general notes._');
  });

  it('shows placeholder when no open comments exist', () => {
    const sidecar = makeSidecar([]);
    const { markdown, anchoredCount, blockLevelCount } = formatReview(sidecar, '/docs/spec.md');
    expect(anchoredCount).toBe(0);
    expect(blockLevelCount).toBe(0);
    expect(markdown).toContain('_No open comments._');
  });

  // -------------------------------------------------------------------------
  // TRAP 2: No assistant-specific strings (enforced by test)
  // -------------------------------------------------------------------------

  it('TRAP2: contains no assistant-specific strings', () => {
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'Some comment'),
    ], 'Some general notes');
    const { markdown } = formatReview(sidecar, '/docs/spec.md');

    const forbidden = ['Claude', 'Copilot', 'GPT', 'ChatGPT', 'Gemini', 'Llama', 'Anthropic'];
    for (const word of forbidden) {
      expect(markdown, `Review should not contain "${word}"`).not.toContain(word);
    }
  });

  it('TRAP2: review heading is agent-agnostic', () => {
    const sidecar = makeSidecar([]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    // The top-level heading should NOT reference any AI product.
    const firstLine = markdown.split('\n')[0];
    expect(firstLine).toMatch(/^# Review —/);
    expect(firstLine).not.toMatch(/Claude|Copilot|GPT/);
  });

  // -------------------------------------------------------------------------
  // Multi-line quotes are truncated to 3 lines
  // -------------------------------------------------------------------------

  it('truncates long quoted text to 3 lines', () => {
    const longText = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const sidecar = makeSidecar([
      makeAnnotation('a1', 'anchored', 'Check this', 0, 4, longText),
    ]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    // Only first 3 lines should appear as quotes.
    expect(markdown).toContain('> line 1');
    expect(markdown).toContain('> line 2');
    expect(markdown).toContain('> line 3');
    expect(markdown).not.toContain('> line 4');
    expect(markdown).not.toContain('> line 5');
  });

  // -------------------------------------------------------------------------
  // Snapshot test: lock the format so accidental changes are caught
  // -------------------------------------------------------------------------

  it('matches format snapshot for a typical review', () => {
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: 'deadbeef',
      general_notes: 'Focus on the auth section.',
      annotations: [
        // line_start=11 → displayed as L12
        makeAnnotation('a1', 'anchored', 'Clarify this requirement.', 11, 11, 'must be idempotent'),
        makeAnnotation('a2', 'detached', 'This block was moved.', 50, 52, 'old text'),
      ],
    };
    const { markdown } = formatReview(sidecar, '/project/design.md');

    // Structural snapshot assertions (not brittle line-by-line snapshot).
    expect(markdown).toContain('# Review — design.md');
    expect(markdown).toContain('## Open comments (1)');
    expect(markdown).toContain('### Comment 1 — L12');
    expect(markdown).toContain('> must be idempotent');
    expect(markdown).toContain('Clarify this requirement.');
    expect(markdown).toContain('## Detached comments (1)');
    expect(markdown).toContain('## General notes');
    expect(markdown).toContain('Focus on the auth section.');
    // The detached annotation body should appear in the detached section
    expect(markdown).toContain('This block was moved.');
  });
});
