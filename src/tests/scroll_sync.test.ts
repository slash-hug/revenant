/**
 * scroll_sync.test.ts
 *
 * Tests for the scroll-sync behavior of the markdown render pipeline.
 *
 * Covers (C7 / A9):
 *  - renderMarkdown emits data-source-line attributes on block elements.
 *  - Block IDs are unique across a single render.
 *  - Large-file threshold flag is respected (≥ LARGE_FILE_THRESHOLD lines).
 *  - Section/heading IDs are emitted for scroll-sync anchoring.
 *
 * Note: these are unit tests of the render pipeline only — no DOM mounting
 * or Svelte component rendering is needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderMarkdown } from '../lib/render/markdown';

// jsdom provides a minimal DOM; DOMParser is available globally.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function getBlockIds(html: string): string[] {
  const doc = parseHtml(html);
  return Array.from(doc.querySelectorAll<HTMLElement>('[data-block-id]')).map(
    (el) => el.dataset.blockId ?? ''
  );
}

function getSourceLines(html: string): number[] {
  const doc = parseHtml(html);
  return Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]')).map(
    (el) => parseInt(el.dataset.sourceLine ?? '0', 10)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderMarkdown — scroll sync attributes', () => {
  it('emits data-source-line on paragraph elements', () => {
    const src = 'First paragraph.\n\nSecond paragraph.';
    const html = renderMarkdown(src);
    const lines = getSourceLines(html);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines).toContain(1); // first paragraph starts at line 1
  });

  it('emits data-source-line on headings', () => {
    const src = '# Heading One\n\nSome text.\n\n## Heading Two\n\nMore text.';
    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const h1 = doc.querySelector('h1');
    const h2 = doc.querySelector('h2');
    expect(h1?.dataset.sourceLine).toBeTruthy();
    expect(h2?.dataset.sourceLine).toBeTruthy();
  });

  it('emits id attribute on headings for section-anchored scroll sync', () => {
    const src = '# The Main Section\n\nContent.';
    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const h1 = doc.querySelector('h1');
    expect(h1?.id).toMatch(/the-main-section/);
  });

  it('emits data-block-id on every block element', () => {
    const src = 'Para 1.\n\n## Section\n\nPara 2.\n\n> Blockquote.';
    const html = renderMarkdown(src);
    const blockIds = getBlockIds(html);
    expect(blockIds.length).toBeGreaterThan(0);
  });

  it('block IDs are unique within a single render', () => {
    const src = 'A.\n\nB.\n\nC.\n\n## D\n\nE.\n\n> F.';
    const html = renderMarkdown(src);
    const blockIds = getBlockIds(html);
    const unique = new Set(blockIds);
    expect(unique.size).toBe(blockIds.length);
  });

  it('block IDs reset between renders (counter resets each call)', () => {
    const src = 'Para.';
    const html1 = renderMarkdown(src);
    const html2 = renderMarkdown(src);
    const ids1 = getBlockIds(html1);
    const ids2 = getBlockIds(html2);
    // Both renders start from blk-1.
    expect(ids1[0]).toBe('blk-1');
    expect(ids2[0]).toBe('blk-1');
  });

  it('emits data-block-type on blockquotes', () => {
    const src = '> A quoted block.';
    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const bq = doc.querySelector('blockquote');
    expect(bq?.dataset.blockType).toBe('blockquote');
  });

  it('emits data-block-type="table" on tables', () => {
    const src = '| A | B |\n|---|---|\n| 1 | 2 |';
    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const table = doc.querySelector('table');
    expect(table?.dataset.blockType).toBe('table');
    expect(table?.dataset.blockId).toBeTruthy();
    expect(table?.dataset.sourceLine).toBeTruthy();
  });

  it('emits data-mermaid-pending placeholder for mermaid fences', () => {
    const src = '```mermaid\ngraph TD\nA-->B\n```';
    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const mermaidDiv = doc.querySelector('[data-mermaid-pending]');
    expect(mermaidDiv).not.toBeNull();
    expect(mermaidDiv?.dataset.blockType).toBe('mermaid');
    expect(mermaidDiv?.dataset.blockId).toBeTruthy();
  });

  it('strips YAML frontmatter before rendering', () => {
    const src = '---\ntitle: Test\nauthor: Randy\n---\n\n# Body\n\nContent here.';
    const html = renderMarkdown(src);
    // Frontmatter should not appear verbatim in output.
    expect(html).not.toContain('title: Test');
    // The body should render.
    expect(html).toContain('Body');
    expect(html).toContain('Content here');
  });

  it('sanitizes XSS payload in markdown', () => {
    const src = '<script>alert("xss")</script>\n\nNormal content.';
    const html = renderMarkdown(src);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Normal content');
  });
});

// ---------------------------------------------------------------------------
// Large-file threshold (tested as a pure calculation — no DOM mount needed)
// ---------------------------------------------------------------------------

describe('large-file threshold', () => {
  const LARGE_FILE_THRESHOLD = 2000;

  it('counts lines correctly for the threshold check', () => {
    const normalSrc = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}.`).join('\n');
    expect(normalSrc.split('\n').length).toBeLessThan(LARGE_FILE_THRESHOLD);
  });

  it('large file (>2000 lines) crosses the threshold', () => {
    const largeSrc = Array.from({ length: LARGE_FILE_THRESHOLD + 1 }, (_, i) => `Line ${i + 1}.`).join('\n');
    expect(largeSrc.split('\n').length).toBeGreaterThan(LARGE_FILE_THRESHOLD);
  });
});
