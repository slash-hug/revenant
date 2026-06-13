# Revenant — Markdown Viewer & Review Companion

**Status:** Approved design (pending spec review)
**Date:** 2026-06-13
**Author:** Randy (clogic@gmail.com) with Claude

---

## 1. Purpose

Revenant is a fast, cross-platform markdown viewer and review companion built to pair
with Superpowers. Whenever Superpowers (or Claude Code) generates a markdown file, it can
run `revenant <file.md>` to open the document for review. The app supports editing the
source, annotating with anchored comments, exporting a Claude-readable review summary that
feeds the existing "address the notes" loop, and exporting documents into an Obsidian vault.

**Primary use case:** review docs Superpowers just created, leave feedback, and hand that
feedback back to Claude with minimal friction. Runs on the author's macOS dev machine and
Windows work machine.

### Success criteria

- `revenant <file.md>` opens a file in a new tab of a single persistent app instance.
- Subsequent opens are effectively instant (runtime cost paid once).
- Source editing with live preview; save writes back to the file.
- Anchored comments persist in a sidecar file; markdown source stays clean.
- A one-action export produces a `<doc>.review.md` Claude can read.
- Export to an Obsidian vault via REST (if running) or filesystem copy (fallback).
- Ships installable builds for **macOS and Windows** from a CI matrix.

---

## 2. Architecture overview

A **Tauri 2** desktop app running a **single persistent process**. Invoking
`revenant <file.md>` a second time does not launch a new app — Tauri's single-instance
plugin forwards the file path to the already-running window, which opens it as a **new
tab**. The webview/runtime cost is paid once; every subsequent open is just a tab.

- **Core (Rust):** CLI arg parsing, single-instance forwarding, file I/O + file-watching,
  Obsidian export, settings persistence.
- **Frontend (Svelte + Vite + TypeScript):** tabs, editor, preview, annotation UI. Svelte
  chosen for a lean, fast bundle.
- **Editor:** CodeMirror 6 (markdown mode, syntax-highlighted source).
- **Renderer:** `markdown-it` (GFM presets: tables, task lists, strikethrough, autolinks,
  footnotes) with:
  - **Mermaid** (lazy-loaded) for ` ```mermaid ` fenced blocks.
  - **Syntax highlighting** via **highlight.js** (lazy-loaded) for code blocks — chosen
    over Shiki for v1 for its smaller footprint and faster init; Shiki is a later option if
    richer themes are wanted.
  - **YAML frontmatter** parsed out and rendered as a styled metadata header.
- **No KaTeX/math in v1.**

### Cross-platform note

macOS and Windows are co-equal v1 targets (Linux optional, same codebase). Tauri's
single-instance, CLI, and file-watching plugins behave identically on both. Platform-specific
work is limited to packaging and the `revenant` launcher.

---

## 3. Components

Each component has one clear purpose, a defined interface, and is independently testable.

1. **Launcher / forwarder** (Rust) — parse argv for the target file path; dedupe to the
   running instance via the single-instance plugin; emit an "open file" event to the
   frontend.
2. **Tab manager** (frontend) — open / close / switch tabs; track per-tab dirty state;
   handle "open file" events (new tab, or focus existing tab if the file is already open).
3. **Editor pane** (frontend) — CodeMirror 6 markdown editor; emits debounced change
   events; Cmd/Ctrl+S triggers save.
4. **Preview pane** (frontend) — incremental `markdown-it` render pipeline; scroll-synced
   with the editor; view-mode toggle (source-only / preview-only / split).
5. **Annotation layer** (frontend + sidecar) — select text in the preview/editor → attach
   an anchored comment; render margin markers; persist to sidecar JSON.
6. **Review exporter** (frontend + Rust write) — transform annotations into a
   Claude-readable `<doc>.review.md`.
7. **Obsidian exporter** (Rust) — push note to a vault via Local REST API if available,
   else filesystem copy; merge/add YAML frontmatter.
8. **Settings** (Rust persistence) — vault paths, default export subfolder, REST URL/key,
   theme, export-on-save toggles.

---

## 4. The review loop (linchpin feature)

This plugs into the existing "user edits notes inline → 'address the notes, don't
implement'" workflow.

### Annotation storage

- Annotations persist in a **sidecar JSON** next to the document:
  `<doc>.md.annotations.json`. The markdown source stays clean.
- Each comment stores: the **quoted text**, **surrounding context** (a few lines before/
  after), a **line/character range**, the comment **body**, and a status
  (`open` / `resolved`).
- On load, each annotation is **re-anchored by fuzzy match** against current document
  content, so light edits don't orphan comments. Annotations that can't be re-anchored are
  surfaced as "detached" rather than silently dropped.

### Review export

- A **"Generate review for Claude"** action (button + optional on-save) writes a
  human-readable `<doc>.review.md` next to the document:
  - A numbered list of each open comment with its **line range**, the **quoted snippet**,
    and the **note body**.
  - A free-form **"General notes"** section for document-wide feedback.
- The user then tells Claude: *"address the review notes in `<doc>.review.md`."* Claude
  reads it, revises the document; the app **hot-reloads** the file (with a conflict prompt
  if there are also unsaved in-app edits).

---

## 5. Data flow

```
revenant doc.md
  → single-instance forward (if app running)
  → open tab (editor + preview)
  → user edits (Ctrl/Cmd+S writes the file) and/or adds anchored comments (→ sidecar JSON)
  → "Generate review for Claude" (→ <doc>.review.md)
  → optional "Export to Obsidian" (REST or file copy, with frontmatter)
  → user tells Claude to address the review notes
  → Claude revises the file
  → app file-watcher detects change → hot-reload (conflict prompt if unsaved edits exist)
