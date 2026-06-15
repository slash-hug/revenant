# Implementation Plan — High-fidelity PDF & HTML export (#6)

**Source spec:** `docs/superpowers/specs/2026-06-15-revenant-pdf-html-export-design.md` (approved, source of truth for WHAT).
**This document:** validates and enriches the spec against the actual codebase. It does not redesign the approach.
**Status:** DECISIONS RESOLVED (2026-06-15, below) — pending the A0 spike (D1/D2/D3) before `feature-implement`.

### Resolved decisions (human ruling, 2026-06-15)
- **D4 (dropdown style):** native `<dialog>` for ExportDialog and the "Export ▾" trigger menu. ✅
- **D5 (toolbar):** option (c) — **Obsidian export → compact icon button**; new **"Export ▾" dropdown** holds "Export document (PDF/HTML)…". Keeps Obsidian one-click, cuts density. ✅
- **D6 (detached-only comments):** **allow** — detached comments render as endnotes (no in-text marks); checkbox shows "Includes N anchored, M detached"; disabled only when there are zero comments AND no general notes. ✅
- **D1/D2/D3 (native PDF mechanism, font embed):** **A0 spike landed (2026-06-15) — macOS path CONFIRMED.**
  - `objc2-web-kit 0.3.2` (already a dep) exposes `WKWebView::createPDFWithConfiguration_completionHandler(Option<&WKPDFConfiguration>, handler)` (handler returns **`NSData` = PDF bytes**) and `loadHTMLString_baseURL`, behind `feature = "WKPDFConfiguration"` (+ `block2`, already enabled). **Action for A6:** add `"WKPDFConfiguration"` to the `objc2-web-kit` features in `Cargo.toml`.
  - **Mechanism (macOS):** mirror `snapshot.rs` exactly — but on a **separate off-screen `WKWebView`** (created via objc2), `loadHTMLString_baseURL(bundle, nil)`, await load-finish, then `createPDFWithConfiguration(nil → current page bounds)`, write the `NSData`, tear down. Same `RcBlock` + `mpsc` + `spawn_blocking` + timeout shape. **Still to validate live in A6:** off-screen `WKWebView` must produce a **non-blank** render (may need attaching to a 1×1 off-screen `NSWindow` / non-zero frame) and a load-finished signal (navigationDelegate or bounded `isLoading` poll). `loadHTMLString` sidesteps the CSP/`data:`-navigation concern (no top-level `data:` URL).
  - **Windows arm:** `WebView2.PrintToPdfAsync` via a direct `webview2-com` dep — implement + verify live per platform (unchanged from plan).
  - **Fonts:** `import url from '…woff2?url'` (standard Vite) → `fetch(url) → arrayBuffer → base64` at export time; latin-only weights ≈ 196 KB. No new dep.
- **Font subset:** latin-only for v1 (non-latin = follow-up), as planned.

> Correction to a research finding: `findSpan` *does* exist (`annotationHighlight.ts:59`), but the plan's conclusion stands — it returns string offsets, not DOM ranges, so the comments layer still needs a new DOM-aware span-finder (C4).

---

## 1. Header

### Goal
Export the rendered markdown document as a **PDF** and a **standalone HTML** file that look **identical to the in-app preview** (light mode): same fonts (Geist · Literata · JetBrains Mono), prose styling, hljs code highlighting, tables, and Mermaid diagrams. Optional appended-endnote comments layer.

### Approach
One static, fully self-contained HTML bundle string → two outputs. HTML export writes the string; PDF export rasterizes the same string through a native webview PDF API. Single render path = no fidelity drift. This matches the spec's "one bundle → two outputs" model exactly.

### Architecture decisions (each tied to a research finding)

