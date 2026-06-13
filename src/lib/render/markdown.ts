/**
 * markdown.ts — markdown-it render pipeline.
 *
 * Decisions implemented here:
 *  - C15 / A8  DOMPurify sanitization of rendered HTML output.
 *  - A11        Lazy dynamic import of Mermaid + highlight.js, pinned to
 *               major versions in package.json. Per-block error isolation.
 *  - C7 / A9   Block IDs emitted on every block-level token so PreviewPane
 *               can implement section-anchored scroll sync.
 *  - C8         data-source-line attributes on block tokens so the
 *               HTML→source mapping layer can correlate preview selection
 *               back to source line numbers. Degrades to block-level for
 *               Mermaid/table/footnote blocks.
 *
 * The module exports:
 *  - renderMarkdown(src)        → sanitized HTML string (sync, no Mermaid/hljs)
 *  - renderCodeBlock(code, lang) → sanitized HTML for a single code block
 *                                  (lazy-loads highlight.js, async)
 *  - renderMermaid(code)        → sanitized SVG string (lazy-loads Mermaid, async)
 *  - FRONTMATTER_RE             → regex to strip YAML frontmatter before render
 */

import MarkdownIt from 'markdown-it';
// markdown-it-footnote ships no TypeScript declarations.
// The ambient module declaration in markdown-it-footnote.d.ts stubs the types.
import MarkdownItFootnote from 'markdown-it-footnote';
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';

// ---------------------------------------------------------------------------
// DOMPurify config
// ---------------------------------------------------------------------------

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'del', 's', 'u', 'sub', 'sup',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span',
    // SVG subset needed for Mermaid output
    'svg', 'g', 'path', 'text', 'rect', 'circle', 'line', 'polygon',
    'polyline', 'ellipse', 'use', 'defs', 'marker', 'clipPath',
    'foreignObject', 'tspan',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'id',
    // Data attributes used for scroll-sync and source mapping (C7/C8)
    'data-block-id', 'data-source-line', 'data-block-type',
    // SVG attributes
    'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'r', 'cx', 'cy',
    'd', 'points', 'transform', 'style', 'xmlns',
    'marker-end', 'marker-start', 'clip-path', 'font-size', 'font-family',
    'text-anchor', 'dominant-baseline',
  ],
  ADD_ATTR: ['target'], // allow target on <a> for external links
  FORCE_BODY: false,
} as const;

// ---------------------------------------------------------------------------
// Frontmatter stripping
// ---------------------------------------------------------------------------

export const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export interface FrontmatterResult {
  content: string;
  raw: string | null;
}

export function stripFrontmatter(src: string): FrontmatterResult {
  const match = src.match(FRONTMATTER_RE);
  if (match) {
    return { content: src.slice(match[0].length), raw: match[0] };
  }
  return { content: src, raw: null };
}

// ---------------------------------------------------------------------------
// Block ID counter (resets per render)
// ---------------------------------------------------------------------------

let _blockCounter = 0;
function nextBlockId(): string {
  return `blk-${++_blockCounter}`;
}

// ---------------------------------------------------------------------------
// markdown-it instance
// ---------------------------------------------------------------------------

const md = new MarkdownIt({
  html: true, // allow raw HTML in source (sanitized afterward)
  linkify: true,
  typographer: true,
  // Code highlighting is handled lazily via renderCodeBlock; return empty
  // here so per-block errors don't surface as renderer crashes.
  highlight: () => '',
}).use(MarkdownItFootnote);

// ---------------------------------------------------------------------------
// Source-line + block-ID injection (C7/C8)
//
// We override the fence (code block), bullet_list_open, ordered_list_open,
// table_open, and blockquote_open renderer rules to inject:
//   data-source-line  — 1-based line number of the opening token
//   data-block-id     — unique id used for scroll sync and annotation anchoring
//   data-block-type   — 'mermaid' | 'table' | 'list' | 'blockquote' | 'code'
//                        (lets the anchor layer pick block vs source anchoring)
// ---------------------------------------------------------------------------

