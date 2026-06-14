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
 * T3.1 — Mermaid v11 exports & diagram set (R-MERMAID-EXPORTS / R-MERMAID-SET):
 *   mermaid@11 exports a single entry `mermaid` → `dist/mermaid.core.mjs`.
 *   There is no separate per-diagram registration API at the consumer level;
 *   v11 uses `registerLazyLoadedDiagrams` internally at module init time to
 *   declare ALL diagram types as on-demand dynamic imports. Each diagram type
 *   only loads its chunk when `mermaid.render()` is called with that diagram
 *   syntax. Consumers cannot selectively exclude diagram types without forking
 *   the mermaid package.
 *
 *   Ratified diagram set (R-MERMAID-SET): flowchart, sequence, class, state,
 *   er, gantt, pie, gitGraph — all present in the mermaid.core bundle and
 *   available for on-demand rendering.
 *
 *   d3 transitive (R-D3-TRANSITIVE): d3 is an internal dependency of the
 *   flowchart layout engine bundled inside mermaid.core. It cannot be separated
 *   from flowchart support.
 *
 *   katex / cytoscape / roughjs (T3.4): These appear as separate Vite chunks
 *   because they are dynamically imported by specific mermaid diagram lazy
 *   chunks. They are NOT loaded at startup — only when a diagram of the
 *   matching type is first rendered. They cannot be eliminated from the build
 *   output without removing the diagram types that use them (architecture →
 *   cytoscape+rough, non-flowchart equation blocks → katex). Keeping flowchart
 *   and all ratified types means these remain as lazy-loaded separate chunks,
 *   which is the achievable trim for v11. Human ratification required if the
 *   architecture diagram type should be excluded to shed cytoscape+rough.
 *
 * T3.2 — highlight.js curated import (R-HLJS-CORE):
 *   Import `highlight.js/lib/core` (not the full bundle) and register only the
 *   languages needed for this app. This eliminates ~170 languages from the hljs
 *   chunk. The curated set covers the most common code languages found in
 *   markdown review documents and spec files.
 *
 *   Mermaid initialize order (C-MERMAID-INIT):
 *   mermaid.initialize({startOnLoad:false, securityLevel:'strict'}) is called
 *   once at module level after the dynamic import resolves (run-once guard via
 *   _mermaidInitialized flag). In v11 the correct order is: import →
 *   initialize → render. Calling initialize() per render() call is safe but
 *   wasteful; the run-once guard avoids redundant re-initialization.
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
    // SVG subset for raw SVG embedded in document markdown (Mermaid output is
    // sanitized separately with MERMAID_PURIFY_CONFIG). `foreignObject` is
    // deliberately EXCLUDED here — it embeds HTML-namespace content inside SVG and
    // is a classic sanitizer-bypass surface with no use in plain document SVG
    // (security #12). Mermaid's own config re-adds it for its HTML labels.
    'svg', 'g', 'path', 'text', 'rect', 'circle', 'line', 'polygon',
    'polyline', 'ellipse', 'use', 'defs', 'marker', 'clipPath',
    'tspan',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'id',
    // rel is explicitly allowed so the after-sanitize hook can inject
    // rel="noopener noreferrer" on external links (see DOMPurify.addHook below).
    'rel',
    // Data attributes used for scroll-sync and source mapping (C7/C8)
    'data-block-id', 'data-source-line', 'data-block-type',
    // SVG attributes
    'viewBox', 'width', 'height', 'fill', 'stroke', 'stroke-width',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'r', 'cx', 'cy',
    // `style` is deliberately EXCLUDED — an inline style attribute on embedded
    // raw HTML/SVG is a CSS-injection / UI-redress surface with no use in
    // document markdown (markdown-it/hljs emit none). Mermaid keeps it via its
    // own profile-based config (security #12).
    'd', 'points', 'transform', 'xmlns',
    'marker-end', 'marker-start', 'clip-path', 'font-size', 'font-family',
    'text-anchor', 'dominant-baseline',
  ],
  // target="_blank" is kept to render links in the default browser rather than
  // the Tauri webview (the Tauri CSP prevents navigation anyway).  rel is
  // enforced via the afterSanitizeAttributes hook below to prevent
  // reverse-tabnapping on any link that carries a target attribute.
  ADD_ATTR: ['target'],
  FORCE_BODY: false,
} as const;

