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
 *  - Resolved annotations are NOT included.
 */
import { describe, it, expect } from 'vitest';
import { formatReview } from '../lib/ReviewExporter';
import type { Sidecar, Annotation } from '../lib/types/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSourceAnnotation(
  id: string,
  status: Annotation['status'],
  body: string,
  startLine = 10,
  endLine = 10,
  quotedText = 'sample text'
): Annotation {
  return {
    id,
    status,
    body,
    created_at: '2026-01-01T00:00:00Z',
    anchor: {
      type: 'source',
      anchor: {
        start_line: startLine,
        end_line: endLine,
        start_char: 0,
        end_char: quotedText.length,
        quoted_text: quotedText,
        context_before: '',
        context_after: '',
      },
    },
  };
}

function makeBlockAnnotation(
  id: string,
  status: Annotation['status'],
  body: string,
  blockId = 'blk-1',
  blockType: 'mermaid' | 'table' | 'footnote' | 'generic' = 'mermaid'
): Annotation {
  return {
    id,
    status,
    body,
    created_at: '2026-01-01T00:00:00Z',
    anchor: {
      type: 'block',
      anchor: {
        block_id: blockId,
        block_type: blockType,
        quoted_text: '',
      },
    },
  };
}

function makeSidecar(
  annotations: Annotation[],
  generalNotes = ''
): Sidecar {
  return {
    schema_version: 1,
    doc_path: '/docs/spec.md',
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

  it('numbers open comments sequentially starting at 1', () => {
    const sidecar = makeSidecar([
      makeSourceAnnotation('a1', 'open', 'First issue', 5, 5),
      makeSourceAnnotation('a2', 'open', 'Second issue', 20, 22),
    ]);
    const { markdown, openCount } = formatReview(sidecar, '/docs/spec.md');
    expect(openCount).toBe(2);
    expect(markdown).toContain('### Comment 1 — L5');
    expect(markdown).toContain('First issue');
    expect(markdown).toContain('### Comment 2 — L20–L22');
    expect(markdown).toContain('Second issue');
  });

  it('includes the quoted snippet for source anchors', () => {
    const sidecar = makeSidecar([
      makeSourceAnnotation('a1', 'open', 'Check this', 3, 3, 'important sentence'),
    ]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    expect(markdown).toContain('> important sentence');
  });

  it('omits resolved annotations', () => {
    const sidecar = makeSidecar([
      makeSourceAnnotation('a1', 'open', 'Open comment'),
      makeSourceAnnotation('a2', 'resolved', 'Already done'),
    ]);
    const { markdown, openCount } = formatReview(sidecar, '/docs/spec.md');
    expect(openCount).toBe(1);
    expect(markdown).not.toContain('Already done');
  });

  it('puts detached annotations in a separate section', () => {
    const sidecar = makeSidecar([
      makeSourceAnnotation('a1', 'open', 'Still relevant', 7),
      makeSourceAnnotation('a2', 'detached', 'Lost anchor', 99),
    ]);
    const { markdown, detachedCount } = formatReview(sidecar, '/docs/spec.md');
    expect(detachedCount).toBe(1);
    expect(markdown).toContain('## Detached comments (1)');
    expect(markdown).toContain('Lost anchor');
    expect(markdown).toContain('[detached]');
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
    const { markdown, openCount } = formatReview(sidecar, '/docs/spec.md');
    expect(openCount).toBe(0);
    expect(markdown).toContain('_No open comments._');
  });

  it('handles block-level anchors (Mermaid degradation path)', () => {
    const sidecar = makeSidecar([
      makeBlockAnnotation('a1', 'open', 'Wrong diagram', 'blk-3', 'mermaid'),
    ]);
    const { markdown } = formatReview(sidecar, '/docs/spec.md');
    // Block anchors are labeled as block:<type>:<id>
    expect(markdown).toContain('block:mermaid:blk-3');
    expect(markdown).toContain('Wrong diagram');
  });

  // -------------------------------------------------------------------------
  // TRAP 2: No assistant-specific strings (enforced by test)
  // -------------------------------------------------------------------------

  it('TRAP2: contains no assistant-specific strings', () => {
    const sidecar = makeSidecar([
      makeSourceAnnotation('a1', 'open', 'Some comment'),
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
      makeSourceAnnotation('a1', 'open', 'Check this', 1, 5, longText),
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
      doc_path: '/project/design.md',
      doc_content_hash: 'deadbeef',
      general_notes: 'Focus on the auth section.',
      annotations: [
        makeSourceAnnotation('a1', 'open', 'Clarify this requirement.', 12, 12, 'must be idempotent'),
        makeSourceAnnotation('a2', 'resolved', 'This was fixed.', 30, 30, 'TODO'),
        makeSourceAnnotation('a3', 'detached', 'This block was moved.', 50, 52, 'old text'),
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
    // Resolved not present
    expect(markdown).not.toContain('This was fixed.');
  });
});