```

---

## 6. Error handling

- **Non-existent / non-`.md` file** → friendly in-tab error; app stays running.
- **External file change while editing** → file-watcher detects the change and prompts
  reload-vs-keep. Never silently clobbers in-app or on-disk edits.
- **Obsidian REST unavailable** → silent fallback to filesystem copy. If no vault path is
  configured → prompt to configure once, then remember.
- **Mermaid / highlight failure** → error rendered inline in that block only; the rest of
  the preview still renders. Preview never crashes the tab.
- **Detached annotation** (anchor can't be re-resolved) → flagged in the UI, retained in
  the sidecar, never silently discarded.

---

## 7. Testing

- **Rust unit tests:** CLI argument parsing; single-instance forwarding logic; Obsidian
  export (mocked REST endpoint + real filesystem copy + frontmatter merge); annotation
  anchor re-resolution (exact match, fuzzy match, detached).
- **Frontend (Vitest):** editor ↔ preview scroll/content sync; annotation create / resolve /
  re-anchor; review-export formatting (snapshot of generated `review.md`).
- **Smoke test:** launch with a file argument → assert a tab opens and renders expected
  content.
- **Per the project standard:** new features ship with at least one test; the annotation
  re-anchoring logic (highest-risk area) gets focused regression coverage.

---

## 8. Distribution

**macOS and Windows are both v1 targets** (Linux optional). Build and test both from the
start via a CI matrix.

- **macOS:** `cargo tauri build` → `revenant.app` + an install script that symlinks a
  `revenant` shim onto PATH (`~/.local/bin`).
- **Windows:** `cargo tauri build` → NSIS/MSI installer that registers `revenant.exe` and
  **adds it to the user PATH**, so `revenant doc.md` runs from any terminal — including from
  within Claude Code on the work machine.
- **CI:** a GitHub Actions matrix (macOS + Windows runners) builds both installers on tag.

### Cross-platform implications

- **Vault paths** accept both POSIX (`/Users/...`) and Windows (`C:\Users\...`) styles; the
  Obsidian exporter normalizes per-OS.
- **Single-instance forwarding** and the **CLI argument** work identically on both via the
  Tauri plugins.
- **Sidecar / review files** are written next to the document using OS-native path handling.

---

## 9. Performance tactics

"Extremely performant" is achieved through:

- **Persistent single instance** — runtime/startup cost paid once; subsequent opens are tabs.
- **Lazy-loaded heavy renderers** — Mermaid and syntax highlighting load on first use, not
  at startup.
- **Debounced, incremental preview rendering** — re-render only what changed.
- **Rust-side file I/O and watching** — fast, off the UI thread.
- **Large-document handling** — virtualized/windowed rendering for very large files so the
  preview stays responsive.

---

## 10. Out of scope for v1 (YAGNI)

- KaTeX / math rendering
- Multiple windows
- Plugin / extension system
- Cloud sync
- PDF / HTML export
- WYSIWYG (rendered-surface) editing

All are straightforward to add later if a real need appears.
