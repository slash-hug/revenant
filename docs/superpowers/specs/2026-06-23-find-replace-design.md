# Find & Replace — Design Spec

**Date:** 2026-06-23
**Status:** Approved
**Scope:** Custom find/replace UI with dual-pane highlighting

---

## Problem

Revenant currently relies on WebView2's native find-in-page (Ctrl+F). This has three issues:

1. **Preview-only highlighting** — the native find operates on the rendered DOM, so matches appear only in the preview pane. The CodeMirror source pane is opaque to it.
2. **Off-brand UI** — the browser-chrome find bar is visually disconnected from Revenant's design language.
3. **No replace** — read-only find with no way to act on results.

## Solution

A custom `FindBar.svelte` component that floats centered over the content area, styled with Revenant's design tokens, and highlights matches in **both** panes simultaneously. Full-featured: match count, navigation, case sensitivity, whole word, regex, and find-and-replace.

---

## Visual Design

### Layout & Positioning

- **Horizontally centered** over the content area (the region below the toolbar/tab strip).
- **Pinned near the top** — approximately 12px below the toolbar border.
- **Floats over content** — `position: absolute` within the content area container. Does not shift layout or push content down.
- **Same position in all view modes** — Source, Split, or Preview. The bar is always centered over whatever is visible.
- **z-index:** Above content and annotation seals, below modals (`--z-pop` / 30).

### Find Mode (Single Row)

```
┌─────────────────────────────────────────────────────────────┐
│  ▶  │ [  search input          3 of 17 ] │ Aa │ W │.* │↑│↓│ × │
└─────────────────────────────────────────────────────────────┘
```

Components left-to-right:
1. **Chevron toggle** (`▶`) — click to expand replace row. Rotates 90° when open.
2. **Search input** — auto-focused on open. Placeholder: "Find…"
3. **Match count** — inside the input (right-aligned): "N of M" or "No results".
4. **Case toggle** (`Aa`) — toggle button, highlighted when active.
5. **Whole word toggle** (`W`) — toggle button.
6. **Regex toggle** (`.*`) — toggle button.
7. **Previous** (`↑`) — navigate to previous match.
8. **Next** (`↓`) — navigate to next match.
9. **Close** (`×`) — dismiss the find bar and clear highlights.

### Replace Mode (Two Rows)

```
┌─────────────────────────────────────────────────────────────┐
│  ▼  │ [  search input          3 of 17 ] │ Aa │ W │.* │↑│↓│ × │
│     │ [  replace input                  ] │ Replace │ All │
└─────────────────────────────────────────────────────────────┘
```

- Second row appears below the find row with a slide-down animation.
- Replace input is left-aligned with the find input (indented past the chevron).
- **Replace** button — replaces the current active match and advances to next.
- **All** button — replaces all matches at once.

### Theming

The find bar uses Revenant's existing design tokens:

