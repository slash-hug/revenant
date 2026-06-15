# Revenant — High-fidelity PDF & HTML export (#6)

**Status:** Approved design (pending spec review)
**Date:** 2026-06-15
**Issue:** #6

## Goal

Export the rendered markdown document as a **PDF** and a **standalone HTML** file
that look **identical to the in-app preview** (light mode). The explicit bar: not
the degraded output typical of markdown apps. Same fonts (Geist · Literata ·
JetBrains Mono), prose styling, code highlighting, tables, and Mermaid diagrams.

## Locked decisions

| Decision | Choice |
|---|---|
| PDF generation | **Silent one-click via the native webview PDF API** — `WKWebView.createPDF` (macOS) / `WebView2.PrintToPdfAsync` (Windows). Same rendering engine as the preview ⇒ identical fidelity. |
| Scope | **Rendered document by default**, with an **optional comments layer** (toggle). |
| Comments rendering | **Appended endnotes** (numbered), not margin notes — bulletproof across page breaks. |
| Trigger UX | A small **Export dialog** (native `<dialog>`): format (PDF/HTML) + "Include comments". |
| CSS fidelity | **Extract the markdown/prose CSS into a shared `markdown.css`** — single source of truth for preview *and* export (drift-proofing). |
| Page setup (PDF) | US **Letter**, **0.6in** margins, `break-inside: avoid` on code/headings/tables/Mermaid. A4 deferred. |

## Architecture: one static bundle → two outputs

Both outputs derive from a single **fully self-contained, static HTML document**
(zero JS required to display). This is the heart of the fidelity guarantee.

```
documentExport.ts  (frontend)
  build(content, annotations?, opts) → string  (complete <html> document)
        │
        ├─ renderMarkdown(content)        // exact preview pipeline → sanitized HTML
        ├─ hydrate: Mermaid → inline <svg>, code → hljs-highlighted (reuse markdown.ts)
        ├─ optional comments layer (DOMParser): mark anchored spans + appended endnotes
        ├─ inline <style>: markdown.css + light-mode :root tokens (tokens.css)
        └─ inline @font-face: base64 woff2 (Geist / Literata / JetBrains Mono)

  HTML export → write the string to the chosen path  (one portable file)
  PDF  export → load the string in a hidden webview → native createPDF/PrintToPdf → bytes
```

### Why a shared bundle
The exact same HTML string that opens flawlessly as a standalone `.html` is what
the hidden webview rasterizes to PDF. There is no second rendering path to drift.

## Components

### 1. `src/lib/styles/markdown.css` (new — the refactor)
Move the markdown/prose styling out of `PreviewPane.svelte`'s scoped `<style>`:
`.prose` / `.preview-content` and every rendered-element rule (h1–h6, p, lists,
blockquote, tables, `pre`/`code`, hljs token colors, `img`, `hr`, frontmatter
header, the `--ps-*` prose-size tokens). Plain CSS keyed on the same class names
the preview already uses.
- **Preview** imports it for live styling (the content is `{@html}`, so these
  rules are already effectively global; `markdown.css` makes that explicit).
- **Exporter** imports the raw text via Vite `?raw` (`import css from '../styles/markdown.css?raw'`)
  and inlines it. Single source of truth — preview and export cannot diverge.
- Annotation **seal/wash** styles stay in `AnnotationSeals.svelte` (review UI, not
  document content) — out of `markdown.css`.

### 2. `src/lib/documentExport.ts` (new)
Pure-ish builder: `buildExportDocument(content, { includeComments, annotations, generalNotes }) → Promise<string>`.
- Calls `renderMarkdown(content)`; hydrates Mermaid (`renderMermaid`) and code
  (`renderCodeBlock`) into the HTML string via a `DOMParser` pass (mirrors
  `PreviewPane.hydrateDynamicBlocks`, extracted to a shared helper so both stay in sync).
- Inlines: `markdown.css` (raw), the **light-mode `:root` block** from `tokens.css`
  (export is always light — no `data-theme`), and `@font-face` blocks with
  base64 woff2 (Vite `?inline` data-URIs for the used weights).
- Local `![](relative)` images → base64 data-URI (read via a Rust command);
  `http(s)` images left as-is; failures degrade to alt text.
- Returns a complete `<!doctype html>…` document with `@media print { @page { size: Letter; margin: 0.6in } … break-inside: avoid … }`.

