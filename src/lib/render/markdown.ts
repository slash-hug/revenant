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
    // Collapsible callouts use native <details>/<summary> (T1.2 / TRAP 1).
    // Without these, every [!type]- callout is silently stripped to inner text.
    'details', 'summary',
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
    // data-callout carries the raw callout type (e.g. "warning") for CSS
    // family selection and potential JS hooks (T1.2 / T1.3).
    'data-callout',
    // open is a boolean attribute on <details> for collapsible callouts.
    // DOMPurify strips unknown boolean attributes by default (TRAP 1 / B-ux risk).
    'open',
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

// ---------------------------------------------------------------------------
// Shared slug helper (T1.1)
//
// Extracted from the inline block previously in heading_open so both
// heading_open and the wikilink inline rule use the same algorithm — prevents
// [[#My Heading]] href drift from the heading id (TRAP 2).
// ---------------------------------------------------------------------------

/**
 * Convert heading text to a URL-safe slug for anchor ids / wikilink hrefs.
 * Known v1 limits: Unicode/CJK/accented chars are stripped (not transliterated),
 * and duplicate headings produce the same slug (first wins) — both accepted as
 * documented limitations (B-8).
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

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
// We override the fence (code block), list_item_open, table_open,
// blockquote_open, paragraph_open, and heading_open renderer rules to inject:
//   data-source-line  — 1-based line number of the opening token
//   data-block-id     — unique id used for scroll sync and annotation anchoring
//   data-block-type   — 'mermaid' | 'table' | 'list' | 'blockquote' | 'code'
//                        (lets the anchor layer pick block vs source anchoring)
//
// List items carry their own metadata (not just the list container): a TIGHT
// list renders inline text directly inside <li> with no inner <p>, so without
// this the "+ Add comment" affordance and annotation anchoring have no
// source-mapped ancestor to attach to when the user selects text in a list.
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

// List items: inject per-item metadata so selecting text inside a (tight) list
// item — which has no inner <p> to carry data-source-line — still resolves to a
// source line, so the "+ Add comment" affordance and annotation anchoring work.
const defaultListItemOpen = md.renderer.rules.list_item_open?.bind(md.renderer);
md.renderer.rules.list_item_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const blockId = nextBlockId();
  const sourceLine = token.map ? token.map[0] + 1 : 0;
  const base = defaultListItemOpen
    ? defaultListItemOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
  return base.replace(
    /^<li/,
    `<li data-block-id="${blockId}" data-source-line="${sourceLine}" data-block-type="list"`,
  );
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

  // Derive a slug from the heading text for scroll-sync (T1.1 — uses shared slugify).
  const headingText = nextToken?.children
    ?.map((t) => t.content)
    .join('') ?? '';
  const slug = slugify(headingText);

  return `<${token.tag} id="${slug}" data-block-id="${blockId}" data-source-line="${sourceLine}">`;
};

// ---------------------------------------------------------------------------
// Callout core rule (T1.3)
//
// Walks the core token stream after block parsing. For every blockquote_open
// whose immediately following inline token's first line matches the callout
// marker syntax `/^\[!([\w-]+)\]([+-]?)\s*(.*)/`, we:
//   1. Rewrite blockquote_open → callout_open   (in place, no array splicing)
//   2. Rewrite blockquote_close → callout_close (matched by nesting depth)
//   3. Strip the [!type] marker from the first line of the body inline token
//
// The existing `blockquote_open` renderer rule never fires for these tokens
// because the renderer dispatches on token.type (TRAP 10 / B-2).
//
// Family mapping (B-1 — reuses --warn* tokens, no new --warning* triplet):
//   info    → accent
//   tip     → accent
//   success → success
//   check   → success
//   done    → success
//   warning → warn
//   caution → warn
//   attention → warn
//   danger  → danger
//   error   → danger
//   failure → danger
//   bug     → danger
//   example → neutral
//   quote   → neutral
//   note    → accent    (Obsidian default)
//   abstract → accent
//   summary → accent
//   *       → neutral   (unknown types)
// ---------------------------------------------------------------------------

const CALLOUT_FAMILY: Record<string, string> = {
  note: 'accent', abstract: 'accent', summary: 'accent', tldr: 'accent',
  info: 'accent', tip: 'accent', hint: 'accent',
  success: 'success', check: 'success', done: 'success',
  warning: 'warn', caution: 'warn', attention: 'warn',
  danger: 'danger', error: 'danger', failure: 'danger', fail: 'danger', bug: 'danger',
  example: 'neutral', quote: 'neutral', cite: 'neutral',
};

// Simple SVG icons per family (inline, no external deps).
const CALLOUT_ICONS: Record<string, string> = {
  accent:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>',
  success: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>',
  warn:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
  danger:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>',
  neutral: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
};

// Regex to detect the callout marker at the start of a blockquote inline.
const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)\s*(.*)/s;

md.core.ruler.push('callout', function calloutRule(state) {
  const tokens = state.tokens;
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type !== 'blockquote_open') { i++; continue; }

    // Find the first inline token inside this blockquote.
    // It will be at i+1 (bullet_list nesting doesn't appear here — blockquote
    // content is wrapped: blockquote_open, paragraph_open, inline, paragraph_close, …)
    // Search forward until we find an inline token or a closing token.
    let inlineIdx = -1;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === 'blockquote_close') break;
      if (t.type === 'inline') { inlineIdx = j; break; }
    }
    if (inlineIdx < 0) { i++; continue; }

    const inlineTok = tokens[inlineIdx];
    const firstLine = inlineTok.content.split('\n')[0];
    const m = CALLOUT_RE.exec(firstLine);
    if (!m) { i++; continue; }

    // We have a callout. Extract components.
    const rawType = m[1].toLowerCase();
    const collapsible = m[2] as '' | '+' | '-'; // '+' open, '-' closed, '' static
    const titleText = m[3].trim() || (rawType.charAt(0).toUpperCase() + rawType.slice(1));
    const family = CALLOUT_FAMILY[rawType] ?? 'neutral';

    // Block metadata (same as blockquote_open renderer would have produced).
    const blockId = nextBlockId();
    const sourceLine = tok.map ? tok.map[0] + 1 : 0;

    // Rewrite blockquote_open → callout_open IN PLACE (no array splice — TRAP 10).
    tok.type = 'callout_open';
    tok.tag = collapsible ? 'details' : 'div';
    // Stash render data on token.meta (safe: not used by standard renderer).
    tok.meta = { rawType, family, collapsible, titleText, blockId, sourceLine };

    // Strip the [!type]… marker line from the inline body.
    // If the inline content has more lines, keep everything after the first '\n'.
    const rest = inlineTok.content.indexOf('\n');
    inlineTok.content = rest >= 0 ? inlineTok.content.slice(rest + 1) : '';
    // Also patch children to remove the marker tokens (the first softbreak +
    // preceding text token). We rebuild the children array minus the first text
    // token (which contained "[!type] Title") and the following softbreak (if any).
    if (inlineTok.children && inlineTok.children.length > 0) {
      // The first child is the raw "[!type] Title..." text_token.
      // Remove it and any immediately following softbreak.
      let cutTo = 1;
      if (inlineTok.children[1]?.type === 'softbreak') cutTo = 2;
      inlineTok.children = inlineTok.children.slice(cutTo);
    }

    // Find matching blockquote_close at the same nesting depth.
    let depth = 1;
    for (let j = i + 1; j < tokens.length; j++) {
      if (tokens[j].type === 'blockquote_open') depth++;
      if (tokens[j].type === 'blockquote_close') {
        depth--;
        if (depth === 0) {
          tokens[j].type = 'callout_close';
          tokens[j].tag = collapsible ? 'details' : 'div';
          tokens[j].meta = { collapsible };
          break;
        }
      }
    }

    i++; // move past the (now rewritten) callout_open
  }
});

// Renderer for callout_open: emits the outer container + title bar + body opener.
md.renderer.rules.callout_open = function (tokens, idx) {
  const token = tokens[idx];
  const { rawType, family, collapsible, titleText, blockId, sourceLine } = token.meta as {
    rawType: string; family: string; collapsible: '' | '+' | '-';
    titleText: string; blockId: string; sourceLine: number;
  };
  const icon = CALLOUT_ICONS[family] ?? CALLOUT_ICONS['neutral'];
  const dataAttrs = `data-callout="${escapeHtml(rawType)}" data-block-id="${escapeHtml(blockId)}" data-source-line="${sourceLine}" data-block-type="callout"`;

  if (collapsible) {
    const openAttr = collapsible === '+' ? ' open' : '';
    return (
      `<details class="callout callout-${family}" ${dataAttrs}${openAttr}>\n` +
      `<summary class="callout-title">${icon}${escapeHtml(titleText)}</summary>\n` +
      `<div class="callout-body">`
    );
  }
  return (
    `<div class="callout callout-${family}" ${dataAttrs}>\n` +
    `<div class="callout-title">${icon}${escapeHtml(titleText)}</div>\n` +
    `<div class="callout-body">`
  );
};

// Renderer for callout_close: closes body div + outer container.
md.renderer.rules.callout_close = function (tokens, idx) {
  const token = tokens[idx];
  const { collapsible } = token.meta as { collapsible: '' | '+' | '-' };
  if (collapsible) {
    return `</div></details>\n`;
  }
  return `</div></div>\n`;
};

// ---------------------------------------------------------------------------
// Wikilink inline rule (T1.4)
//
// Registered after the 'link' rule so standard [...](url) links are parsed first.
// Handles:
//   [[#Heading]]         → <a href="#slug" class="wikilink wikilink-anchor">Heading</a>
//   [[#Heading|Alias]]   → <a href="#slug" class="wikilink wikilink-anchor">Alias</a>
//   [[Page]]             → <span class="wikilink wikilink-unresolved" title="Page">Page</span>
//   [[Page|Alias]]       → <span … title="Page">Alias</span>
//   [[Page#Heading]]     → same inert span (cross-file anchor — not resolved)
//   ![[Page]]            → inert span (TRAP 9 — transclusion; never raw text)
//
// Respects markdown-it escaping: \[[ leaves [[ as literal text because the
// escape rule runs before 'link' and before this rule.
//
// Known v1 limits (B-8): Unicode heading text is slugged with character
// stripping (same as heading_open), and duplicate headings produce the same slug.
// ---------------------------------------------------------------------------

md.inline.ruler.after('link', 'wikilink', function wikilinkRule(state, silent) {
  const src = state.src;
  const pos = state.pos;
  const max = state.posMax;

  // Consume optional leading '!' for embed syntax (![[…]]).
  let offset = 0;
  const isEmbed = src.charCodeAt(pos) === 0x21 /* ! */;
  if (isEmbed) offset = 1;

  // Must start with '[['.
  if (src.charCodeAt(pos + offset) !== 0x5B /* [ */ ||
      src.charCodeAt(pos + offset + 1) !== 0x5B /* [ */) {
    return false;
  }

  // Find the closing ']]'.
  const openBracket = pos + offset + 2;
  let closeIdx = -1;
  for (let i = openBracket; i < max - 1; i++) {
    if (src.charCodeAt(i) === 0x5D /* ] */ && src.charCodeAt(i + 1) === 0x5D /* ] */) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) return false;

  const inner = src.slice(openBracket, closeIdx);
  if (!inner) return false;

  if (!silent) {
    // Parse "target#heading|alias" inside [[ … ]]
    let target = inner;
    let heading = '';
    let alias = '';

    // Split on '|' for alias first.
    const pipeIdx = inner.indexOf('|');
    if (pipeIdx >= 0) {
      alias = inner.slice(pipeIdx + 1).trim();
      target = inner.slice(0, pipeIdx).trim();
    }

    // Split target on '#' for heading anchor.
    const hashIdx = target.indexOf('#');
    if (hashIdx >= 0) {
      heading = target.slice(hashIdx + 1).trim();
      target = target.slice(0, hashIdx).trim();
    }

    const isInDocAnchor = !isEmbed && target === '' && heading !== '';

    const tokenContent = alias || heading || target || inner;

    if (isInDocAnchor) {
      // [[#Heading]] or [[#Heading|Alias]] → real anchor using shared slugify.
      const href = '#' + slugify(heading);
      const tok = state.push('html_inline', '', 0);
      tok.content = `<a href="${escapeHtml(href)}" class="wikilink wikilink-anchor">${escapeHtml(tokenContent)}</a>`;
    } else {
      // Cross-file / embed / path wikilinks → inert unresolved span (TRAP 9).
      const titleTarget = target || heading || inner;
      const tok = state.push('html_inline', '', 0);
      tok.content = `<span class="wikilink wikilink-unresolved" title="${escapeHtml(titleTarget)}">${escapeHtml(tokenContent)}</span>`;
    }
  }

  // Advance parser past '![[…]]' or '[[…]]'.
  state.pos = closeIdx + 2;
  return true;
});

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
// Highlighted code is a pure function of (lang, code) — cache it so re-rendering
// the preview while typing elsewhere doesn't re-highlight unchanged blocks (#2).
const hljsCache = new Map<string, string>();
const HLJS_CACHE_MAX = 256;