const defaultFence = md.renderer.rules.fence?.bind(md.renderer) ?? (() => '');

md.renderer.rules.fence = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const lang = (token.info || '').trim();
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0; // 1-based

  if (lang === 'mermaid') {
    // Return a placeholder div; PreviewPane hydrates it asynchronously.
    return `<div data-mermaid-pending data-block-id="${blockId}" data-source-line="${sourceLine}" data-block-type="mermaid">${escapeHtml(token.content)}</div>`;
  }

  // For normal code blocks: wrap in a span with block metadata, then the
  // default renderer handles the <pre><code> markup.
  const inner = defaultFence(tokens, idx, options, env, self);
  return inner.replace(
    /^<pre/,
    `<pre data-block-id="${blockId}" data-source-line="${sourceLine}" data-block-type="code"`
  );
};

// Table: inject on the opening <table> tag.
md.renderer.rules.table_open = function (tokens, idx) {
  const token = tokens[idx];
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0;
  return `<table data-block-id="${blockId}" data-source-line="${sourceLine}" data-block-type="table">`;
};

// Blockquote.
md.renderer.rules.blockquote_open = function (tokens, idx) {
  const token = tokens[idx];
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0;
  return `<blockquote data-block-id="${blockId}" data-source-line="${sourceLine}" data-block-type="blockquote">`;
};

// Paragraphs.
const defaultParagraphOpen = md.renderer.rules.paragraph_open?.bind(md.renderer);
md.renderer.rules.paragraph_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0;
  const base = defaultParagraphOpen
    ? defaultParagraphOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return base.replace(/^<p/, `<p data-block-id="${blockId}" data-source-line="${sourceLine}"`);
};

// Headings: add id for scroll-sync anchoring (C7).
md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const nextToken = tokens[idx + 1]; // inline content
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0;

  // Derive a slug from the heading text for scroll-sync.
  const headingText = nextToken?.children
    ?.map((t) => t.content)
    .join('') ?? '';
  const slug = headingText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  return `<${token.tag} id="${slug}" data-block-id="${blockId}" data-source-line="${sourceLine}">`;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render markdown source to sanitized HTML.
 * Resets the block counter so each render produces stable IDs.
 * Frontmatter is stripped before rendering.
 * Code blocks with lang=mermaid become placeholder <div data-mermaid-pending>.
 * Code blocks with other langs are unstyled until PreviewPane hydrates them.
 */
export function renderMarkdown(src: string): string {
  _blockCounter = 0;
  const { content } = stripFrontmatter(src);
  const rawHtml = md.render(content);
  return DOMPurify.sanitize(rawHtml, PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
}

/**
 * Async syntax-highlight a single code block via lazy-loaded highlight.js.
 * Returns sanitized HTML.
 * Errors are isolated — if hljs fails, returns the plain code block.
 */
export async function renderCodeBlock(code: string, lang: string): Promise<string> {
  try {
    const hljs = (await import('highlight.js')).default;
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    const result = hljs.highlight(code, { language: validLang });
    const highlighted = `<pre><code class="hljs language-${validLang}">${result.value}</code></pre>`;
    return DOMPurify.sanitize(highlighted, PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
  } catch {
    // Per-block error isolation: return plain code block, don't crash.
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Async render a Mermaid diagram, returning a sanitized SVG string.
 * If Mermaid fails (invalid diagram, CSP, etc.), returns an error block
 * so the surrounding preview continues rendering (per-block error isolation).
 */
export async function renderMermaid(code: string, blockId: string): Promise<string> {
  try {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    const id = `mermaid-${blockId}`;
    const { svg } = await mermaid.render(id, code);
    // Sanitize the SVG output (C15 — Mermaid SVG is user/agent-supplied).
    const sanitized = DOMPurify.sanitize(svg, PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
    return sanitized;
  } catch (err) {
    const msg = err instanceof Error ? escapeHtml(err.message) : 'Diagram error';
    return `<div class="mermaid-error" data-block-id="${blockId}"><strong>Diagram error:</strong> ${msg}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