| Decision | Choice | Driven by |
|---|---|---|
| New Rust module home | Create `src-tauri/src/export.rs` for `export_html` / `export_pdf` / `read_file_bytes`. It is **owned by WS-A** (not WS-B/WS-D), because all three commands are gated by `lib.rs` handler registration and the FROZEN `ipc.rs`/`ipc.ts` surface — the same workstream must own the module and its IPC slice to keep them in sync. | [architecture] "ownership gap: a NEW Rust module with NO owner; decide a home module and owner first; only WS-A may edit lib.rs"; [codebase] "IPC contract is FROZEN (WS-A)"; [review-history] "three commands must be added symmetrically to ipc.rs, ipc.ts, lib.rs, ipc_contract.test.ts". |
| IPC contract is the gating slice, delivered first | WS-A delivers `export.rs` + `ipc.rs` + `ipc.ts` + `lib.rs` + `ipc_contract.test.ts` + capability changes **before** WS-B/WS-C build on them. The "FROZEN" label is a process gate, not a prohibition — WS-A added `unwatch_file` and `snapshot_webview` post-freeze. | [architecture] "IPC is extensible despite the FROZEN label: WS-A added unwatch_file and snapshot_webview"; [codebase] RISK "the plan must sequence WS-A first for the new IPC slice". |
| PDF mechanism | **MUST be spiked before WS-A finalizes `export_pdf`'s signature.** `snapshot.rs` proves `with_webview` on the *existing* window only; creating + tearing down a *hidden* webview has zero prior art here. The plan defers the concrete mechanism to the spike (D1) and pins only the IPC signature `export_pdf(out_path, html)`. | [architecture] "snapshot.rs snapshots the EXISTING window, never a hidden one … none exists. Spec Risk 1/2 correctly demand a spike"; [codebase]/[ux]/[review-history] all flag hidden-webview lifecycle as highest risk. |
| macOS PDF API | `WKWebView.createPDF(configuration:completionHandler:)` returning `NSData`, bridged with the same `RcBlock` + `mpsc` + `spawn_blocking` + timeout pattern as `snapshot.rs`. Requires adding the `WKPDFConfiguration` feature to `objc2-web-kit` in `Cargo.toml` — verify it exists in `objc2-web-kit 0.3` during the spike. | [architecture] "createPDF has the identical shape; objc2_web_kit and block2 are already deps"; [review-history] "WKPDFConfiguration … must be exposed in the pinned objc2-web-kit 0.3". |
| Windows PDF API | `WebView2.PrintToPdfAsync` via a **direct** `webview2-com` dependency (currently transitive only). FFI pattern decided in the spike (D1). | [codebase] DECISION REQUIRED "webview2-com is currently only a transitive dependency". |
| Comments layer span-finding | Implement a **new** DOMParser-based span search in `documentExport.ts`. Do NOT call `resolveBlock`/live-DOM range helpers — `resolveBlock` is block-granular and bound to a live mounted preview; `findSpan` does not exist; `annotationHighlight.ts` uses `Range`/`CSS.highlights` tied to the main frame, unavailable on a detached DOMParser document. | [architecture] "Spec cites findSpan, which does not exist; resolveBlock is block-granular/live-DOM-bound. Reuse is overstated"; [review-history] "must implement its own span-finding pass rather than calling the existing DOM range helpers". |
| Mermaid theme in export | Force light/`default` theme explicitly when calling `renderMermaid` in the export context — do not inherit the live app's `data-theme`. | [review-history] "renderMermaid uses a singleton _mermaidTheme that reads document.documentElement … must be forced to 'default' (light)". |
| markdown-it reuse | The exporter MUST call the existing `renderMarkdown` from `render/markdown.ts` — never re-instantiate markdown-it — so smart quotes (`typographer:true`), footnotes, and block-ids match the preview. | [architecture] "markdown-it uses typographer:true + footnote plugin; the exporter must reuse renderMarkdown". |
| Font embedding mechanism | Decided in D3 spike. Fonts ARE local Vite assets (`node_modules/@fontsource*/files/*.woff2`, confirmed present). Embed **latin-only** weights actually used; hand-write `@font-face` blocks pointing at base64 data-URIs. Latin-only total ≈ **196 KB** across all 9 weights (measured) → bundle ≈ a few hundred KB, validating the spec's size claim *only for the latin subset*. | [architecture] "fonts are @fontsource packages whose CSS have many font-face across subsets … the exporter must inline specific subset+weight woff2 files and emit hand-written font-face"; measured latin total 196 KB. |
| CSS extraction scope | `markdown.css` gets ONLY document-content rules (`.prose`, `.preview-content :global(...)` h1–h6/p/lists/blockquote/tables/pre/code/hljs/img/hr, `--ps-*` tokens). UI chrome (`.preview-pane`, `.pv-scroll`, `.banner`, `.add-comment-affordance`, `.pv-header`/`.pv-*` frontmatter chrome) **stays in PreviewPane.svelte**. The exporter renders its own frontmatter header (not the `.pv-*` classes). | [codebase] "the .pv-* styles are preview-only UI chrome … MUST stay"; [ux] "the extraction boundary needs to be precisely defined". |
| Dropdown pattern | **Recommend native `<dialog>`** for ExportDialog (matches ConflictModal/UnsavedChangesModal/CommandPalette). For the "Export ▾" trigger menu, recommend a positioned native `<dialog>` anchored to the button rect via `getBoundingClientRect()` (free ARIA, Esc, focus-trap) — pending D4. | [ux] "Recommend native <dialog> for consistency … positioned to the button rect"; [codebase] "no existing dropdown/popover component exists". |
| Toast system | Export uses the **`Toast` store** (`toast.show(...)`), not App.svelte's local `$state` toast — consolidate on the store path. | [ux] "two toast implementations … WS-C should use the imported toast store"; confirmed App.svelte imports `Toast` AND has a local `showToast`. |
| read_file_bytes confinement | Confine to the doc's **parent directory** (which `starts_with` includes all subdirectories, covering `./images/fig.png`), AND pre-guard with `has_parent_traversal` before `assert_confined` — mirroring `export_obsidian` (ipc.rs L717). | [architecture]/[review-history] "assert_confined is lexical starts_with, fooled by dot-dot … must ALSO call has_parent_traversal". |
| Path validation for export_html/export_pdf | No vault confinement (Save-As is an explicit user choice, like the dialog path), BUT validate: absolute path, correct extension **case-insensitive** (`.html`/`.HTML`, `.pdf`/`.PDF`), and `has_parent_traversal` on any derived component. Fail-open-but-validated. | [architecture] "validate absolute path, correct extension, no traversal"; [ux] "ext check must handle both .html and .HTML on Windows". |
| Save dialog capability | Add **`dialog:allow-save`** to `capabilities/default.json` (scoped, not a blanket expansion). Current grant is `dialog:default` (open only). | [review-history] "the save action needs dialog:allow-save … silently blocked at runtime otherwise". |

---

## 2. Conflicts & decisions needed (VERBATIM — for human ruling before implementation)