export async function renderCodeBlock(code: string, lang: string): Promise<string> {
  const key = `${lang} ${code}`;
  const cached = hljsCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const hljs = await loadHljs();
    const validLang = hljs.getLanguage(lang) ? lang : 'plaintext';
    const result = hljs.highlight(code, { language: validLang });
    const highlighted = `<pre><code class="hljs language-${validLang}">${result.value}</code></pre>`;
    const sanitized = DOMPurify.sanitize(highlighted, PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
    if (hljsCache.size >= HLJS_CACHE_MAX) hljsCache.clear(); // simple bound
    hljsCache.set(key, sanitized);
    return sanitized;
  } catch {
    // Per-block error isolation: return plain code block, don't crash (not cached).
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Async render a Mermaid diagram, returning a sanitized SVG string.
 * If Mermaid fails (invalid diagram, CSP, etc.), returns an error block
 * so the surrounding preview continues rendering (per-block error isolation).
 */
// One cache entry per Mermaid block (keyed by blockId → its last code+theme+svg).
// Re-rendering the preview while typing elsewhere returns the cached SVG instead
// of re-running mermaid.render for an unchanged diagram (#2). Keyed by blockId so
// cached SVGs keep their own element ids — no cross-block id collisions. Theme is
// part of the entry so a light/dark switch correctly invalidates.
const mermaidCache = new Map<string, { code: string; theme: string; svg: string }>();

export async function renderMermaid(code: string, blockId: string): Promise<string> {
  try {
    const mermaid = await loadMermaid();
    const theme = _mermaidTheme ?? 'default';
    const hit = mermaidCache.get(blockId);
    if (hit && hit.code === code && hit.theme === theme) return hit.svg;
    const id = `mermaid-${blockId}`;
    const { svg } = await mermaid.render(id, code);
    // Sanitize with the Mermaid-scoped config so the embedded <style> theming
    // survives (C15 — Mermaid SVG is still sanitized; strict mode is on).
    const sanitized = DOMPurify.sanitize(svg, MERMAID_PURIFY_CONFIG as unknown as DOMPurifyConfig) as unknown as string;
    mermaidCache.set(blockId, { code, theme, svg: sanitized });
    return sanitized;
  } catch (err) {
    const msg = err instanceof Error ? escapeHtml(err.message) : 'Diagram error';
    return `<div class="mermaid-error" data-block-id="${blockId}"><strong>Diagram error:</strong> ${msg}</div>`;
  }
}

/**
 * Render a Mermaid diagram with an **explicit** theme for the export pipeline.
 *
 * Used by documentExport.ts so the export always renders in light mode without
 * mutating `document.documentElement data-theme`, which would trigger
 * PreviewPane's MutationObserver and corrupt the live preview cache.
 *
 * NOTE: This function shares the module-level Mermaid singleton (`_mermaidPromise`,
 * `_mermaidTheme`). It calls `mermaid.initialize()` and updates `_mermaidTheme`
 * when the requested theme differs from the current one. This means an export that
 * interleaves with a live re-render could momentarily cause the wrong theme to be
 * used for that render (low practical risk since exports are discrete user actions,
 * but worth being aware of). A future improvement would be to thread the theme
 * through render options rather than via the global, but Mermaid v11 does not
 * expose a per-call theme override.
 *
 * The result is NOT stored in `mermaidCache` because export renders use a
 * different theme than the live preview and must not overwrite cached SVGs.
 */
export async function renderMermaidForExport(
  code: string,
  blockId: string,
  theme: 'default' | 'dark' = 'default',
): Promise<string> {
  try {
    if (!_mermaidPromise) {
      _mermaidPromise = (async () => (await import('mermaid')).default)();
    }
    const mermaid = await _mermaidPromise;

    // Re-initialize only if the requested theme differs from the current one.
    // This mutates the shared _mermaidTheme singleton (see note in jsdoc above).
    if (theme !== _mermaidTheme) {
      const themeVariables = theme === 'dark'
        ? {
            darkMode: true,
            background: '#1C1D20',
            mainBkg: '#2b2f37',
            nodeBorder: '#7FA6CC',
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

    // Use an export-specific element id so it does not collide with live-preview ids.
    const id = `mermaid-export-${blockId}`;
    const { svg } = await mermaid.render(id, code);
    const sanitized = DOMPurify.sanitize(
      svg,
      MERMAID_PURIFY_CONFIG as unknown as DOMPurifyConfig,
    ) as unknown as string;
    // Intentionally NOT stored in mermaidCache — export renders must not
    // overwrite live-preview cached SVGs.
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
