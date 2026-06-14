/**
 * preview_isolation.test.ts
 *
 * Tests that per-block error isolation works: a broken Mermaid fence or
 * malformed input does not crash the rest of the preview render.
 *
 * Covers (A11 / spec §6):
 *  - A broken mermaid block becomes an error placeholder, not an exception.
 *  - Valid markdown surrounding the broken block renders correctly.
 *  - renderMermaid() isolates errors per-block and returns an error div.
 *  - renderCodeBlock() degrades gracefully on unknown languages.
 *
 * Note: Mermaid and highlight.js are lazy-loaded; their dynamic imports
 * are mocked so tests run in jsdom without CSP/worker restrictions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderMarkdown, renderMermaid, renderCodeBlock } from '../lib/render/markdown';

// ---------------------------------------------------------------------------
// Mock dynamic imports for Mermaid and highlight.js
// (These are lazy-loaded in the render pipeline; we mock them at module level.)
// ---------------------------------------------------------------------------

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

// markdown.ts now imports from 'highlight.js/lib/core' (curated bundle, T3.2).
// The mock must match that path so Vitest intercepts the dynamic import.
vi.mock('highlight.js/lib/core', () => ({
  default: {
    getLanguage: vi.fn(),
    highlight: vi.fn(),
    registerLanguage: vi.fn(),
  },
}));

// Stub the individual language imports that loadHljs() pulls in.
// They are only used for registerLanguage() which is mocked above.
// Each factory must be inline (not a shared const) because vi.mock() calls
// are hoisted by Vitest before any const declarations in the module scope.
vi.mock('highlight.js/lib/languages/javascript', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/typescript', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/rust', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/python', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/go', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/json', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/yaml', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/bash', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/sql', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/xml', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/css', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/markdown', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/diff', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/dockerfile', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/c', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/cpp', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/java', () => ({ default: vi.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ---------------------------------------------------------------------------
// renderMarkdown — error isolation
// ---------------------------------------------------------------------------

describe('renderMarkdown — per-block error isolation', () => {
  it('renders a mermaid fence as a placeholder div without crashing', () => {
    const src = [
      '# Section',
      '',
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '',
      'Content after the diagram.',
    ].join('\n');

    const html = renderMarkdown(src);
    const doc = parseHtml(html);

    // Mermaid block → placeholder (hydrated async by PreviewPane).
    const mermaidDiv = doc.querySelector('[data-mermaid-pending]');
    expect(mermaidDiv).not.toBeNull();
    // Surrounding content still renders.
    expect(doc.querySelector('h1')?.textContent).toContain('Section');
    expect(doc.body.textContent).toContain('Content after the diagram.');
  });

  it('renders valid markdown around a broken code fence without crashing', () => {
    // Unclosed code fence — markdown-it handles it gracefully.
    const src = [
      '# Before',
      '',
      '```',
      'unclosed fence',
      '',
      '# After',
      '',
      'Paragraph after.',
    ].join('\n');

    let html: string;
    expect(() => { html = renderMarkdown(src); }).not.toThrow();
    // Should contain some rendered content.
    expect(html!).toBeTruthy();
  });

  it('does not expose raw script tags (XSS protection)', () => {
    const src = '```mermaid\n<script>alert(1)</script>\n```\n\nSafe text.';
    const html = renderMarkdown(src);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Safe text');
  });

  it('renders multiple mermaid blocks each with unique block IDs', () => {
    const src = [
      '```mermaid',
      'graph A',
      '```',
      '',
      '```mermaid',
      'graph B',
      '```',
    ].join('\n');

    const html = renderMarkdown(src);
    const doc = parseHtml(html);
    const divs = doc.querySelectorAll('[data-mermaid-pending]');
    expect(divs).toHaveLength(2);
    const ids = Array.from(divs).map((d) => (d as HTMLElement).dataset.blockId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// renderMermaid — async, per-block error isolation
// ---------------------------------------------------------------------------

describe('renderMermaid — per-block isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error div when mermaid.render() rejects', async () => {
    const mermaid = (await import('mermaid')).default;
    (mermaid.render as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('parse error: unexpected token')
    );

    const result = await renderMermaid('invalid graph syntax !!!', 'blk-1');

    expect(result).toContain('Diagram error');
    expect(result).not.toContain('<script>');
  });

  it('returns error div when mermaid.render() throws synchronously', async () => {
    const mermaid = (await import('mermaid')).default;
    (mermaid.render as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new TypeError('Cannot read properties of undefined');
    });

    const result = await renderMermaid('graph TD\nA-->B', 'blk-2');
    expect(result).toContain('Diagram error');
  });

  it('returns sanitized SVG on success', async () => {
    const fakeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>';
    const mermaid = (await import('mermaid')).default;
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ svg: fakeSvg });

    const result = await renderMermaid('graph TD\nA-->B', 'blk-3');
    // Result should contain SVG but no injected scripts.
    expect(result).toContain('<svg');
    expect(result).not.toContain('<script>');
  });

  it('sanitizes malicious SVG from mermaid output', async () => {
    const maliciousSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><g>diagram</g></svg>';
    const mermaid = (await import('mermaid')).default;
    (mermaid.render as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ svg: maliciousSvg });

    const result = await renderMermaid('graph TD\nA-->B', 'blk-4');
    expect(result).not.toContain('<script>');
    // The SVG element itself should still be present.
    expect(result).toContain('diagram');
  });
});

// ---------------------------------------------------------------------------
// renderCodeBlock — graceful degradation
// ---------------------------------------------------------------------------

describe('renderCodeBlock — graceful degradation', () => {
  it('returns plain code block when hljs fails to load', async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    (hljs.getLanguage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('module load failed');
    });

    const result = await renderCodeBlock('const x = 1;', 'javascript');
    // Should fall back to unformatted code, not throw.
    expect(result).toContain('const x = 1;');
    expect(result).toContain('<code>');
  });

  it('returns highlighted code on success', async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    (hljs.getLanguage as ReturnType<typeof vi.fn>).mockReturnValueOnce({ name: 'javascript' });
    (hljs.highlight as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      value: '<span class="hljs-keyword">const</span> x = 1;',
    });

    const result = await renderCodeBlock('const x = 1;', 'javascript');
    expect(result).toContain('hljs-keyword');
    expect(result).not.toContain('<script>');
  });

  it('falls back gracefully for unknown language', async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    // getLanguage returns falsy for unknown lang → falls through.
    (hljs.getLanguage as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    (hljs.highlight as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      value: 'plain text',
    });

    const result = await renderCodeBlock('plain text', 'unknownlang');
    expect(result).toBeTruthy();
  });
});