> The following are reproduced verbatim from the research inputs. Each is followed by my recommended resolution. **A human must rule on the DECISION items, and the D1/D2/D3 spikes must land, before `feature-implement` runs.**

### Spec conflicts

- **[codebase]** The spec says 'IPC contract — update ipc.rs + ipc.ts + lib.rs' (Section 5) as if WS-B or WS-C can do this, but CLAUDE.md line 77 states the IPC surface is FROZEN and WS-A owns it exclusively, and `lib.rs` (the handler registration) is 'owned by WS-A only'. Every new command (`export_html`, `export_pdf`, `read_file_bytes`) requires a WS-A change to both `src-tauri/src/ipc.rs` AND `src-tauri/src/lib.rs` AND `src/lib/types/ipc.ts`. The spec's workstream attribution must be corrected: these IPC changes are a WS-A deliverable that gates WS-B and WS-C.
  - **Resolution:** Accept. WS-A owns `export.rs` + the full IPC slice and ships it first (Workstream A below). WS-B is not used for these commands; the Rust command bodies live in WS-A's `export.rs`. WS-C consumes the typed wrappers only after A lands.

- **[codebase]** The spec's Component 3 (Comments layer) says 'reuse annotationResolve / findSpan logic'. `annotationResolve.ts` exports `resolveBlock()` which operates on a live `HTMLElement` queried from the real DOM. The `documentExport.ts` works with a string, so the actual implementation must parse the export HTML string with `DOMParser` and operate on that parsed document — a different calling context than PreviewPane uses. The spec understates the adaptation required.
  - **Resolution:** Accept. Write a new `findAnchorSpan(parsedDoc, annotation)` in `documentExport.ts` operating on a `DOMParser` document via text-node walking + string search of `quoted_text`. No call into `resolveBlock`/`annotationHighlight`. Budgeted as its own task (C4).

- **[codebase]** The spec states `export_pdf` creates 'a hidden Tauri webview'. Tauri 2's API for creating a second hidden webview within an existing window is `tauri::WebviewBuilder::new()` (requires the `unstable` feature or specific Tauri version). The existing codebase uses only `with_webview()` on the primary window (in `snapshot.rs`). This mechanism has not been validated in this codebase and the `unstable` feature is not currently enabled in `Cargo.toml`. The spec correctly calls this 'highest-risk' but the specific API path (`WebviewBuilder` vs. a `data:` URL approach vs. a temp file approach) needs spiking.
  - **Resolution:** **DECISION D1 (spike required).** Block WS-A task A6 (`export_pdf` body) until the spike picks a mechanism: (a) `WebviewWindowBuilder` hidden window + `with_webview`, (b) temp HTML file via `asset://`, (c) `data:` URL. Recommend temp-file + `WebviewWindowBuilder` to dodge CSP `data:` navigation limits (see CSP conflict below). The IPC signature `export_pdf(out_path, html)` is pinnable now; the body waits on the spike.

- **[codebase]** The spec says the CSS refactor extracts prose styles from PreviewPane.svelte into `markdown.css`, stating 'Preview imports it for live styling…'. This is accurate for `.preview-content :global(...)` rules but the `.prose` container itself (padding, font-family, max-width at PreviewPane.svelte lines 722–732) and the frontmatter header styles (lines 734–766) are layout/chrome rules that serve the live preview. Moving `.prose` padding/max-width to `markdown.css` works for export (the exporter can wrap in `<article class='prose'>`) but the frontmatter header styles (`.pv-header`, `.pv-title`, etc.) are UI-specific class names not used in the export HTML. The spec needs to clarify which `.pv-*` styles, if any, get translated into export-specific equivalents.
  - **Resolution:** Accept. `markdown.css` = `.prose` + `.preview-content` content rules + `--ps-*` tokens. `.pv-*` frontmatter chrome stays in PreviewPane. The exporter emits a self-contained export-specific frontmatter header block (its own small CSS in the bundle), NOT the `.pv-*` classes. Documented in C1 (extraction) and C3 (header emit).

- **[codebase]** The spec's font embedding says 'inline @font-face: base64 woff2 (Vite ?inline data-URIs for the used weights)'. … `?inline` for binary-as-base64 is not a standard Vite query suffix … The correct Vite approach for binary-to-base64 is `?url` (returns a URL, not base64) or a custom plugin. The actual mechanism needs verification; the alternative is fetching the woff2 via `fetch()` at export time and converting to base64 in JS.
  - **Resolution:** **DECISION D3 (spike required).** Recommend `import url from '...woff2?url'` then `fetch(url) → arrayBuffer → base64` at export time (works in the Tauri webview; `?url` is standard Vite, no plugin, no extra dep). Vitest mocks the fetch. Confirm in D3 before C2.

- **[codebase]** The spec assigns `read_file_bytes` confinement to 'the doc's own directory'. … The confinement should be to the doc's parent directory (which `starts_with` naturally includes all subdirectories) … The spec wording is technically fine but could be clearer that 'doc's own directory' means the parent directory and all descendants.
  - **Resolution:** Accept. Confine to canonical doc parent dir; `starts_with` covers subdirectories. Plus `has_parent_traversal` pre-guard (see architecture item below). Task A7.

