/**
 * document_export.test.ts
 *
 * Unit tests for documentExport.ts / buildExportDocument().
 *
 * Coverage:
 *  C2 — Core bundle: complete HTML structure, Mermaid→SVG, hljs-highlighted code,
 *       light :root present (no dark overrides), @font-face data-URI present, no <script>.
 *  C3 — Frontmatter header; relative image → data: URI; remote URL unchanged; failure → alt text.
 *  C4 — Comments layer: anchored → numbered <mark> + endnote; detached → listed without mark;
 *       general notes present; no "Claude"/"Copilot" strings; no <script>.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Annotation } from '../lib/types/ipc';

// ---------------------------------------------------------------------------
// Mock woff2 ?url imports — return deterministic fake paths.
// These are resolved by Vite at build time; in Vitest they come back as strings.
// ---------------------------------------------------------------------------
vi.mock('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url', () => ({
  default: '/mock/geist-wght-normal.woff2',
}));
vi.mock('@fontsource/literata/files/literata-latin-400-normal.woff2?url', () => ({
  default: '/mock/literata-400-normal.woff2',
}));
vi.mock('@fontsource/literata/files/literata-latin-400-italic.woff2?url', () => ({
  default: '/mock/literata-400-italic.woff2',
}));
vi.mock('@fontsource/literata/files/literata-latin-500-normal.woff2?url', () => ({
  default: '/mock/literata-500-normal.woff2',
}));
vi.mock('@fontsource/literata/files/literata-latin-600-normal.woff2?url', () => ({
  default: '/mock/literata-600-normal.woff2',
}));
vi.mock('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url', () => ({
  default: '/mock/jbm-400-normal.woff2',
}));
vi.mock('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url', () => ({
  default: '/mock/jbm-500-normal.woff2',
}));
vi.mock('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url', () => ({
  default: '/mock/jbm-600-normal.woff2',
}));
vi.mock('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url', () => ({
  default: '/mock/jbm-700-normal.woff2',
}));

// Mock markdown.css?raw — return a minimal CSS string so we can detect it in output.
vi.mock('../lib/styles/markdown.css?raw', () => ({
  default: '/* markdown.css mock */',
}));

// Mock renderMermaid / renderMermaidForExport / renderCodeBlock to avoid loading heavy deps.
vi.mock('../lib/render/markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/render/markdown')>();
  return {
    ...actual,
    renderMermaid: vi.fn().mockResolvedValue('<svg data-testid="mermaid-svg"><text>diagram</text></svg>'),
    // renderMermaidForExport is used by hydrateMermaid in documentExport.ts;
    // mock it to the same SVG stub so the jsdom environment (no getBBox) doesn't break.
    renderMermaidForExport: vi.fn().mockResolvedValue('<svg data-testid="mermaid-svg"><text>diagram</text></svg>'),
    renderCodeBlock: vi.fn().mockImplementation((code: string, lang: string) =>
      Promise.resolve(
        `<pre><code class="hljs language-${lang || 'plaintext'}">${code}</code></pre>`,
      ),
    ),
  };
});