| Element | Light token | Dark token |
|---|---|---|
| Background | `--surface` (#FFFFFF) | `--surface` (#232427) |
| Border | `--border-strong` (#D2CBBC) | `--border-strong` (#393A3F) |
| Input bg | `--editor-bg` (#FAF8F4) | `--editor-bg` (#1A1B1E) |
| Input border | `--border` (#E1DCD1) | `--border` (#2A2B2F) |
| Input focus | `--accent` | `--accent` |
| Toggle active | `--accent-soft` bg + `--accent-text` color | `--accent-soft` bg + `--accent-text` color |
| Match count | `--text-muted` | `--text-muted` |
| Shadow | `--shadow-pop` | `--shadow-pop` |

### Match Highlighting

**All matches (passive):**
- Source pane: CodeMirror `Decoration.mark` with a `find-match` CSS class — `background: var(--accent-soft)`, subtle `border: 1px solid` using accent at 30% opacity.
- Preview pane: CSS Custom Highlight API with `::highlight(find-match)` — same accent-soft wash.

**Active match (current):**
- Source pane: `find-match-active` class — stronger accent background (~45% opacity), solid accent border, subtle glow (`box-shadow`).
- Preview pane: `::highlight(find-active)` — same stronger treatment.
- Both panes auto-scroll to keep the active match visible.

---

## Architecture

### New Files

| File | Purpose |
|---|---|
| `src/lib/FindBar.svelte` | The find/replace UI component |
| `src/lib/stores/find.ts` | Reactive find state store |
| `src/lib/find-highlight.ts` | Highlight logic for both panes (CodeMirror extension + Preview highlight) |

### Shared Find Store (`stores/find.ts`)

```typescript
interface FindState {
  open: boolean;          // whether the find bar is visible
  query: string;          // current search string
  caseSensitive: boolean; // Aa toggle
  wholeWord: boolean;     // W toggle
  useRegex: boolean;      // .* toggle
  replaceOpen: boolean;   // whether replace row is expanded
  replaceWith: string;    // replacement string
  matches: MatchRange[];  // computed from query + document
  currentIndex: number;   // index into matches[] for the active match
}

interface MatchRange {
  from: number;  // character offset in the document source
  to: number;
}
```

The store is writable. `FindBar.svelte` writes query/flags. Both `EditorPane` and `PreviewPane` subscribe to read match ranges and the current index.

### Source Pane Integration (CodeMirror)

A new CodeMirror `StateField` + `ViewPlugin`:

1. **StateField** receives match ranges from the find store via `StateEffect`.
2. Builds a `DecorationSet` with `Decoration.mark()` for each match. The active match gets a distinct class.
3. When `currentIndex` changes, dispatches a scroll-into-view effect for the active match's position.
4. Pattern follows the existing annotation highlight approach in `EditorPane.svelte` (lines ~120-145).

### Preview Pane Integration (CSS Custom Highlight API)

Uses the same infrastructure as `annotationHighlight.ts`:

1. Walk text nodes in the preview container.
2. Map source-offset match ranges to DOM `Range` objects using the existing `data-block-id` / line mapping.
3. Register two `Highlight` objects: `CSS.highlights.set('find-match', ...)` and `CSS.highlights.set('find-active', ...)`.
4. Style via `::highlight(find-match)` and `::highlight(find-active)` in CSS.
5. On `currentIndex` change, scroll the active match's block element into view.

**Fallback:** If `CSS.highlights` is not supported (feature-detected the same way as `isHighlightSupported()` in `annotationHighlight.ts`), fall back to injecting `<mark>` elements with DOMPurify re-sanitization. This is unlikely needed since WebView2 supports the Highlight API, but defensive.

### Replace Mechanics

- **Replace** dispatches a CodeMirror transaction: `view.dispatch({ changes: { from, to, insert: replaceWith } })`. This flows through the existing save-debounce and file-watcher pipeline. The preview re-renders automatically.
- **Replace All** dispatches a single transaction with all replacements (applied bottom-to-top to preserve offsets).
- After replacement, the match list is recomputed from the updated document.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+F` / `⌘F` | Open find bar (focus search input) |
| `Ctrl+H` / `⌘H` | Open find bar with replace row expanded |
| `Escape` | Close find bar, clear highlights |
| `Enter` | Next match |
| `Shift+Enter` | Previous match |
| `Alt+Enter` | Replace current + advance (when replace row open) |
| `Ctrl+Alt+Enter` | Replace all (when replace row open) |

`Ctrl+F` handling must intercept the event **before** the WebView2 native find activates. This is done by calling `e.preventDefault()` in the global keydown handler in `App.svelte`.

### Integration Points

**App.svelte:**
- Import `FindBar.svelte` and render it inside the content area container.
- Add `Ctrl+F` / `Ctrl+H` to the global keydown handler (before the no-tabs guard — find should only work when a document is open).
- Pass `findStore` to child panes as needed (or they import directly from `stores/find.ts`).

**EditorPane.svelte:**
- Add the find decoration extension to the CodeMirror extensions array.
- Subscribe to `findStore` changes and push `StateEffect` updates.

**PreviewPane.svelte:**
- Add a reactive block that watches `findStore` and calls the highlight logic after each render / query change.
- Clear find highlights on bar close (same pattern as `clearHighlights()` for annotations).

**KeyboardShortcutsModal.svelte:**
- Add `Ctrl+F` → "Find" and `Ctrl+H` → "Find & Replace" entries to the General group.

---

## Edge Cases

1. **Source-only / Preview-only modes:** Find bar still appears centered. Highlights only render in the visible pane(s).
2. **Regex errors:** If `useRegex` is on and the pattern is invalid, show a red border on the input + "Invalid regex" instead of the match count. No matches.
3. **Large documents:** Match computation should be debounced (~50ms) to avoid blocking on every keystroke for very long documents.
4. **Document switch (tab change):** Close the find bar or re-run the search against the new document. Decision: **keep it open and re-run** — if the user is searching across tabs, closing the bar on switch is annoying.
5. **Concurrent annotations:** Find highlights and annotation highlights coexist. Find uses separate `Highlight` names (`find-match`, `find-active`) and separate CodeMirror decoration classes to avoid collision.
6. **Replace in preview-only mode:** Disable the replace row (or show it grayed out) since the user can't see the source context. Replace operates on the source regardless, but the UX is confusing without the source visible.
7. **Scroll sync:** When navigating to a match, only scroll the pane that contains the match into view. In split mode, both panes should attempt to scroll-sync to the match region.

## Non-Goals

- **Cross-file search** — this is single-document find. Multi-file search is a separate feature.
- **Find in annotations** — search only covers the document body, not the annotation drawer content.
- **Saved search history** — no persistence of recent searches across sessions (could be added later).

---

## Files Modified (Summary)

| Action | File |
|---|---|
| **Create** | `src/lib/FindBar.svelte` |
| **Create** | `src/lib/stores/find.ts` |
| **Create** | `src/lib/find-highlight.ts` |
| **Modify** | `src/App.svelte` — mount FindBar, add Ctrl+F/H handler |
| **Modify** | `src/lib/EditorPane.svelte` — add find decoration extension |
| **Modify** | `src/lib/PreviewPane.svelte` — add find highlight logic |
| **Modify** | `src/lib/KeyboardShortcutsModal.svelte` — add Find/Replace entries |
| **Modify** | `src/lib/styles/tokens.css` — add `::highlight(find-match)` / `::highlight(find-active)` styles |
| **Create** | `src/tests/find_store.test.ts` — unit tests for match computation |
| **Create** | `src/tests/find_highlight.test.ts` — unit tests for highlight logic |