- **[ux]** The spec says the Export dropdown folds in the existing 'Export to Obsidian' button, but Toolbar.svelte dispatches exportObsidian as a direct event (L94) that App.svelte handles (L579). Changing this to a dropdown item means the event dispatch chain changes … App.svelte (WS-A-owned) will need updating for the new wiring path, but the spec assigns Toolbar.svelte changes to WS-C. This is a cross-workstream dependency that the spec does not call out.
  - **Resolution:** **Conflict with CLAUDE.md ownership.** `App.svelte` is WS-A-owned; `Toolbar.svelte` is WS-C-owned. Resolution: WS-A owns the `App.svelte` wiring change (new event handlers + palette entries) as task A8; WS-C owns the `Toolbar.svelte` dropdown + `ExportDialog.svelte` (C5/C6). The event-name contract (`exportDocument` event + retained `exportObsidian`) is fixed in this plan so A and C can build in parallel against it.

- **[ux]** The spec lists read_file_bytes as a new IPC command (section 5) but ipc.ts is FROZEN (WS-A owned). … This must be added to the WS-A work items to avoid a broken import at build time.
  - **Resolution:** Accept — `read_file_bytes` is in WS-A's IPC slice (A2/A3/A4) alongside `export_html`/`export_pdf`.

- **[ux]** The spec assigns markdown.css creation to WS-C … However, the CSS in PreviewPane.svelte (L652-L919) includes both document-content styles and UI chrome styles. The spec says 'Annotation seal/wash styles stay in AnnotationSeals.svelte' but does not address the banner, add-comment-affordance, or pv-header styles. The extraction boundary needs to be precisely defined … otherwise the WS-C developer must make an architectural call that is really a WS-A decision.
  - **Resolution:** Boundary is fixed in this plan (see CSS extraction scope in §1 and C1 task): content rules → `markdown.css`; `.preview-pane`/`.pv-scroll`/`.banner`/`.add-comment-affordance`/`.pv-*` → stay. This removes the architectural call from WS-C.

- **[ux]** The spec says PDF export uses 'a hidden Tauri webview' loaded with the bundle string via 'temp file or data: URL'. Tauri 2 has restrictions on data: URLs in WebView2 (Windows) due to CSP … data: URL navigation for a full HTML document is different from blob: URLs for workers. This is called out as Risk #1 in the spec but the CSP implication for the hidden webview is not mentioned in the Risks section and may require a separate capabilities entry.
  - **Resolution:** **DECISION D2 (covered by D1 spike).** Prefer temp-file navigation over `data:` to avoid CSP `default-src self` blocking top-level `data:` navigation. If a dedicated hidden window/label is used it may need its own capability entry — determined in the spike; documented as a spike acceptance criterion.

- **[ux]** … the Tauri save dialog … on macOS returns a path string while on Windows it may return with backslashes. The spec says 'validate it is a writable absolute path with an .html ext' … but the ext check must handle both .html and .HTML (case-insensitive) on Windows.
  - **Resolution:** Accept. Extension checks are case-insensitive (`eq_ignore_ascii_case`) for both commands. Task A5/A6.

### Architecture findings

- **[architecture]** read_file_bytes confinement is insufficient: paths.rs assert_confined is lexical starts_with, fooled by dot-dot (paths.rs:218-227). It must ALSO call has_parent_traversal (as export_obsidian at ipc.rs:717) or a traversal image ref could be read and embedded.
  - **Resolution:** Accept — `has_parent_traversal` guard precedes `assert_confined` in `read_file_bytes`. Regression test added (A7 verification).

- **[architecture]** Spec grants export_html/export_pdf no vault confinement for user paths, departing from save_file/export_obsidian fail-closed posture. Defensible for Save-As, but validate absolute path, correct extension, no traversal in derived components.
  - **Resolution:** Accept — validation-without-confinement as described in §1. Documented inline in `export.rs`.

- **[architecture]** CSP incomplete: if the hidden PDF webview inherits tauri.conf.json:38 CSP, loading a large data document URL as top-level navigation may hit default-src self. Verify in spike (temp html file may be needed instead of data:).
  - **Resolution:** Accept — folded into D1/D2 spike acceptance criteria (temp-file path preferred).

- **[architecture]** Spec cites findSpan, which does not exist; resolveBlock is block-granular/live-DOM-bound. Reuse is overstated; expect new span-resolution code.
  - **Resolution:** Accept — new `findAnchorSpan` in C4 (confirmed: only `resolveBlock` is exported from annotationResolve.ts; no `findSpan`).

### Review-history findings

- **[review-history]** Spec §5 says the save dialog path comes from 'tauri-plugin-dialog save' … but capabilities/default.json currently only has 'dialog:default'. The spec does not mention needing to add 'dialog:allow-save'.
  - **Resolution:** Accept — add `dialog:allow-save` (task A1). Scoped, not a blanket fs ACL.

- **[review-history]** Spec §3 … 'reuse annotationResolve / findSpan logic' … runs in the live DOM … window.CSS.highlights and the Custom Highlight API are not available [in a DOMParser document] … The exporter must implement its own span-finding pass.
  - **Resolution:** Accept — see C4 (new `findAnchorSpan`).

- **[review-history]** Spec §5 … 'reuse markdown.ts renderMermaid' … uses a singleton _mermaidTheme that reads document.documentElement.getAttribute('data-theme') … the theme must be forced to 'default' (light).
  - **Resolution:** Accept — force light theme in export. If `renderMermaid` has no theme override param, C2 sets `document.documentElement` data-theme to light for the export render, or threads an explicit theme. Confirm the exact mechanism while implementing C2; do NOT modify `render/markdown.ts` signatures without a WS-A note (it is WS-A-frozen-adjacent — coordinate).

