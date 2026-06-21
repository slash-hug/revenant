# Mermaid Rendering Quality + Zoom UX — Design

**Date:** 2026-06-20
**Branch:** `feat/mermaid-rendering-ux`
**Status:** Approved (pending spec review)

## Problem

Two user-reported issues with Mermaid integration:

1. **Diagrams don't look as good as GitHub.** Specifically: the cramped fixed-height
   interactive viewport, sizing/scale, and rendering sharpness. (The card framing and
   the color palette/theme are **not** problems and must stay exactly as they are.)
2. **Diagram zoom collides with page zoom.** Every diagram is wrapped in an inline
   pan/zoom viewport whose ctrl+scroll handler competes with the page-level
   ctrl+wheel zoom, and plain scrolling over a diagram hijacks the page scroll.

Both trace to the same root cause: **every diagram is an always-on interactive
mini-viewport inline.** GitHub renders the diagram at natural size in the text flow
and offers detail-on-demand instead.

## Goals

- Inline diagrams render like GitHub: natural size, fit-to-column, crisp.
- Eliminate the ctrl+wheel collision and scroll-jacking.
- Surface page zoom in a persistent, discoverable bottom control.
- **Do not** change the color palette or theme variables.
- Remove dead code from the old approach as we go (notably the OS popout).

## Non-goals

- No changes to Mermaid theme variables, fonts, or the diagram card framing.
- No changes to markdown parsing, sanitization (DOMPurify two-pass), or the
  Mermaid render/caching pipeline in `markdown.ts`.

## Design

### 1. Inline diagram = static, fit-to-width, never upscaled

`MermaidContainer.svelte` becomes a **static presenter** by default:

- Render the SVG at intrinsic size with `max-width: 100%; height: auto`.
  - Scale **down** to the reading column when the diagram is wider than the column.
  - Render **1:1** when it already fits.
  - **Never** upscale (remove the current up-to-2× fit-scaling — a sharpness culprit).
- Remove the fixed-height clamped viewport (currently 150px–70vh).
- Remove the always-on pan/drag/wheel capture. Scrolling over a diagram scrolls the page.
- Keep the existing **card framing** (border, surface background, padding) and **all
  theme colors** untouched.
- Give the SVG explicit intrinsic `width`/`height` so the browser does not guess at layout.

### 2. Hover/focus affordance

On hover or keyboard focus, a small control strip appears over the diagram:

- **zoom −**, **zoom +** — light in-place zoom (button-driven only; never grabs the wheel),
  bounded so the inline block stays reasonable.
- **fit** — reset to fit-to-width.
- **copy PNG** — see §5.
- **expand** — open the fullscreen lightbox (§3).

When not hovered/focused the diagram is visually static with no chrome.

### 3. Fullscreen lightbox for real pan/zoom

New `MermaidLightbox.svelte` — an in-app fullscreen overlay:

- Dims the page; **Esc** (and a close button / backdrop click) closes it.
- Hosts the **full** interactive pan/zoom/fit/copy experience.
- **Reuses** `diagramTransform.ts` and the existing interaction logic — the current
  MermaidContainer pan/zoom/drag/cursor-anchored-zoom code **moves here** rather than
  being deleted. This is the home for everything that used to be inline.
- Opened from the inline diagram's **expand** button (and could be triggered by a
  click on the diagram body).

`PreviewPane.svelte` owns which diagram (if any) is open in the lightbox.

### 4. Page zoom → bottom status bar; remove ctrl+wheel

New `PreviewStatusBar.svelte` pinned at the bottom of the preview pane:

- Layout: `−  [ slider ]  +   100%`, bound to the existing `previewZoom` store
  (`setZoom` / `adjustZoom` / `resetZoom`).
- Respects `ZOOM_MIN` (50) / `ZOOM_MAX` (200) / `ZOOM_STEP` (10) / `ZOOM_DEFAULT` (100).

In `PreviewPane.svelte`:

- **Remove** `handleZoomWheel` and the `onwheel` binding on `.pv-scroll` (kills ctrl+wheel
  page zoom and the collision).
- **Keep** `handleZoomKeydown` — ctrl+± and ctrl+0 keyboard shortcuts.
- The Settings → Appearance zoom slider (`AppearanceSection.svelte`) stays as-is
  (both drive the same store).