// Mermaid renders its node/label theming as a `<style>` block inside the SVG
// (class-based, e.g. `.node rect { fill: … }`) plus `<foreignObject>` HTML labels.
// A hand-rolled SVG allowlist is too incomplete — it strips the styling and
// labels, leaving black nodes. Use DOMPurify's built-in svg + html profiles (the
// documented way to sanitize Mermaid output), explicitly adding `<style>` and
// `<foreignObject>` (excluded from the default profiles) so diagrams render fully.
// Applied ONLY to Mermaid's own output (securityLevel:'strict' is also on);
// general markdown keeps the stricter PURIFY_CONFIG so a doc can't inject CSS/HTML.
const MERMAID_PURIFY_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['style', 'foreignObject'],
  ADD_ATTR: ['dominant-baseline', 'data-block-id', 'data-source-line', 'data-block-type'],
} as const;

// ---------------------------------------------------------------------------
// DOMPurify hook: enforce rel="noopener noreferrer" on all anchors that carry
// a target attribute. This prevents reverse-tabnapping regardless of whether
// the markdown source included rel.
// ---------------------------------------------------------------------------
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

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

// ---------------------------------------------------------------------------
// highlight.js run-once registration guard (T3.2 / R-HLJS-CORE)
// ---------------------------------------------------------------------------

/**
 * In-flight promise for the hljs load+registration sequence.
 *
 * Caching the promise (not just a boolean flag) makes the guard
 * concurrency-safe: two renderCodeBlock() calls issued before the first
 * await resolves both receive the *same* promise and wait for the single
 * registration pass rather than each starting a redundant one.
 */
let _hljsPromise: Promise<typeof import('highlight.js/lib/core')['default']> | null = null;

/**
 * Lazily load `highlight.js/lib/core` (tree-shakeable core, not the full
 * bundle) and register only the curated language set on first call.
 * Subsequent calls return the already-settled promise from the module
 * cache without re-registering — and concurrent calls share the in-flight
 * promise, preventing redundant parallel registration sequences.
 *
 * Curated language set rationale: covers the most common code languages in
 * markdown review and spec documents (source code, config files, data formats,
 * shell scripts). Omits the ~170 languages in the full hljs bundle.
 */
async function loadHljs() {
  if (_hljsPromise) return _hljsPromise;

  _hljsPromise = (async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    const [
      javascript, typescript, rust, python, go,
      json, yaml, bash, sql, xml, css,
      markdown, diff, dockerfile, c, cpp, java,
    ] = await Promise.all([
      import('highlight.js/lib/languages/javascript').then((m) => m.default),
      import('highlight.js/lib/languages/typescript').then((m) => m.default),
      import('highlight.js/lib/languages/rust').then((m) => m.default),
      import('highlight.js/lib/languages/python').then((m) => m.default),
      import('highlight.js/lib/languages/go').then((m) => m.default),
      import('highlight.js/lib/languages/json').then((m) => m.default),
      import('highlight.js/lib/languages/yaml').then((m) => m.default),
      import('highlight.js/lib/languages/bash').then((m) => m.default),
      import('highlight.js/lib/languages/sql').then((m) => m.default),
      import('highlight.js/lib/languages/xml').then((m) => m.default),
      import('highlight.js/lib/languages/css').then((m) => m.default),
      import('highlight.js/lib/languages/markdown').then((m) => m.default),
      import('highlight.js/lib/languages/diff').then((m) => m.default),
      import('highlight.js/lib/languages/dockerfile').then((m) => m.default),
      import('highlight.js/lib/languages/c').then((m) => m.default),
      import('highlight.js/lib/languages/cpp').then((m) => m.default),
      import('highlight.js/lib/languages/java').then((m) => m.default),
    ]);
    hljs.registerLanguage('javascript', javascript);
    hljs.registerLanguage('typescript', typescript);
    hljs.registerLanguage('rust', rust);
    hljs.registerLanguage('python', python);
    hljs.registerLanguage('go', go);
    hljs.registerLanguage('json', json);
    hljs.registerLanguage('yaml', yaml);
    hljs.registerLanguage('bash', bash);
    hljs.registerLanguage('sh', bash); // alias
    hljs.registerLanguage('sql', sql);
    hljs.registerLanguage('xml', xml);
    hljs.registerLanguage('html', xml); // alias
    hljs.registerLanguage('css', css);
    hljs.registerLanguage('markdown', markdown);
    hljs.registerLanguage('diff', diff);
    hljs.registerLanguage('dockerfile', dockerfile);
    hljs.registerLanguage('c', c);
    hljs.registerLanguage('cpp', cpp);
    hljs.registerLanguage('java', java);
    return hljs;
  })();

  return _hljsPromise;
}