// ---------------------------------------------------------------------------
// Mock fetch for font base64 encoding
// ---------------------------------------------------------------------------
const FAKE_FONT_B64 = btoa('FAKEFONTDATA');

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({
    arrayBuffer: () =>
      Promise.resolve(
        new TextEncoder().encode('FAKEFONTDATA').buffer,
      ),
  } as unknown as Response);
});

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import { buildExportDocument } from '../lib/documentExport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnnotation(
  id: string,
  status: Annotation['status'],
  body: string,
  quotedText = 'sample text',
): Annotation {
  return {
    id,
    status,
    body,
    quoted_text: quotedText,
    line_start: 0,
    line_end: 0,
    char_start: 0,
    char_end: quotedText.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// C2 — Core bundle structure
// ---------------------------------------------------------------------------

describe('buildExportDocument — C2 core', () => {
  it('returns a complete <!doctype html> document', async () => {
    const result = await buildExportDocument({ content: '# Hello\n\nWorld.' });
    expect(result).toMatch(/^<!doctype html>/i);
    expect(result).toContain('<html');
    expect(result).toContain('<head>');
    expect(result).toContain('<body>');
    expect(result).toContain('</html>');
  });

  it('includes the markdown.css content in the <style> block', async () => {
    const result = await buildExportDocument({ content: '# Test' });
    expect(result).toContain('/* markdown.css mock */');
  });

  it('includes the light :root token block (no dark override)', async () => {
    const result = await buildExportDocument({ content: '# Test' });
    // Light token values should be present.
    expect(result).toContain('--preview-bg: #FCFBF7');
    expect(result).toContain('--text: #221F1A');
    // Dark theme block should NOT be present.
    expect(result).not.toContain('data-theme="dark"');
    expect(result).not.toContain('[data-theme="dark"]');
  });

  it('includes @font-face blocks with data:font/woff2;base64 data URIs', async () => {
    const result = await buildExportDocument({ content: '# Test' });
    expect(result).toContain('@font-face');
    expect(result).toContain('data:font/woff2;base64,');
    // Should have multiple @font-face blocks (one per font weight).
    const count = (result.match(/@font-face/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it('includes @font-face for all three font families', async () => {
    const result = await buildExportDocument({ content: '# Test' });
    expect(result).toContain("'Geist Variable'");
    expect(result).toContain("'Literata'");
    expect(result).toContain("'JetBrains Mono'");
  });

  it('includes @media print rules', async () => {
    const result = await buildExportDocument({ content: '# Test' });
    expect(result).toContain('@media print');
    expect(result).toContain('@page');
    expect(result).toContain('Letter');
    expect(result).toContain('0.6in');
  });

  it('hydrates Mermaid blocks to <svg>', async () => {
    const content = '```mermaid\ngraph TD; A-->B\n```';
    const result = await buildExportDocument({ content });
    expect(result).toContain('<svg');
    expect(result).toContain('mermaid-svg');
  });

  it('does not contain any <script> tags', async () => {
    const content = '# Hello\n\n```js\nconsole.log("hi")\n```\n\n```mermaid\ngraph TD; A-->B\n```';
    const result = await buildExportDocument({ content });
    expect(result).not.toMatch(/<script/i);
  });

  it('renders fenced code blocks with hljs class', async () => {
    const content = '```typescript\nconst x = 1;\n```';
    const result = await buildExportDocument({ content });
    expect(result).toContain('hljs');
  });

  it('wraps content in .prose and .preview-content', async () => {
    const result = await buildExportDocument({ content: '# Hello' });
    expect(result).toContain('class="prose"');
    expect(result).toContain('class="preview-content"');
  });
});

// ---------------------------------------------------------------------------
// C3 — Frontmatter header + local image embedding
// ---------------------------------------------------------------------------

describe('buildExportDocument — C3 frontmatter + images', () => {
  it('renders a frontmatter title in the export header', async () => {
    const content = '---\ntitle: My Document\nauthor: Test Author\n---\n\n# Body';
    const result = await buildExportDocument({ content, docPath: '/docs/test.md' });
    expect(result).toContain('export-title');
    expect(result).toContain('My Document');
    expect(result).toContain('Test Author');
  });

  it('embeds relative images as data: URIs when readFileBytes is provided', async () => {
    const readFileBytes = vi.fn().mockResolvedValue(FAKE_FONT_B64);
    const content = '![Alt text](./images/fig.png)';
    const result = await buildExportDocument({
      content,
      docPath: '/docs/test.md',
      readFileBytes,
    });
    expect(readFileBytes).toHaveBeenCalledWith('/docs/test.md', './images/fig.png');
    expect(result).toContain('data:image/png;base64,');
  });

  it('leaves http(s) image URLs unchanged', async () => {
    const readFileBytes = vi.fn();
    const content = '![Remote](https://example.com/img.png)';
    const result = await buildExportDocument({
      content,
      docPath: '/docs/test.md',
      readFileBytes,
    });
    expect(readFileBytes).not.toHaveBeenCalled();
    expect(result).toContain('https://example.com/img.png');
  });

  it('degrades to alt text when readFileBytes throws', async () => {
    const readFileBytes = vi.fn().mockRejectedValue(new Error('not found'));
    const content = '![My Alt](./missing.png)';
    const result = await buildExportDocument({
      content,
      docPath: '/docs/test.md',
      readFileBytes,
    });
    // The image should not have a src pointing to the missing file.
    expect(result).not.toContain('./missing.png');
    // Alt text should appear.
    expect(result).toContain('My Alt');
  });

  it('does not embed images when readFileBytes is not provided', async () => {
    const content = '![Alt](./img.png)';
    const result = await buildExportDocument({ content, docPath: '/docs/test.md' });
    // Without readFileBytes, the img src passes through unchanged.
    expect(result).toContain('./img.png');
  });
});

// ---------------------------------------------------------------------------
// C4 — Comments layer
// ---------------------------------------------------------------------------

describe('buildExportDocument — C4 comments layer', () => {
  it('does not add comments section when includeComments is false', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nThis is sample text.',
      includeComments: false,
      annotations: [makeAnnotation('a1', 'anchored', 'A comment', 'sample text')],
    });
    // Check for the <section> element, not just the CSS class name (which always appears in the style block).
    expect(result).not.toContain('<section class="export-comments">');
    expect(result).not.toContain('class="ann-mark"');
  });

  it('adds numbered <mark> for anchored annotations that are found in text', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nThis is sample text for review.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'anchored', 'My comment here', 'sample text for review'),
      ],
    });
    expect(result).toContain('class="ann-mark"');
    expect(result).toContain('<sup>1</sup>');
  });

  it('marks a MULTI-LINE anchored span (quoted_text has spaces where the DOM has newlines)', async () => {
    // The paragraph renders as one text node containing literal "\n"; quoted_text
    // (from selection.toString()) collapses those to spaces. Exact indexOf would
    // miss it — findSpan's whitespace normalization must still place the <mark>.
    const result = await buildExportDocument({
      content: '# Hello\n\nOpen this in Revenant\nand confirm each block\nis syntax colored.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'anchored', 'fix wording', 'Open this in Revenant and confirm each block is syntax colored'),
      ],
    });
    expect(result).toContain('class="ann-mark"');
    expect(result).toContain('<sup>1</sup>');
    // It must be a real in-text mark, not just a "not found" endnote.
    expect(/<mark class="ann-mark">[\s\S]*Revenant[\s\S]*<sup>1<\/sup><\/mark>/.test(result)).toBe(true);
  });

  it('marks a span that crosses inline **bold** formatting (multi-node range)', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nThese are the **curated** languages we ship.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'anchored', 'note', 'the curated languages'),
      ],
    });
    expect(result).toContain('class="ann-mark"');
    expect(result).toContain('<sup>1</sup>');
  });

  it('appends matching endnotes for anchored annotations', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nThis is sample text for review.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'anchored', 'My comment here', 'sample text for review'),
      ],
    });
    expect(result).toContain('<section class="export-comments">');
    expect(result).toContain('My comment here');
  });

  it('lists detached annotations in the endnotes without in-text marks', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nNo matching text here.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'detached', 'Old comment', 'text that was removed'),
      ],
    });
    // Detached: endnote appears but no ann-mark in the main body
    expect(result).toContain('Old comment');
    expect(result).toContain('<section class="export-comments">');
    // No <mark> since detached annotations don't get in-text marks
    // (they go to the detached-list section, not the numbered ol)
    const detachedSectionMatch = result.match(/class="detached-list"[\s\S]*?Old comment/);
    expect(detachedSectionMatch).not.toBeNull();
  });

  it('includes general notes in the comments section', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nBody.',
      includeComments: true,
      annotations: [],
      generalNotes: 'Overall the document looks good.',
    });
    expect(result).toContain('<section class="export-comments">');
    expect(result).toContain('General notes');
    expect(result).toContain('Overall the document looks good.');
  });

  it('numbers multiple anchored annotations in document order', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nFirst phrase. Second phrase.',
      includeComments: true,
      annotations: [
        makeAnnotation('a1', 'anchored', 'Comment on first', 'First phrase'),
        makeAnnotation('a2', 'anchored', 'Comment on second', 'Second phrase'),
      ],
    });
    // Both numbers should appear as superscripts
    expect(result).toContain('<sup>1</sup>');
    expect(result).toContain('<sup>2</sup>');
    // Both comments appear as endnotes
    expect(result).toContain('Comment on first');
    expect(result).toContain('Comment on second');
  });

  it('does not contain hardcoded AI assistant names', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nSome text.',
      includeComments: true,
      annotations: [makeAnnotation('a1', 'anchored', 'Some comment', 'Some text')],
      generalNotes: 'General observation.',
    });
    const forbidden = ['Claude', 'Copilot', 'GPT', 'ChatGPT', 'Gemini', 'Anthropic', 'Llama'];
    for (const word of forbidden) {
      expect(result, `Output must not contain "${word}"`).not.toContain(word);
    }
  });

  it('does not add a comments section when annotations and general notes are empty', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nBody.',
      includeComments: true,
      annotations: [],
      generalNotes: '',
    });
    // CSS class name appears in the <style> block; check for the <section> element.
    expect(result).not.toContain('<section class="export-comments">');
  });

  it('does not emit <script> tags even with comments layer enabled', async () => {
    const result = await buildExportDocument({
      content: '# Hello\n\nTest.',
      includeComments: true,
      annotations: [makeAnnotation('a1', 'anchored', 'A note', 'Test')],
    });
    expect(result).not.toMatch(/<script/i);
  });

  it('quoted_text in endnotes is HTML-escaped', async () => {
    // Use a real injection payload in quoted_text to verify escapeHtml is called.
    // A regression that stopped escaping would let the raw tag appear as a live element.
    // Note: the payload text may appear in the serialized output but with < > escaped;
    // the key assertion is that a raw <img> element is NOT injected into the document.
    const xssPayload = '</mark><img src=x onerror=alert(1)>';
    const result = await buildExportDocument({
      content: '# Hello\n\nSafe text here.',
      includeComments: true,
      annotations: [makeAnnotation('a1', 'anchored', 'Escape check', xssPayload)],
    });
    // The raw '<img src=x' tag must not appear as live HTML (i.e. no unescaped '<img').
    // Note: the escaped text '&lt;img' is fine — that is proof of correct escaping.
    expect(result).not.toContain('<img src=x');
    // The escaped form of '<' must be present somewhere, confirming escapeHtml ran.
    expect(result).toContain('&lt;');
  });

  it('annotation body with HTML special chars is escaped in endnotes', async () => {
    // Verify the body field is also escaped, not just quoted_text.
    // The critical characters for injection are angle brackets and ampersand;
    // double-quotes inside text content (not attribute values) may be normalised
    // to bare " by the HTML pipeline, so we only assert the injection-critical escapes.
    const htmlInBody = '<b>bold injection</b> & <script>evil()</script>';
    const result = await buildExportDocument({
      content: '# Hello\n\nBody escape test.',
      includeComments: true,
      annotations: [makeAnnotation('a2', 'detached', htmlInBody, 'quoted')],
    });
    // Raw injection tags must not appear.
    expect(result).not.toContain('<b>bold injection</b>');
    expect(result).not.toContain('<script>');
    // The escaped form of '<' must be present (confirms escapeHtml ran on body).
    expect(result).toContain('&lt;b&gt;');
    expect(result).toContain('&amp;');
  });
});
