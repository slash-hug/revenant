/**
 * documentExport.ts — self-contained HTML bundle builder.
 *
 * buildExportDocument(content, opts) → Promise<string>
 *
 * Produces a complete <!doctype html> document that is visually identical to
 * the in-app light-mode preview: same fonts (Geist · Literata · JetBrains Mono),
 * prose styling, hljs code highlighting, tables, and Mermaid diagrams. An
 * optional appended comments layer (C4) adds numbered endnotes.
 *
 * Architecture:
 *   renderMarkdown(content) → DOMParser → hydrate Mermaid (forced light) + code
 *   → inline markdown.css?raw + light :root tokens → @font-face base64 (via ?url+fetch)
 *   → @media print → full <!doctype html> string.
 *
 * The exporter never instantiates its own markdown-it instance; it always
 * calls renderMarkdown() from render/markdown.ts to ensure smart quotes,
 * footnotes, and block-ids match the live preview.
 *
 * Agent-agnostic: no "Claude", "Copilot", or any AI assistant name appears in
 * generated output or comments-layer labels.
 */

// Vite `?raw` import inlines the CSS text at build time.
// In Vitest, these are mocked (or passed through via vite-svg-loader / vitest inlining).
import markdownCssRaw from './styles/markdown.css?raw';

// Vite `?url` imports return the asset's public URL; we fetch→base64 at runtime.
// Only the latin-only weights actually used by the prose stack are embedded:
//   Geist (UI):          wght variable, normal only
//   Literata (prose):    400-normal, 400-italic, 500-normal, 600-normal
//   JetBrains Mono (code): 400-normal, 500-normal, 600-normal, 700-normal
import geistUrl from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import literata400Url from '@fontsource/literata/files/literata-latin-400-normal.woff2?url';
import literata400IUrl from '@fontsource/literata/files/literata-latin-400-italic.woff2?url';
import literata500Url from '@fontsource/literata/files/literata-latin-500-normal.woff2?url';
import literata600Url from '@fontsource/literata/files/literata-latin-600-normal.woff2?url';
import jbMono400Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import jbMono500Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url';
import jbMono600Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';
import jbMono700Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2?url';