// ---------------------------------------------------------------------------
// Mermaid run-once initialization guard (T3.2 / C-MERMAID-INIT)
// ---------------------------------------------------------------------------

/**
 * In-flight promise for the Mermaid load+initialize sequence.
 *
 * Caching the promise (not just a boolean flag) makes the guard
 * concurrency-safe: two renderMermaid() calls issued before the first
 * await resolves both receive the *same* promise and wait for the single
 * initialize() call rather than each running a redundant one.
 */
let _mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null;
let _mermaidTheme: 'default' | 'dark' | null = null;

/** The Mermaid theme matching the app's current light/dark mode. */
function currentMermaidTheme(): 'default' | 'dark' {
  return typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark'
    ? 'dark'
    : 'default';
}

/**
 * Lazily load Mermaid; (re)initialize only when the app theme changes so
 * diagrams match light/dark mode instead of always rendering light.
 *
 * v11 initialization order: import → initialize → render. The module import is
 * cached; initialize() is re-run only on a theme switch (cheap, and required for
 * the new theme to take effect on subsequently-rendered diagrams).
 *
 * securityLevel: 'strict' — Mermaid will not execute any scripts embedded in
 * diagram definitions. Combined with DOMPurify sanitization of the SVG output
 * (MERMAID_PURIFY_CONFIG), this is the correct defense-in-depth posture.
 */
async function loadMermaid() {
  if (!_mermaidPromise) {
    _mermaidPromise = (async () => (await import('mermaid')).default)();
  }
  const mermaid = await _mermaidPromise;

  const theme = currentMermaidTheme();
  if (theme !== _mermaidTheme) {
    // Mermaid's stock 'dark' node fill (#1f2020) is almost the same as the app's
    // dark card, so diagrams read as faint outlines. Lift the node fill off the
    // background and use the app's accent border + light text for contrast.
    const themeVariables = theme === 'dark'
      ? {
          darkMode: true,
          background: '#1C1D20',
          mainBkg: '#2b2f37',          // flowchart node fill — lifted off the card
          nodeBorder: '#7FA6CC',        // app accent
          nodeTextColor: '#D6D7DA',
          primaryColor: '#2b2f37',
          primaryBorderColor: '#7FA6CC',
          primaryTextColor: '#D6D7DA',
          secondaryColor: '#343842',
          tertiaryColor: '#23262d',
          lineColor: '#9aa0a6',
          textColor: '#D6D7DA',
        }
      : undefined;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, themeVariables });
    _mermaidTheme = theme;
  }
  return mermaid;
}

/**
 * Async syntax-highlight a single code block via lazy-loaded highlight.js.
 * Returns sanitized HTML.
 * Errors are isolated — if hljs fails, returns the plain code block.
 */
export async function renderCodeBlock(code: string, lang: string): Promise<string> {
  try {
    const hljs = await loadHljs();
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
    const mermaid = await loadMermaid();
    const id = `mermaid-${blockId}`;
    const { svg } = await mermaid.render(id, code);
    // Sanitize with the Mermaid-scoped config so the embedded <style> theming
    // survives (C15 — Mermaid SVG is still sanitized; strict mode is on).
    const sanitized = DOMPurify.sanitize(svg, MERMAID_PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
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