- **[review-history]** Spec §5 mentions 'Vite ?inline data-URIs' … there are no @font-face declarations in tokens.css or global.css … This needs to be verified before committing to the base64-embed approach.
  - **Resolution:** Verified: fonts are local `@fontsource*/files/*.woff2` assets loaded via CSS imports in `src/main.ts`. `?inline` is non-standard → use `?url` + `fetch` (D3). No CDN dependency.

### Open risks / DECISIONS REQUIRED

- **[codebase] DECISION REQUIRED — Hidden webview creation for PDF** (`WebviewBuilder::new()` needs `unstable`; alternatives: hidden off-screen element / temp file via `asset://`). The team must spike this and choose the mechanism before WS-A implements `export_pdf`.
  - **Resolution:** **D1.** Spike first (task A0). Recommend temp-file + `WebviewWindowBuilder` hidden window with a unique label (`export-pdf-<uuid/timestamp>`), guaranteed teardown in a `finally`/drop, main-thread window ops, bounded load-wait then `createPDF`/`PrintToPdfAsync`. Verify a second webview is permitted under single-instance.

- **[codebase] DECISION REQUIRED — WKWebView.createPDF API surface** (`WKPDFConfiguration` must be in `objc2-web-kit 0.3`; current features: `WKWebView`, `WKSnapshotConfiguration`, `block2`).
  - **Resolution:** **D1 (macOS arm).** Spike confirms `WKPDFConfiguration` symbol availability; add the feature to `Cargo.toml`. If absent, fall back to raw `sel!` dispatch or a pinned crate bump (avoid bumping the wry-locked objc2 family).

- **[codebase] DECISION REQUIRED — Windows PDF** (`webview2-com` direct vs. wry internal access for `PrintToPdfAsync`).
  - **Resolution:** **D1 (Windows arm).** Recommend a direct `webview2-com` dependency mirroring the macOS objc2 pattern. Decide in spike.

- **[codebase] DECISION REQUIRED — Vite font base64 embedding** (`?inline` not standard; options: plugin / `fetch()` at export / precompute).
  - **Resolution:** **D3.** Recommend `?url` + `fetch`→base64 at export (no new dep). Decide in spike.

- **[codebase] RISK — markdown.css CSS extraction regression** … must be regression-tested; preview must look pixel-identical.
  - **Resolution:** Accept — C1 ends with a mandatory live-preview smoke (per lessons.md 2026-06-13 human-look rule). Screenshot-diff before merge.

- **[codebase] RISK — DOMPurify in export context** … exporter must not inject any `<script>` tags (confirmed safe; `ALLOWED_TAGS` excludes `script`).
  - **Resolution:** Accept — C7 unit test asserts no `<script>` in output.

- **[codebase] RISK — Workstream boundary** … the plan must sequence WS-A first for the new IPC slice.
  - **Resolution:** Accept — A0 (spike) → A1–A8 land and merge before B/C start coding against the wrappers. C1 (CSS extraction) can begin in parallel (no IPC dependency).

- **[codebase] RISK — Toolbar dropdown pattern** (no existing component; dismiss-on-outside-click model exists in PreviewPane L576–588).
  - **Resolution:** See D4.

- **[ux] DECISION NEEDED — Dropdown implementation strategy** (native `<dialog>` vs CSS-positioned div). Recommend native `<dialog>` positioned to the button rect.
  - **Resolution:** **D4.** Recommend native `<dialog>` for both the trigger menu and ExportDialog. Human ruling requested.

- **[ux] DECISION NEEDED — Toolbar regression** (Obsidian becomes two clicks). Options: (a) keep dropdown, (b) standalone button + separate Export button, (c) Obsidian as icon-btn + Export dropdown.
  - **Resolution:** **D5.** Product decision. Recommend (c): Obsidian → icon-btn, add "Export ▾" text dropdown — preserves one-click Obsidian and reduces density.

- **[ux] DECISION NEEDED — 'Include comments' when all annotations are detached** (empty in-text marks, endnotes only).
  - **Resolution:** **D6.** Recommend: still allowed; show descriptor copy "Includes N anchored, M detached (as endnotes)". Disable the checkbox only when annotations AND general notes are both empty. Human ruling requested.

- **[ux] RISK — hidden-webview PDF needs a non-zero frame / window hierarchy on macOS or output is blank.**
  - **Resolution:** Covered by D1 spike acceptance: render to a real (off-screen or 1×1-visible) window, confirm fonts/images render, document the fallback.

- **[ux] RISK — Font base64 size** (full variable fonts could be 1–2 MB).
  - **Resolution:** Measured latin-only ≈ 196 KB total → bundle a few hundred KB. C2 embeds latin-only weights; verify size in C2 test.

- **[ux] RISK — Two toast systems coexist.**
  - **Resolution:** Export uses the `Toast` store. Consolidation of the legacy local toast is out of scope (noted, not done).

- **[architecture] Hidden-webview PDF generation is unproven and schedule-dominating** (spike must cover creation, load-completion, teardown on success/timeout/panic, single-instance compatibility, macOS vs Windows API differences).
  - **Resolution:** D1 spike acceptance criteria enumerate exactly these. Spike is task A0 and blocks A6.

