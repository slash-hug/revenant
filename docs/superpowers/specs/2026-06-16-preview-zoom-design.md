# Preview Zoom & Uncapped Reading Width

**Date:** 2026-06-16
**Status:** Approved

---

## Problem

The preview pane's reading column is capped at 760px (`max-width` on `.prose`), so content appears small even on wide monitors. Dense Mermaid diagrams and tables are particularly hard to read. There is no way to zoom the preview content.

## Solution

Two changes:

1. **Remove the `max-width: 760px` cap** — let the `.prose` container fill the available pane width.
2. **Add preview zoom** — CSS transform-based scaling of the preview reading column, controlled via keyboard shortcuts, scroll wheel, and a settings panel control. Zoom level persists across sessions.

## Scope

- Zoom applies to the `.prose` reading column in **Preview** and **Split** view modes.
- The **editor pane is unaffected** — zoom is preview-only.
- The toolbar, tab bar, annotation drawer, and other UI chrome are unaffected.

## Mechanism

CSS `transform: scale(N)` with `transform-origin: top left` on the `.prose` container. A matching `width: calc(100% / N)` ensures the scaled content fills the column naturally without introducing horizontal scrollbar.

**Why `transform: scale()` over alternatives:**

| Approach | Scales everything | No layout reflow | Scroll sync safe | Standard |
|---|---|---|---|---|
| `transform: scale()` | ✅ | ✅ | ✅ | ✅ |
| CSS `zoom` | ✅ | ❌ reflows | ⚠️ shifts | ⚠️ non-standard |
| `font-size` scaling | ❌ images/SVG unaffected | ❌ reflows | ⚠️ shifts | ✅ |

`transform: scale()` scales text, images, diagrams, and tables uniformly. It does not trigger layout reflows, so scroll-sync block positions remain stable. It is well-supported across all WebView2 versions.

## Controls

| Input | Action |
|---|---|
| **Ctrl+Scroll wheel** | Zoom ±10% per notch |
| **Ctrl+Plus** (`Ctrl+=`) | Zoom in 10% |
| **Ctrl+Minus** | Zoom out 10% |
| **Ctrl+0** | Reset to 100% |
| **Settings panel** | Slider or dropdown showing current zoom % |

- **Range:** 50% → 200%, clamped at boundaries.
- **Step size:** 10% per increment.
- On macOS, `Cmd` replaces `Ctrl` for all shortcuts.

## Persistence

The zoom level is persisted in the app settings.

### Rust (`settings.rs`)

Add a new field to the `Settings` struct:

```rust
/// Preview zoom level as a percentage (50–200). Default 100.
#[serde(default = "default_preview_zoom")]
pub preview_zoom: u32,
```

With a default function:

```rust
fn default_preview_zoom() -> u32 { 100 }
```

**Schema version stays at 1.** Adding a new field with `#[serde(default)]` is backward-compatible — existing settings files missing the field will deserialize with the default value (100). No migration needed.

### TypeScript (`ipc.ts`)

Mirror the field in the `Settings` interface:

```typescript
preview_zoom: number; // 50–200, default 100
```

### Settings panel

Add a zoom control to the settings panel (slider preferred, with current percentage displayed). Changes from the slider update the store and persist immediately. Changes from keyboard/scroll shortcuts also persist.

## State Management

A new Svelte writable store `previewZoom` in `stores/previewZoom.ts`:

- **Initialized** from `Settings.preview_zoom` on app startup (via the existing settings load flow).
- **Updated** by keyboard/scroll handlers in PreviewPane and by the settings panel control.
- **Persisted** on change by calling the existing `set_settings` IPC command (debounced to avoid excessive writes during rapid scroll-zoom).
- **Subscribed** by PreviewPane to apply the CSS transform reactively.

## Reading Width Change

Remove `max-width: 760px` from the `.prose` rule in `markdown.css` (line 23). The content will fill the available pane width. Markdown block elements (paragraphs, headings, lists, tables, code blocks, `<hr>`) define their own vertical breaks, so the layout remains correct regardless of width.

## Files Changed

| File | Workstream | Change |
|---|---|---|
| `src/lib/styles/markdown.css` | WS-C | Remove `max-width: 760px` from `.prose` |
| `src/lib/PreviewPane.svelte` | WS-C | Apply `transform: scale()` from zoom store; handle Ctrl+scroll and Ctrl+±/0 keyboard events |
| `src/lib/stores/previewZoom.ts` | WS-C | New writable store for zoom level |
| `src-tauri/src/settings.rs` | WS-D | Add `preview_zoom: u32` field with serde default |
| `src/lib/types/ipc.ts` | WS-A | Add `preview_zoom: number` to Settings interface |
| Settings panel (WS-C) | WS-C | Add zoom slider/dropdown control |

## Edge Cases

- **Zoom at boundaries:** Ctrl+Plus at 200% or Ctrl+Minus at 50% is a no-op (clamped, no error).
- **Invalid persisted value:** If settings file contains `preview_zoom` outside 50–200, clamp to nearest boundary on load.
- **Export:** Document export (`documentExport.ts`) should render at 100% regardless of the current zoom level — exports produce a standalone HTML file and should not bake in the user's zoom preference.
- **Scroll sync:** `transform: scale()` does not change layout positions, so block-id-based scroll sync continues to work. The scroll container (`.pv-scroll`) is the parent of `.prose`, so scroll positions are in the un-transformed coordinate space.
- **Annotation seals / highlights:** These are positioned relative to `.pv-scroll` (the scroll container). Since the transform is on `.prose` (a child), DOM methods like `getBoundingClientRect()` return screen-space coordinates that already reflect the CSS transform, so seal positioning should work without changes. If seals appear offset at non-100% zoom, divide coordinates by the scale factor to convert back to `.pv-scroll` space.

## Testing

- **Unit tests:** Verify zoom store initializes from settings, clamps to range, and emits correct values.
- **Manual:** Ctrl+scroll zooms preview in both Preview and Split modes. Ctrl+0 resets. Settings slider matches. Zoom persists after app restart. Export renders at 100%. Scroll sync still works at non-100% zoom. Annotation seals/highlights position correctly.