### 3. Comments layer (within documentExport)
When `includeComments`: parse the document DOM, and for each **anchored**
annotation resolve its span (reuse `annotationResolve` / `findSpan` logic) and wrap
it in `<mark class="ann-mark">…<sup>N</sup></mark>` (teal `--ann-underline`), N in
document order. Append `<section class="export-comments">` — an ordered list of
`N → quoted_text + body`, plus **general notes**. **Detached** annotations are
listed without an in-text mark. No seals, no wash overlay.

### 4. `src/lib/ExportDialog.svelte` (new)
Native `<dialog>` (focus-trap/Esc, matches ConflictModal/UnsavedChanges): format
radio **PDF / HTML**, **Include comments** checkbox, Export / Cancel. On Export →
`buildExportDocument(...)` → native **save dialog** (`tauri-plugin-dialog` `save`,
default name `<doc>.<ext>`) → call the Rust command → success/fail toast.

### 5. Rust (IPC contract — update `ipc.rs` + `ipc.ts` + `lib.rs`)
- `export_html(out_path, html)` — write the bundle string to the user-chosen path
  (UTF-8). The path comes from the native save dialog (explicit user choice), so no
  vault confinement; validate it's a writable absolute path with an `.html` ext.
- `export_pdf(out_path, html)` — create a **hidden Tauri webview** loading the
  bundle (temp file or `data:` URL), wait for load, then via `with_webview` call
  the platform PDF API (`WKWebView.createPDF` async / `WebView2.PrintToPdfAsync`),
  write the bytes to `out_path`, and **always tear down the webview**. Timeout →
  `PDF_EXPORT_FAILED`.
- `read_file_bytes(path)` — returns the bytes of a **local image** referenced by the
  doc so the exporter can base64-embed it. Confined (via `paths.rs`) to the doc's own
  directory; out-of-dir or unreadable → skipped (degrade to alt text). In v1.

### 6. Trigger surfaces
- Toolbar: an **"Export ▾"** dropdown folding the existing Obsidian export in:
  *Export document (PDF/HTML)…* → ExportDialog; *Export to Obsidian* → existing flow.
  (Replaces today's standalone "Export to Obsidian" button — reduces toolbar density,
  which the design critique flagged.)
- ⌘K palette: *Export as PDF*, *Export as HTML* (open the dialog preset to that
  format), and the existing *Export to Obsidian*.

## Data flow

```
ExportDialog (format, includeComments)
  → buildExportDocument(content, {includeComments, annotations, generalNotes})  // async: mermaid/hljs
  → save dialog → out_path
  → HTML: export_html(out_path, bundle)
  → PDF : export_pdf(out_path, bundle) → hidden webview → native PDF → bytes
  → toast: "Exported <name>.<ext>"  /  error toast on failure
```

## Error handling
- PDF: bounded wait for webview load + native call; on failure emit
  `PDF_EXPORT_FAILED`, toast, and guarantee the hidden webview is destroyed (no leak).
- Empty document → allowed (exports an empty styled page).
- Save dialog cancelled → no-op.
- Font/image embed failure → degrade (system font fallback / alt text), never abort.

## Testing
- `documentExport` unit tests (jsdom/Vitest): output is a complete document; the
  used `@font-face` weights are present as `data:font/woff2;base64`; a ```mermaid```
  block becomes inline `<svg>`; a fenced code block is hljs-highlighted; light
  `:root` tokens are inlined and no `data-theme="dark"` leaks; with `includeComments`
  the anchored spans get numbered `<mark>` + matching endnotes, detached comments
  are listed, general notes appear; no `<script>` in the output.
- Path/extension handling for the Rust write commands (confinement/ext validation).
- The native PDF call (`createPDF`/`PrintToPdfAsync`) is **integration-verified live**
  per platform — not unit-testable.

## Out of scope (v1)
A4 / page-size options, margin-note comment layout, page headers/footers, table of
contents, embedding **remote** images, dark-mode export. Tracked as follow-ups.

## Risks
1. **Native PDF wiring** (`with_webview` → `createPDF`/`PrintToPdfAsync`) is the
   highest-risk piece — platform-specific Rust (objc2/cocoa, webview2-com). Spike it
   first in feature-research.
2. **Hidden-webview lifecycle** — ensure load completes before PDF and the webview
   is always torn down.
3. **Font base64 size** — a few hundred KB per export bundle; acceptable for a
   portable file, but only embed the weights actually used.
4. **markdown.css extraction** must be byte-faithful so the live preview is visually
   unchanged after the refactor (regression-check the preview).