### 5. Sharpness specifics

- No inline upscaling (§1) — diagrams are never blown up past 1:1 inline.
- **Copy-as-PNG** rasterizes at `devicePixelRatio` (minimum 2×) instead of 1×, so the
  copied image is crisp on HiDPI displays.
- Explicit SVG intrinsic dimensions (§1) so layout is exact rather than inferred.

### 6. Remove the OS popout window (dead code)

The OS-level popout is fully replaced by the in-app lightbox and is removed entirely.
Verified to be isolated — the only runtime caller is `MermaidContainer.svelte`.
Removal footprint:

- `public/diagram-viewer.html`, `public/diagram-viewer.js` — delete.
- `src-tauri/src/ipc.rs` — remove `open_diagram_window` command + WebviewWindow logic.
- `src-tauri/src/lib.rs` — remove the `ipc::open_diagram_window` registration.
- `src/lib/types/ipc.ts` — remove the `openDiagramWindow` wrapper.
- `src/tests/ipc_contract.test.ts` — remove its contract test entries.
- `src/lib/MermaidContainer.svelte` — remove the import + caller.
- `CLAUDE.md` — remove `open_diagram_window` from the frozen IPC command list.

This **intentionally modifies the frozen IPC contract** (removing a command). Per repo
convention, `ipc.rs` + `ipc.ts` are updated together, plus `lib.rs` (WS-A) and the
CLAUDE.md command list.

## Components & ownership

| File | Change | Workstream |
|---|---|---|
| `src/lib/MermaidContainer.svelte` | Becomes static presenter + hover strip; interaction moves to lightbox; popout caller removed | WS-C |
| `src/lib/MermaidLightbox.svelte` | **New** — fullscreen overlay hosting full pan/zoom | WS-C |
| `src/lib/PreviewStatusBar.svelte` | **New** — bottom zoom control | WS-C |
| `src/lib/PreviewPane.svelte` | Remove ctrl+wheel; mount status bar; manage lightbox; static inline mount | WS-C |
| `src/lib/styles/markdown.css` | Diagram block: fit-to-width, no fixed-height viewport, no upscale; colors unchanged | WS-C |
| `src/lib/diagramTransform.ts` | Reused as-is by lightbox (no change expected) | WS-C |
| `src/lib/types/ipc.ts` | Remove `openDiagramWindow` | WS-A (frozen) |
| `src-tauri/src/ipc.rs` | Remove `open_diagram_window` | WS-A (frozen) |
| `src-tauri/src/lib.rs` | Remove registration | WS-A |
| `src/tests/ipc_contract.test.ts` | Remove popout test | WS-A test |
| `public/diagram-viewer.{html,js}` | Delete | WS-A |
| `CLAUDE.md` | Update frozen command list | WS-A |

## Testing

**Vitest (frontend):**
- Inline sizing: fits-to-width when wider than column; renders 1:1 when smaller; never upscales.
- `PreviewStatusBar`: −/+/slider drive `previewZoom`; clamps to min/max; reset works.
- Lightbox: opens from expand, closes on Esc/backdrop/close button.
- Copy-as-PNG uses a scale factor ≥ 2×.
- Existing Mermaid render + DOMPurify two-pass tests must stay green.
- `ipc_contract.test.ts`: popout test removed; all other commands still asserted.

**Rust:**
- `cargo build` / `cargo test` green after `open_diagram_window` removal.

**Manual:**
- No scroll-jacking over a diagram; page scrolls normally.
- ctrl+wheel no longer zooms the page; bottom bar + ctrl+± + ctrl+0 do.
- Lightbox pan/zoom/fit/copy works; Esc closes.
- Diagram colors visually unchanged in light and dark themes.
- `revenant --version` smoke check after Rust changes.

## Risks

- **Frozen-contract change:** removing an IPC command. Mitigated by verified isolation
  and updating all four touch points (ipc.rs/ipc.ts/lib.rs/CLAUDE.md) + the test.
- **Sharpness is partly WebView-dependent:** the page-level `transform: scale()` can
  soften text at non-100% zoom regardless of diagram changes; this design improves the
  diagram-specific causes (upscaling, PNG DPI) but does not re-architect page zoom.
