/**
 * annotation_seals.test.ts
 *
 * Unit tests for seal block-resolution logic (T2.5).
 *
 * We test the resolution logic directly (not the Svelte component) by extracting
 * the matching algorithms and running them against DOM fixtures in jsdom.
 *
 * Covers:
 *  - Nearest-block resolution from source line (D8 off-by-one: data-source-line === line_start + 1).
 *  - Detached annotation → no seal (only anchored + block_level are mapped).
 *  - block_level annotation resolved by text-search of quoted_text.
 *  - Multiple annotations on the same block → stacked (indexed 0, 1, 2...).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Annotation } from '../lib/types/ipc';
import { resolveBlock } from '../lib/annotationResolve';

// ── DOM fixture helpers ──────────────────────────────────────────────────────

/**
 * Create a minimal preview DOM matching the structure PreviewPane renders.
 * Each paragraph has data-source-line (1-based) and data-block-id attributes.
 */
function makePreviewDom(paragraphs: Array<{ line: number; id: string; text: string }>) {
  const div = document.createElement('div');
  div.className = 'preview-content';
  for (const p of paragraphs) {
    const el = document.createElement('p');
    el.dataset.sourceLine = String(p.line);
    el.dataset.blockId = p.id;
    el.textContent = p.text;
    div.appendChild(el);
  }
  return div;
}

/**
 * Filter annotations to those that get seals (same as drawer activeAnnotations).
 */
function filterSealAnnotations(annotations: Annotation[]): Annotation[] {
  return annotations.filter(
    (a) => a.status === 'anchored' || a.status === 'block_level',
  );
}

// ── Helper: create a minimal annotation ──────────────────────────────────────