- **[architecture] Workstream ownership gap** (new Rust module with no owner; only WS-A may edit lib.rs).
  - **Resolution:** `export.rs` owned by WS-A (see §1). WS-B/WS-D unused for this feature.

- **[architecture] markdown.css extraction risks live-preview visual regression; screenshot-diff before merge.**
  - **Resolution:** Accept — C1 acceptance includes screenshot-diff + human look.

- **[architecture] Font subset choice unresolved** (latin-only drops non-Latin; full bloats).
  - **Resolution:** v1 embeds latin-only (matches preview for latin docs; spec's "identical to preview" holds for the common case). Non-latin export fidelity is a follow-up. Human may override in D3.

- **[architecture] markdown-it typographer/footnote reuse** — must reuse renderMarkdown.
  - **Resolution:** Accept — exporter imports `renderMarkdown`; never re-instantiates markdown-it.

- **[review-history] WKWebView.createPDF availability in objc2-web-kit v0.3 unverified.** → D1.
- **[review-history] Hidden Tauri WebviewWindow create/destroy has no prior art; label-collision + lifecycle undefined.** → D1 (unique label, teardown API decided in spike).
- **[review-history] Font embedding local-vs-external unconfirmed.** → Verified local (D3).
- **[review-history] markdown.css extraction needs a human live-preview look (lessons.md 2026-06-13).** → C1 acceptance.
- **[review-history] export_pdf is a new async IPC handler → requires a real `cargo tauri dev` run (lessons.md 2026-06-14 launch-smoke).** → Final acceptance gate G1.

---

## 3. File map

### Create
| Path | Owner | Purpose |
|---|---|---|
| `src-tauri/src/export.rs` | WS-A | `export_html`, `export_pdf`, `read_file_bytes` command bodies + path validation. |
| `src/lib/styles/markdown.css` | WS-C | Extracted prose/content CSS (single source for preview + export). |
| `src/lib/documentExport.ts` | WS-C | `buildExportDocument(...)` bundle builder + comments layer + font/image embed. |
| `src/lib/ExportDialog.svelte` | WS-C | Native `<dialog>`: format radio + include-comments + Export/Cancel. |
| `src/tests/document_export.test.ts` | WS-C | Vitest unit tests for the bundle builder. |
| `src-tauri/src/tests/export_tests.rs` | WS-A | Path/extension/confinement tests for the write commands. |

### Modify
| Path | Owner | Change |
|---|---|---|
| `src-tauri/src/ipc.rs` | WS-A | Add `export_html`/`export_pdf`/`read_file_bytes` `#[tauri::command]` fns (delegating to `export.rs`) + request/result types. |
| `src-tauri/src/lib.rs` | WS-A | `pub mod export;` + 3 entries in `generate_handler!`. |
| `src/lib/types/ipc.ts` | WS-A | 3 typed wrappers + types mirroring ipc.rs. |
| `src/tests/ipc_contract.test.ts` | WS-A | Contract coverage for the 3 new commands. |
| `src-tauri/src/tests/mod.rs` (or equivalent) | WS-A | Register `export_tests` module. |
| `src-tauri/Cargo.toml` | WS-A | Add `objc2-web-kit` `WKPDFConfiguration` feature (macOS); direct `webview2-com` dep (Windows) — exact set from D1. |
| `src-tauri/capabilities/default.json` | WS-A | Add `dialog:allow-save`. |
| `src-tauri/tauri.conf.json` | WS-A | CSP / hidden-webview capability adjustment if D1 requires it. |
| `src/App.svelte` | WS-A | Wire `exportDocument` event → open ExportDialog; add palette entries (`Export as PDF`, `Export as HTML`); keep `export-obsidian`. |
| `src/lib/PreviewPane.svelte` | WS-C | Remove extracted content CSS; import `markdown.css`; keep chrome/`.pv-*` CSS. |
| `src/lib/Toolbar.svelte` | WS-C | Replace standalone Obsidian button with "Export ▾" dropdown (per D5); dispatch `exportDocument`; retain `exportObsidian`. |
| `src/lib/KeyboardShortcutsModal.svelte` | WS-C | Add export entries to the File & review group (only if shortcuts are added). |

> **Ownership note:** Per CLAUDE.md, `lib.rs`, `ipc.rs`, `ipc.ts`, `App.svelte`, `Cargo.toml`, `tauri.conf.json`, `capabilities/**`, and `src/tests/ipc_contract.test.ts` are WS-A files. This plan keeps the new Rust module (`export.rs`) and its tests in WS-A too, so WS-B/WS-D are not involved.

---

## 4. Workstreams (zero file overlap)

| WS | Owns (files) | Depends on |
|---|---|---|
| **A — IPC + Rust + native PDF + app wiring** | `src-tauri/src/export.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs`, `src/lib/types/ipc.ts`, `src/tests/ipc_contract.test.ts`, `src-tauri/src/tests/export_tests.rs`, `src-tauri/src/tests/mod.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`, `src/App.svelte` | D1/D2/D3 spike (A0) gates A6 only. A8 (App wiring) depends on the C-event contract (fixed in this plan). |
| **B — CSS extraction + exporter core** | `src/lib/styles/markdown.css`, `src/lib/PreviewPane.svelte`, `src/lib/documentExport.ts`, `src/tests/document_export.test.ts` | C1 (CSS) independent. documentExport image-embed path depends on A's `read_file_bytes` wrapper; gate its image task on A landing. |
| **C — Dialog + trigger surfaces** | `src/lib/ExportDialog.svelte`, `src/lib/Toolbar.svelte`, `src/lib/KeyboardShortcutsModal.svelte` | Calls `buildExportDocument` (WS-B) + IPC wrappers (WS-A). Build last. |

**No file appears in two workstreams.** WS-A owns `App.svelte`; WS-C owns `Toolbar.svelte` — the cross-component event contract (`exportDocument` event; retained `exportObsidian` event) is fixed here so A and C never edit each other's files.

> Naming: the spec's "WS-B/WS-C" labels are superseded by these A/B/C workstreams for THIS feature. (CLAUDE.md's standing WS-A..WS-D are the repo-wide ownership map; this feature only touches WS-A-owned IPC/app files plus new WS-C-owned frontend files plus one new Rust module assigned to WS-A.)