import {
  renderMarkdown,
  renderCodeBlock,
  renderMermaidForExport,
  stripFrontmatter,
} from './render/markdown';
import type { Annotation } from './types/ipc';
// findSpan is a PURE string matcher (whitespace- and markdown-tolerant); it touches
// no live DOM / CSS.highlights, so it is safe to reuse here for the comments layer.
import { findSpan } from './annotationHighlight';
import { escapeHtml } from './util/html';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExportOpts {
  /** Raw markdown source string. */
  content: string;
  /**
   * Absolute filesystem path of the source document.
   * Required when includeComments or images are present — used to resolve
   * relative image paths and as the sidecar reference. May be empty string
   * when testing without a real file path.
   */
  docPath?: string;
  /** When true, append an endnote comments section (C4). */
  includeComments?: boolean;
  /** Annotation list from the sidecar. Only used when includeComments=true. */
  annotations?: Annotation[];
  /** General notes string from the sidecar. */
  generalNotes?: string;
  /**
   * Callback to read local file bytes as a base64 string.
   * Signature matches the `readFileBytes` IPC wrapper (WS-A, A7).
   * Must return a base64-encoded string (no data-URI prefix).
   * On failure (path outside dir, unreadable) should throw — the caller
   * handles the error by falling back to the original `src` attribute.
   */
  readFileBytes?: (docPath: string, imagePath: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Light-mode CSS token values
//
// These are the semantic CSS custom property values for the light (Paper) theme
// from tokens.css. We inline them as a fixed :root block in the export bundle
// so the exported document is always light-mode regardless of system theme.
// ---------------------------------------------------------------------------

const LIGHT_ROOT_CSS = `:root {
  --font-ui: 'Geist Variable', 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-prose: 'Literata', Georgia, 'Times New Roman', serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace;
  --fs-xs: 11px;
  --fs-sm: 12.5px;
  --fs-base: 13.5px;
  --fs-md: 15px;
  --fs-lg: 17px;
  --fs-xl: 21px;
  --ps-base: 16.5px;
  --ps-sm: 14px;
  --ps-h1: 30px;
  --ps-h2: 15px;
  --ps-quote: 16px;
  --fw-regular: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;
  --lh-tight: 1.18;
  --lh-snug: 1.4;
  --lh-normal: 1.6;
  --lh-relaxed: 1.8;
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px; --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px; --sp-10: 40px; --sp-12: 48px;
  --r-xs: 4px; --r-sm: 6px; --r-md: 8px; --r-lg: 11px; --r-xl: 14px; --r-pill: 999px;
  --ease-out: cubic-bezier(.22,.78,.28,1);
  --ease-in-out: cubic-bezier(.5,.05,.3,1);
  --dur-fast: 120ms;
  --dur-base: 180ms;
  --dur-slow: 280ms;
  --z-sticky: 10;
  --z-pop: 30;
  --z-scrim: 60;
  --z-modal: 61;
  --z-toast: 70;
  --bg: #EAE7E1;
  --toolbar: #F4F1EB;
  --tab-strip: #EAE7E1;
  --editor-bg: #FAF8F4;
  --preview-bg: #FCFBF7;
  --drawer-bg: #F2EFE9;
  --surface: #FFFFFF;
  --surface-2: #F1EEE7;
  --text: #221F1A;
  --text-muted: #67625A;
  --text-faint: #6E675D;
  --text-on-accent: #FFFFFF;
  --border: #E1DCD1;
  --border-strong: #D2CBBC;
  --focus-ring: rgba(61,109,160,.55);
  --accent: #3D6DA0;
  --accent-hover: #345F8D;
  --accent-press: #2C527B;
  --accent-soft: #E5ECF4;
  --accent-text: #355F90;
  --success: #3F7A5E;
  --success-soft: #E0EDE4;
  --success-text: #356B51;
  --detached: #6B4E9E;
  --detached-soft: #ECE5F5;
  --detached-text: #5E4490;
  --danger: #B4453A;
  --danger-soft: #F4E2DF;
  --danger-text: #A33E34;
  --warn: #9A6B1F;
  --warn-soft: #F4E9D6;
  --warn-text: #875E1B;
  --code-bg: #F1EEE7;
  --sel-bg: #E5ECF4;
  --shadow-sm: 0 1px 2px rgba(40,35,25,.08);
  --shadow-md: 0 4px 14px -4px rgba(40,35,25,.16);
  --shadow-lg: 0 16px 40px -12px rgba(40,35,25,.24);
  --shadow-pop: 0 8px 24px -6px rgba(40,35,25,.30);
  --accent-shadow: 0 2px 8px -2px rgba(61,109,160,.35);
  --ann-underline: #3C8893;
}`;

// ---------------------------------------------------------------------------
// @font-face declarations (hand-written; ?url+fetch fills in the base64 at runtime)
// ---------------------------------------------------------------------------

/** Font descriptor used to build @font-face blocks. */
interface FontDesc {
  family: string;
  weight: string;
  style: string;
  url: string;
}

const FONT_DESCS: FontDesc[] = [
  { family: 'Geist Variable', weight: '100 900', style: 'normal', url: geistUrl },
  { family: 'Literata',        weight: '400',     style: 'normal', url: literata400Url },
  { family: 'Literata',        weight: '400',     style: 'italic', url: literata400IUrl },
  { family: 'Literata',        weight: '500',     style: 'normal', url: literata500Url },
  { family: 'Literata',        weight: '600',     style: 'normal', url: literata600Url },
  { family: 'JetBrains Mono', weight: '400',     style: 'normal', url: jbMono400Url },
  { family: 'JetBrains Mono', weight: '500',     style: 'normal', url: jbMono500Url },
  { family: 'JetBrains Mono', weight: '600',     style: 'normal', url: jbMono600Url },
  { family: 'JetBrains Mono', weight: '700',     style: 'normal', url: jbMono700Url },
];

async function urlToBase64(url: string): Promise<string> {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  // Convert ArrayBuffer to base64 — works in both browsers and jsdom (TextDecoder is available)
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function buildFontFaceCSS(): Promise<string> {
  const blocks = await Promise.all(
    FONT_DESCS.map(async (desc) => {
      try {
        const b64 = await urlToBase64(desc.url);
        return `@font-face {
  font-family: '${desc.family}';
  font-weight: ${desc.weight};
  font-style: ${desc.style};
  font-display: swap;
  src: url('data:font/woff2;base64,${b64}') format('woff2');
}`;
      } catch {
        // Font load failure is non-fatal: the browser falls back to system fonts.
        return '';
      }
    }),
  );
  return blocks.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Print styles
// ---------------------------------------------------------------------------

const PRINT_CSS = `@media print {
  @page { size: Letter; margin: 0.6in; }
  .prose { max-width: none; padding: 0; }
  pre, blockquote, table, figure { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  .export-comments { break-before: page; }
}`;

// ---------------------------------------------------------------------------
// Export-specific frontmatter header CSS
// (not .pv-* — these classes only appear in the export bundle)
// ---------------------------------------------------------------------------

const FRONTMATTER_HEADER_CSS = `.export-header {
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.export-title {
  font-family: var(--font-prose);
  font-size: var(--ps-h1);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-tight);
  letter-spacing: -.012em;
  margin: 0 0 12px;
  color: var(--text);
  text-wrap: balance;
}
.export-meta {
  font-family: var(--font-ui);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.export-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}`;

// ---------------------------------------------------------------------------
// Comments layer CSS
// ---------------------------------------------------------------------------

const COMMENTS_CSS = `.export-comments {
  margin-top: 48px;
  padding-top: 24px;
  border-top: 2px solid var(--border-strong);
  font-family: var(--font-ui);
  font-size: var(--fs-base);
  color: var(--text);
}
.export-comments h2 {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  margin: 0 0 20px;
  color: var(--text);
}
.export-comments ol {
  margin: 0;
  padding-left: 22px;
}
.export-comments li {
  margin-bottom: 20px;
  line-height: var(--lh-normal);
}
.export-comments .comment-quote {
  font-family: var(--font-prose);
  font-size: var(--ps-sm);
  color: var(--text-muted);
  font-style: italic;
  margin: 4px 0;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
}
.export-comments .comment-body {
  margin: 6px 0 0;
}
.export-comments .detached-list {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.export-comments .detached-list h3 {
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  color: var(--text-muted);
  margin: 0 0 12px;
}
.export-general-notes {
  margin-top: 24px;
  padding: 14px 16px;
  background: var(--surface-2);
  border-radius: var(--r-md);
}
.export-general-notes h3 {
  font-size: var(--fs-base);
  font-weight: var(--fw-semibold);
  margin: 0 0 8px;
  color: var(--text);
}
.export-general-notes p {
  font-size: var(--fs-base);
  margin: 0;
  white-space: pre-wrap;
  color: var(--text-muted);
}
mark.ann-mark {
  background: rgba(60, 136, 147, 0.18);
  border-bottom: 2px solid #3C8893;
  padding: 0 1px;
  border-radius: 2px;
  color: inherit;
}
mark.ann-mark sup {
  font-size: 0.7em;
  font-weight: var(--fw-semibold);
  color: #3C8893;
  margin-left: 1px;
}`;

// ---------------------------------------------------------------------------
// Mermaid hydration helper (forces light theme in export context)
// ---------------------------------------------------------------------------

async function hydrateMermaid(doc: Document): Promise<void> {
  const pending = Array.from(
    doc.querySelectorAll<HTMLElement>('[data-mermaid-pending]'),
  );
  if (!pending.length) return;

  // Use renderMermaidForExport with an explicit 'default' (light) theme so we
  // never mutate document.documentElement data-theme. Touching that attribute
  // would trigger PreviewPane's MutationObserver → reRenderMermaidForTheme(),
  // causing a visible flicker and overwriting the live preview's mermaidCache
  // with light-theme SVGs even when the user is in dark mode.
  await Promise.all(
    pending.map(async (el) => {
      const code = el.textContent ?? '';
      // Use an export-namespaced id to avoid colliding with live blockIds in
      // the shared mermaidCache (renderMermaidForExport does not write to it,
      // but the id is also used as the SVG element id by Mermaid itself).
      const blockId = (el.getAttribute('data-block-id') ?? `mermaid-${Math.random()}`) + '-export';
      try {
        const svg = await renderMermaidForExport(code, blockId, 'default');
        el.removeAttribute('data-mermaid-pending');
        el.innerHTML = svg;
      } catch {
        // Per-block isolation: leave as-is on error.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Code block hydration helper
// ---------------------------------------------------------------------------

async function hydrateCode(doc: Document): Promise<void> {
  const blocks = Array.from(
    doc.querySelectorAll<HTMLElement>('pre[data-block-type="code"]'),
  );
  await Promise.all(
    blocks.map(async (pre) => {
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const code = codeEl.textContent ?? '';
      const lang = (codeEl.className.match(/language-(\S+)/) ?? [])[1] ?? '';
      try {
        const highlighted = await renderCodeBlock(code, lang);
        // renderCodeBlock returns a full <pre><code> HTML string; replace the pre node.
        const tmp = doc.createElement('div');
        tmp.innerHTML = highlighted;
        const newPre = tmp.firstElementChild;
        if (newPre) pre.replaceWith(newPre);
      } catch {
        // Per-block isolation.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Frontmatter header builder
// ---------------------------------------------------------------------------

function buildFrontmatterHeader(
  rawFm: string | null,
  docPath: string,
): string {
  if (!rawFm && !docPath) return '';

  // Parse simple YAML frontmatter key: value pairs (no arrays, no nesting).
  const fm: Record<string, string> = {};
  if (rawFm) {
    const lines = rawFm.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '').split('\n');
    for (const line of lines) {
      const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (m) fm[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const title = fm['title'] ?? '';
  const author = fm['author'] ?? '';
  const date = fm['date'] ?? '';

  const metaItems: string[] = [];
  if (author) metaItems.push(`<span class="export-meta-item">By ${escapeHtml(author)}</span>`);
  if (date) metaItems.push(`<span class="export-meta-item">${escapeHtml(date)}</span>`);
  if (docPath) {
    const filename = docPath.split('/').pop() ?? docPath;
    metaItems.push(`<span class="export-meta-item">${escapeHtml(filename)}</span>`);
  }

  if (!title && !metaItems.length) return '';

  return `<header class="export-header">${
    title ? `<h1 class="export-title">${escapeHtml(title)}</h1>` : ''
  }${
    metaItems.length ? `<div class="export-meta">${metaItems.join('<span class="export-meta-item">·</span>')}</div>` : ''
  }</header>`;
}

// ---------------------------------------------------------------------------
// Local image embedding
// ---------------------------------------------------------------------------

async function embedLocalImages(
  doc: Document,
  docPath: string,
  readFileBytes: (docPath: string, imagePath: string) => Promise<string>,
): Promise<void> {
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? '';
      // Skip http(s) URLs — embed only relative paths.
      if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return;

      // Infer the embedded MIME from the file extension, restricted to known
      // RASTER types only. We deliberately never emit `image/svg+xml`: an SVG
      // data URI is active content (it can carry <script>, foreignObject, event
      // handlers) and would become a live injection surface inside the export
      // (issue #56). For `.svg` or any unrecognized extension we skip embedding
      // and degrade to alt text rather than inlining untrusted active content.
      const ext = src.split('.').pop()?.toLowerCase() ?? '';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : ext === 'png' ? 'image/png'
        : null;

      if (mime === null) {
        // Unknown or SVG (active-content) type — do not embed as a data URI.
        console.warn(
          `[documentExport] Refusing to embed "${src}" as a data URI: ` +
          `only PNG/JPEG/GIF/WebP raster images are embedded (SVG/unknown types are skipped for safety).`,
        );
        const alt = img.getAttribute('alt') ?? '';
        img.removeAttribute('src');
        if (alt) {
          const span = doc.createElement('span');
          span.textContent = `[Image: ${alt}]`;
          img.replaceWith(span);
        } else {
          img.remove();
        }
        return;
      }

      try {
        const b64 = await readFileBytes(docPath, src);
        img.setAttribute('src', `data:${mime};base64,${b64}`);
      } catch {
        // Failure: degrade to alt text by removing the src so the alt is shown.
        const alt = img.getAttribute('alt') ?? '';
        img.removeAttribute('src');
        if (alt) {
          const span = doc.createElement('span');
          span.textContent = `[Image: ${alt}]`;
          img.replaceWith(span);
        } else {
          img.remove();
        }
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Comments layer (C4)
// ---------------------------------------------------------------------------

/**
 * Locate an annotation's `quoted_text` in the rendered document and return a DOM
 * Range covering it, or null.
 *
 * Two failure modes of a naive per-node `indexOf` are handled:
 *  - **whitespace:** `quoted_text` comes from `selection.toString()`, which
 *    collapses soft line-breaks to spaces, while the rendered text node keeps
 *    literal `\n`. `findSpan` normalizes whitespace on both sides.
 *  - **inline formatting:** a span crossing a `**bold**`/`*em*` word lives in
 *    multiple text nodes. We search a single concatenation of all text nodes and
 *    map the match offsets back to (node, offset), so the Range can cross nodes.
 */
function findAnchorRange(doc: Document, ann: Annotation): Range | null {
  const target = ann.quoted_text;
  if (!target) return null;

  // Concatenate text nodes, recording where each starts in the combined string.
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  let combined = '';
  const segments: Array<{ node: Text; start: number }> = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    segments.push({ node: n, start: combined.length });
    combined += n.textContent ?? '';
  }
  if (combined.length === 0 || segments.length === 0) return null;

  const span = findSpan(combined, target); // whitespace/markdown-tolerant; null if absent
  if (!span) return null;

  // Map a combined-string offset → (text node, local offset). `to` is exclusive.
  const locate = (pos: number): { node: Text; offset: number } => {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (pos >= segments[i].start) {
        return { node: segments[i].node, offset: Math.min(pos - segments[i].start, segments[i].node.length) };
      }
    }
    return { node: segments[0].node, offset: 0 };
  };
  const start = locate(span.from);
  const end = locate(span.to);

  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/**
 * Insert in-text annotation marks and append an endnotes section.
 * Modifies `doc` in place.
 */
function insertCommentsLayer(
  doc: Document,
  annotations: Annotation[],
  generalNotes: string,
): void {
  const anchored = annotations.filter((a) => a.status === 'anchored' || a.status === 'block_level');
  const detached = annotations.filter((a) => a.status === 'detached');
  const hasContent =
    anchored.length > 0 || detached.length > 0 || (generalNotes?.trim().length ?? 0) > 0;
  if (!hasContent) return;

  // Number anchored annotations in document order via findAnchorSpan.
  let markNumber = 0;
  const endnotes: Array<{ n: number; ann: Annotation; found: boolean }> = [];

  for (const ann of anchored) {
    markNumber++;
    const range = findAnchorRange(doc, ann);
    if (range) {
      const mark = doc.createElement('mark');
      mark.className = 'ann-mark';
      // extractContents pulls the (possibly multi-node) range contents into the
      // mark, splitting inline-formatting elements at the boundaries if needed —
      // formatting is preserved, the span is wrapped intact.
      mark.appendChild(range.extractContents());

      const sup = doc.createElement('sup');
      sup.textContent = String(markNumber);
      mark.appendChild(sup);

      range.insertNode(mark);
      endnotes.push({ n: markNumber, ann, found: true });
    } else {
      endnotes.push({ n: markNumber, ann, found: false });
    }
  }

  // Build the endnotes section HTML.
  const sectionParts: string[] = [];
  sectionParts.push('<section class="export-comments">');
  sectionParts.push('<h2>Annotations</h2>');

  if (endnotes.length > 0) {
    sectionParts.push('<ol>');
    for (const { n, ann } of endnotes) {
      const quote = ann.quoted_text
        ? `<p class="comment-quote">${escapeHtml(ann.quoted_text)}</p>`
        : '';
      sectionParts.push(
        `<li id="ann-note-${n}"><strong>${n}.</strong>${quote}<p class="comment-body">${escapeHtml(ann.body)}</p></li>`,
      );
    }
    sectionParts.push('</ol>');
  }

  if (detached.length > 0) {
    sectionParts.push('<div class="detached-list">');
    sectionParts.push('<h3>Unanchored annotations</h3>');
    sectionParts.push('<ul>');
    for (const ann of detached) {
      const quote = ann.quoted_text
        ? `<p class="comment-quote">${escapeHtml(ann.quoted_text)}</p>`
        : '';
      sectionParts.push(
        `<li>${quote}<p class="comment-body">${escapeHtml(ann.body)}</p></li>`,
      );
    }
    sectionParts.push('</ul>');
    sectionParts.push('</div>');
  }

  if (generalNotes?.trim()) {
    sectionParts.push('<div class="export-general-notes">');
    sectionParts.push('<h3>General notes</h3>');
    sectionParts.push(`<p>${escapeHtml(generalNotes.trim())}</p>`);
    sectionParts.push('</div>');
  }

  sectionParts.push('</section>');

  const container = doc.createElement('div');
  container.innerHTML = sectionParts.join('');
  const section = container.firstElementChild!;
  doc.body.appendChild(section);
}

// ---------------------------------------------------------------------------
// Main export builder
// ---------------------------------------------------------------------------

/**
 * Build a complete, self-contained HTML export document from markdown source.
 *
 * @param opts.content         Raw markdown source.
 * @param opts.docPath         Absolute path of the source file (for relative image resolution).
 * @param opts.includeComments When true, appends the comments endnote layer (C4).
 * @param opts.annotations     Annotation list (used when includeComments=true).
 * @param opts.generalNotes    General notes string (used when includeComments=true).
 * @param opts.readFileBytes   IPC callback for local image bytes (from WS-A read_file_bytes).
 * @returns Promise resolving to a full <!doctype html> string.
 */
export async function buildExportDocument(opts: ExportOpts): Promise<string> {
  const {
    content,
    docPath = '',
    includeComments = false,
    annotations = [],
    generalNotes = '',
    readFileBytes,
  } = opts;

  // 1. Render markdown to HTML.
  const { raw: frontmatterRaw } = stripFrontmatter(content);
  const html = renderMarkdown(content);

  // 2. Parse into a live DOM for hydration.
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<!doctype html><html><body>${html}</body></html>`,
    'text/html',
  );

  // 3. Hydrate Mermaid diagrams (forced light theme) and code blocks.
  await hydrateMermaid(doc);
  await hydrateCode(doc);

  // 4. Embed local images (C3).
  if (readFileBytes && docPath) {
    await embedLocalImages(doc, docPath, readFileBytes);
  }

  // 5. Insert comments layer (C4).
  if (includeComments) {
    insertCommentsLayer(doc, annotations, generalNotes);
  }

  // 6. Serialize the hydrated body HTML.
  const bodyHtml = doc.body.innerHTML;

  // 7. Build font @font-face CSS.
  const fontFaceCSS = await buildFontFaceCSS();

  // 8. Build frontmatter header (C3).
  const headerHtml = buildFrontmatterHeader(frontmatterRaw, docPath);

  // 9. Assemble the full document.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Export</title>
<style>
${LIGHT_ROOT_CSS}
${fontFaceCSS}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--preview-bg); color: var(--text); font-family: var(--font-ui); font-size: var(--fs-base); line-height: var(--lh-normal); }
${markdownCssRaw}
${FRONTMATTER_HEADER_CSS}
${COMMENTS_CSS}
${PRINT_CSS}
</style>
</head>
<body>
<article class="prose">
<div class="preview-content">
${headerHtml}
${bodyHtml}
</div>
</article>
</body>
</html>`;
}