function makeAnnotation(
  overrides: Partial<Annotation> & { id: string },
): Annotation {
  return {
    id: overrides.id,
    body: overrides.body ?? 'Test comment',
    quoted_text: overrides.quoted_text ?? '',
    line_start: overrides.line_start ?? 0,
    line_end: overrides.line_end ?? 0,
    char_start: overrides.char_start ?? 0,
    char_end: overrides.char_end ?? 0,
    status: overrides.status ?? 'anchored',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('seal block resolution — anchored annotations (D8 off-by-one)', () => {
  let previewEl: HTMLElement;

  beforeEach(() => {
    // data-source-line is 1-based in the DOM (markdown.ts emits token.map[0]+1).
    previewEl = makePreviewDom([
      { line: 1, id: 'b1', text: 'First paragraph' },
      { line: 3, id: 'b2', text: 'Second paragraph' },
      { line: 5, id: 'b3', text: 'Third paragraph' },
    ]);
  });

  it('resolves anchored annotation with line_start=0 to data-source-line=1 (D8)', () => {
    const ann = makeAnnotation({ id: 'a1', line_start: 0, status: 'anchored' });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('b1');
  });

  it('resolves anchored annotation with line_start=2 to data-source-line=3 (D8)', () => {
    const ann = makeAnnotation({ id: 'a2', line_start: 2, status: 'anchored' });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('b2');
  });

  it('resolves anchored annotation with line_start=4 to data-source-line=5 (D8)', () => {
    const ann = makeAnnotation({ id: 'a3', line_start: 4, status: 'anchored' });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('b3');
  });

  it('nearest-block fallback: line_start=1 (no exact match at line 2) resolves to nearest', () => {
    // DOM has lines 1, 3, 5. line_start=1 → look for data-source-line=2.
    // Nearest: line 1 (dist=1) or line 3 (dist=1) — both equal, first wins.
    const ann = makeAnnotation({ id: 'a4', line_start: 1, status: 'anchored' });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    // Either b1 or b2 is valid (nearest). Just verify one was returned.
    const id = (block as HTMLElement).dataset.blockId;
    expect(['b1', 'b2']).toContain(id);
  });

  it('nearest-block fallback: line_start=3 (no exact match at line 4) resolves to b2 or b3', () => {
    // DOM has lines 1, 3, 5. line_start=3 → look for data-source-line=4.
    // Nearest: line 3 (dist=1) and line 5 (dist=1).
    const ann = makeAnnotation({ id: 'a5', line_start: 3, status: 'anchored' });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    const id = (block as HTMLElement).dataset.blockId;
    expect(['b2', 'b3']).toContain(id);
  });
});

describe('seal block resolution — detached annotations', () => {
  let previewEl: HTMLElement;

  beforeEach(() => {
    previewEl = makePreviewDom([
      { line: 1, id: 'b1', text: 'First paragraph' },
    ]);
  });

  it('detached annotation is excluded by filterSealAnnotations', () => {
    const ann = makeAnnotation({ id: 'a1', status: 'detached' });
    const filtered = filterSealAnnotations([ann]);
    expect(filtered).toHaveLength(0);
  });

  it('resolveBlock returns null for detached status (guard layer)', () => {
    const ann = makeAnnotation({ id: 'a1', status: 'detached' });
    const block = resolveBlock(ann, previewEl);
    expect(block).toBeNull();
  });

  it('anchored annotations pass the filter', () => {
    const ann = makeAnnotation({ id: 'a1', status: 'anchored' });
    const filtered = filterSealAnnotations([ann]);
    expect(filtered).toHaveLength(1);
  });

  it('block_level annotations pass the filter', () => {
    const ann = makeAnnotation({ id: 'a1', status: 'block_level' });
    const filtered = filterSealAnnotations([ann]);
    expect(filtered).toHaveLength(1);
  });

  it('mixed list: only anchored and block_level pass', () => {
    const annotations = [
      makeAnnotation({ id: 'a1', status: 'anchored' }),
      makeAnnotation({ id: 'a2', status: 'detached' }),
      makeAnnotation({ id: 'a3', status: 'block_level' }),
    ];
    const filtered = filterSealAnnotations(annotations);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((a) => a.id)).toEqual(['a1', 'a3']);
  });
});

describe('seal block resolution — block_level annotations (D7 text-search)', () => {
  let previewEl: HTMLElement;

  beforeEach(() => {
    previewEl = makePreviewDom([
      { line: 1, id: 'b1', text: 'Introduction to the document' },
      { line: 3, id: 'b2', text: 'Main content section with details' },
      { line: 5, id: 'b3', text: 'Conclusion and final remarks' },
    ]);
  });

  it('block_level annotation resolves by quoted_text text-search', () => {
    const ann = makeAnnotation({
      id: 'a1',
      status: 'block_level',
      quoted_text: 'Introduction',
      line_start: 0, // block_level annotations persist line 0 (D7)
    });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('b1');
  });

  it('block_level annotation resolves to the block containing the quoted_text', () => {
    const ann = makeAnnotation({
      id: 'a2',
      status: 'block_level',
      quoted_text: 'Main content',
      line_start: 0,
    });
    const block = resolveBlock(ann, previewEl);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('b2');
  });

  it('block_level annotation with empty quoted_text returns null', () => {
    const ann = makeAnnotation({
      id: 'a3',
      status: 'block_level',
      quoted_text: '',
      line_start: 0,
    });
    const block = resolveBlock(ann, previewEl);
    expect(block).toBeNull();
  });

  it('block_level annotation with non-matching quoted_text returns null', () => {
    const ann = makeAnnotation({
      id: 'a4',
      status: 'block_level',
      quoted_text: 'text that is not in any block',
      line_start: 0,
    });
    const block = resolveBlock(ann, previewEl);
    expect(block).toBeNull();
  });

  it('block_level annotation resolves to the FIRST matching block (first occurrence)', () => {
    // Add a second block with the same text.
    const container = makePreviewDom([
      { line: 1, id: 'first-match', text: 'Repeated content here' },
      { line: 3, id: 'second-match', text: 'Repeated content here too' },
    ]);
    const ann = makeAnnotation({
      id: 'a5',
      status: 'block_level',
      quoted_text: 'Repeated content',
      line_start: 0,
    });
    const block = resolveBlock(ann, container);
    expect(block).not.toBeNull();
    expect((block as HTMLElement).dataset.blockId).toBe('first-match');
  });
});

describe('seal stacking — multiple seals on same block', () => {
  it('two annotations on the same block produce distinct stack indices', () => {
    const previewEl = makePreviewDom([
      { line: 1, id: 'b1', text: 'First paragraph' },
    ]);

    const ann1 = makeAnnotation({ id: 'a1', line_start: 0, status: 'anchored' });
    const ann2 = makeAnnotation({ id: 'a2', line_start: 0, status: 'anchored' });

    const block1 = resolveBlock(ann1, previewEl);
    const block2 = resolveBlock(ann2, previewEl);

    // Both resolve to the same block.
    expect(block1).toBe(block2);
    expect((block1 as HTMLElement).dataset.blockId).toBe('b1');

    // Stacking: they resolve to the same element; the seal layer applies a
    // stack offset (SEAL_HEIGHT + SEAL_STACK_GAP) × index.
    const blockSealCount = new Map<Element, number>();
    const tops: number[] = [];
    const SEAL_HEIGHT = 22;
    const SEAL_STACK_GAP = 2;

    for (const ann of [ann1, ann2]) {
      const block = resolveBlock(ann, previewEl)!;
      const stackIdx = blockSealCount.get(block) ?? 0;
      blockSealCount.set(block, stackIdx + 1);
      tops.push(stackIdx * (SEAL_HEIGHT + SEAL_STACK_GAP));
    }

    expect(tops[0]).toBe(0);
    expect(tops[1]).toBe(SEAL_HEIGHT + SEAL_STACK_GAP);
  });
});