---

## 5. Tasks

### Workstream A — IPC + Rust + native PDF + app wiring

**A0 — Spike: native PDF + hidden webview + font embed (D1/D2/D3).** *(blocks A6, C2)*
- Prototype on a throwaway branch: (1) create a hidden `WebviewWindowBuilder` window with a unique label, navigate to a temp HTML file, wait for load, call `WKWebView.createPDF` (macOS) / `PrintToPdfAsync` (Windows), write bytes, tear down in all paths (success/timeout/panic). (2) Confirm `WKPDFConfiguration` exists in `objc2-web-kit 0.3`. (3) Confirm a second webview is allowed under single-instance. (4) Prototype `import url from '...woff2?url'` + `fetch→base64` in the webview.
- **Verify:** spike produces a non-blank PDF of a fonted+Mermaid doc on macOS; documents the chosen mechanism + teardown API + any required capability/CSP entry; confirms `?url`+fetch yields base64. Output: a short decision note appended to this plan's decisions. No production code merged from the spike.

**A1 — Add `dialog:allow-save` capability.**
- Edit `src-tauri/capabilities/default.json`: add `"dialog:allow-save"` to `permissions`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` succeeds; `cargo tauri dev` opens without an ACL error (save path tested in C).

**A2 — Add Rust IPC types + command stubs in `ipc.rs`.**
- Add `ExportHtmlRequest`/`ExportPdfRequest`/`ReadFileBytesRequest` (or simple args) + result types. Add `#[tauri::command]` fns `export_html`, `export_pdf` (async), `read_file_bytes` delegating to `crate::export::*`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` (will fail until `export.rs` exists — land A5–A7 together).

**A3 — Register handlers in `lib.rs`.**
- Add `pub mod export;` and the 3 entries to `generate_handler!`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` succeeds (with A5–A7).

**A4 — Mirror typed wrappers in `ipc.ts`.**
- Add `exportHtml(outPath, html)`, `exportPdf(outPath, html)`, `readFileBytes(path)` wrappers + types. Document each.
- **Verify:** `npx tsc --noEmit` passes.

**A5 — `export_html` body in `export.rs`.**
- Validate: absolute path, `.html`/`.HTML` case-insensitive ext, `has_parent_traversal` on path; write UTF-8 bundle; return path. Error code `INVALID_PATH` with a human-readable `.message`.
- **Verify:** `cargo test export --manifest-path src-tauri/Cargo.toml` — new tests for valid write, rejected relative path, rejected wrong ext, rejected traversal all pass.

**A6 — `export_pdf` body in `export.rs`.** *(depends on A0)*
- Implement the spike-chosen mechanism: hidden webview → load bundle → native PDF → write bytes → guaranteed teardown; bounded timeout → `PDF_EXPORT_FAILED`. Same validation as A5 but `.pdf`/`.PDF`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` succeeds; live `cargo tauri dev` exports a real PDF (covered by G1).

**A7 — `read_file_bytes` body in `export.rs`.**
- `has_parent_traversal` guard → canonicalize doc dir → `assert_confined(image_path, &[doc_parent])` → read bytes. Out-of-dir/unreadable → error the frontend treats as "skip" (degrade to alt text).
- **Verify:** `cargo test export --manifest-path src-tauri/Cargo.toml` — tests: reads a file in a subdir of doc dir (allowed); rejects `../escape` (traversal guard); rejects sibling-dir path (confinement). All pass.

**A8 — App.svelte wiring + palette entries.** *(event contract fixed by this plan)*
- Handle `on:exportDocument` from Toolbar → open ExportDialog (preset format optional). Keep `on:exportObsidian` → `handleExportObsidian`. Add palette commands `export-pdf` / `export-html` (section `Review`, keywords `pdf html export save download`) opening the dialog preset; keep `export-obsidian`.
- **Verify:** `npm run build` + `npx tsc --noEmit` pass; `cargo tauri dev` — palette shows the 3 export entries; clicking "Export document" opens the dialog.

**A9 — `ipc_contract.test.ts` coverage.**
- Add the 3 commands to the contract test so a missing handler fails CI.
- **Verify:** `npm test` — contract test passes; temporarily removing a `generate_handler!` entry makes it fail (sanity).

### Workstream B — CSS extraction + exporter core

**C1 — Extract `markdown.css`.**
- Create `src/lib/styles/markdown.css` with `.prose` + `.preview-content :global(...)` content rules + `--ps-*` tokens (PreviewPane L652–L919 content subset only). Delete those rules from PreviewPane's `<style>`; `import './styles/markdown.css'` (or via main.ts — keep WS-C-owned import path). Keep `.preview-pane`/`.pv-scroll`/`.banner`/`.add-comment-affordance`/`.pv-*` in PreviewPane.
- **Verify:** `npm run build` passes; **`cargo tauri dev` live-preview screenshot-diff vs main — human confirms pixel-identical** (lessons.md 2026-06-13). No double-rule pollution (rules deleted from PreviewPane).

**C2 — `documentExport.ts` core (no comments).**
- `buildExportDocument(content, opts) → Promise<string>`: `renderMarkdown(content)` → DOMParser → hydrate Mermaid (forced light theme) + code via `renderMermaid`/`renderCodeBlock` → inline `markdown.css?raw` + light `:root` from `tokens.css` (no dark) → `@font-face` base64 (latin-only weights, via D3 `?url`+fetch) → `@media print { @page { size: Letter; margin: 0.6in } break-inside: avoid … }` → full `<!doctype html>`.
- **Verify:** `npm test` — output is a complete doc; mermaid→`<svg>`; fenced code hljs-highlighted; light `:root` present, no `data-theme="dark"`; `@font-face data:font/woff2;base64` present for used weights; no `<script>`; bundle font payload < ~300 KB.

**C3 — Frontmatter header + local-image embed in exporter.**
- Emit an export-specific frontmatter header block (own CSS, not `.pv-*`). Local `![](relative)` → `readFileBytes` → base64 data-URI; `http(s)` left as-is; failures → alt text. *(image path depends on A4/A7)*
- **Verify:** `npm test` — relative image becomes `data:` URI (readFileBytes mocked); remote URL unchanged; failed read degrades to alt text; frontmatter header rendered.

**C4 — Comments layer.** *(new span-finder, no resolveBlock reuse)*
- When `includeComments`: parse bundle DOM; new `findAnchorSpan(doc, ann)` (text-node walk + `quoted_text` search) wraps anchored spans in `<mark class="ann-mark">…<sup>N</sup></mark>` (teal, hardcode `--ann-underline` value) numbered in document order; append `<section class="export-comments">` ordered list (N → quoted_text + body) + general notes; detached annotations listed without an in-text mark. Neutral section label ("Comments"/"Annotations") — no AI-tool names.
- **Verify:** `npm test` — anchored spans get numbered `<mark>` + matching endnotes; detached listed; general notes appear; no hardcoded "Claude"/"Copilot"; no `<script>`.

### Workstream C — Dialog + trigger surfaces

**C5 — `ExportDialog.svelte`.**
- Native `<dialog>` (ConflictModal shell: 440px, showModal, Esc/cancel): format radio PDF/HTML, Include-comments checkbox (disabled when annotations AND general notes empty, per D6), descriptor copy "Includes N anchored, M detached (as endnotes)". On Export → `buildExportDocument` → `save` dialog (default `<doc>.<ext>`) → `exportHtml`/`exportPdf` → `Toast` store success/error (`Export failed: <message>`). Disable Export button + "Exporting…" during the async op.
- **Verify:** `npx tsc --noEmit` + `npm run build` pass; `cargo tauri dev` — dialog opens, HTML export writes a file that opens standalone, PDF export (G1) produces a file; cancel = no-op.

**C6 — Toolbar "Export ▾" dropdown.** *(per D5; default = option (c))*
- Replace standalone Obsidian button: Obsidian → icon-btn; add "Export ▾" dropdown (native `<dialog>` anchored via `getBoundingClientRect`, per D4) with "Export document (PDF/HTML)…" → dispatch `exportDocument`, "Export to Obsidian" → dispatch `exportObsidian`. Outside-click dismiss (PreviewPane L576–588 model). Collapse to icon at the 1080px breakpoint.
- **Verify:** `npm run build` + `npx tsc --noEmit` pass; `cargo tauri dev` — dropdown opens/dismisses; both items fire the right App handlers; toolbar doesn't overflow at narrow width.

**C7 — KeyboardShortcutsModal sync.** *(only if shortcuts added in A8/C5)*
- Add export entries to the File & review group to avoid doc drift.
- **Verify:** `npm run build` passes; modal lists the new entries.

### Final gate

**G1 — Launch smoke (lessons.md 2026-06-14).** *(MANDATORY before merge)*
- Run `cargo tauri dev`; open a fonted doc with a Mermaid diagram + code + a relative image + comments; export HTML (open the file — fonts/diagram/highlight/image/comments all present, light mode); export PDF (Letter, 0.6in margins, no blank pages, fonts embedded). Confirm the async `export_pdf` handler registers and the hidden webview tears down (no leaked window/memory). Confirm light-mode export even when the app is in dark mode.
- **Verify:** both exports succeed on macOS; PDF is non-blank and matches the preview; no orphaned webview.

---

## 6. Out of scope (v1)
- A4 / page-size options, margin-note comment layout, page headers/footers, table of contents.
- Embedding **remote** images (left as `http(s)` URLs).
- **Dark-mode** export (always light).
- **Non-latin font subsets** (latin-only embed; non-latin docs fall back to system fonts in the export — follow-up).
- Consolidating App.svelte's two toast systems (export uses the `Toast` store; legacy local toast left as-is — pre-existing debt).
- Windows native PDF is implemented but **integration-verified live per platform**, not unit-tested; full Windows hardening (elevation/AV edge cases) tracked separately.
- A ⌘⇧E global shortcut for the dialog (would need a frozen-IPC/keymap note first).
