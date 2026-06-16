# Mermaid Diagram Interactive Controls — Design Spec

**Date:** 2026-06-16
**Status:** Draft
**Scope:** WS-C (Frontend) + WS-A (IPC) for popout command

---

## Overview

Add GitHub-style interactive controls to each rendered Mermaid diagram in Revenant's preview pane. Each diagram gets its own pan/zoom viewport with overlay controls that appear on hover, plus expand, copy-to-PNG, and popout-to-new-window functionality.

## Requirements

### Controls (all six)

| Control | Location | Behavior |
|---------|----------|----------|
| Pan arrows (↑↓←→) | Bottom-right | Pan diagram by 50px per click |
| Zoom in / out (+/−) | Bottom-right | Zoom ×1.25 or ÷1.25 per click |
| Fit to view / reset | Bottom-right | Auto-fit diagram to viewport, center |
| Expand full-width | Top-right | Toggle diagram to fill full preview width |
| Copy as PNG | Top-right | Render SVG to PNG, copy to clipboard |
| Popout window | Top-right | Open diagram in a new OS window via Tauri |

### Visibility

Controls appear on hover with a 200ms opacity fade-in. The diagram container gets a subtle border highlight on hover to indicate interactivity. A hint label ("Scroll to pan · Ctrl+scroll to zoom") shows at bottom-left on hover.

### Non-goals

- Per-diagram zoom persistence (resets on content change)
- Editing diagrams from the preview
- Touch/mobile gestures (desktop app)

---

## Architecture

### New files

```
src/lib/MermaidContainer.svelte    — interactive diagram wrapper (WS-C)
src/lib/diagramTransform.ts        — pure pan/zoom state logic (WS-C)
src/lib/diagramCopy.ts             — SVG→PNG clipboard pipeline (WS-C)
src-tauri/diagram-viewer.html      — standalone viewer page for popout window (Tauri asset, served from public/)
src/tests/diagram_transform.test.ts — unit tests for transform logic
src/tests/diagram_copy.test.ts     — unit tests for copy pipeline
```

### Modified files

```
src/lib/PreviewPane.svelte         — post-hydration MermaidContainer mounting
src-tauri/src/ipc.rs               — add open_diagram_window command + type
src-tauri/src/lib.rs               — register open_diagram_window in handler macro
src/lib/types/ipc.ts               — add open_diagram_window to TS IPC contract
src/tests/ipc_contract.test.ts     — update IPC command list test
```

### Unchanged

- `src/lib/render/markdown.ts` — rendering pipeline stays untouched
- Mermaid two-pass sanitization — unaffected
- Global preview zoom — independent, coexists

---

## Component Design: MermaidContainer

### Props

```typescript
interface MermaidContainerProps {
  svg: string;           // sanitized SVG markup
  source: string;        // original Mermaid source (for popout re-render)
  blockId: string;       // data-block-id for identification
}
```

### Local State (per-instance, not persisted)

```typescript
scale: number    = 1.0   // range 0.25–4.0
panX: number     = 0     // pixels
panY: number     = 0     // pixels
expanded: boolean = false
hovering: boolean = false
```

### DOM Structure

```html
<div class="mermaid-container" class:expanded class:hovering>
  <div class="mc-viewport">
    <div class="mc-canvas"
         style="transform: translate({panX}px,{panY}px) scale({scale});
                transform-origin: 0 0;">
      {@html svg}
    </div>
  </div>

  <!-- Top-right: expand, copy, popout -->
  <div class="mc-toolbar-top">
    <button class="mc-btn" title="Expand" onclick={toggleExpand}>⤢</button>
    <button class="mc-btn" title="Copy as PNG" onclick={copyAsPng}>📋</button>
    <button class="mc-btn" title="Open in new window" onclick={popout}>⧉</button>
  </div>

  <!-- Bottom-right: pan + zoom grid -->
  <div class="mc-toolbar-bottom">
    <!-- 2-col grid: [↑][+] / [← ⊞ →] / [↓][−] -->
  </div>

  <!-- Bottom-left: hint -->
  <div class="mc-hint">Scroll to pan · Ctrl+scroll to zoom</div>
</div>
```

Note: MermaidContainer uses Svelte 5 runes syntax (`onclick`, `$state`, etc.)
consistent with App.svelte. Not Svelte 4 options-API.

### Interaction Map

| Input | Action |
|-------|--------|
| Mouse drag on viewport | Pan (update panX/panY) |
| Scroll wheel | Pan vertically (deltaY) and horizontally (deltaX/shift) |
| Ctrl+scroll wheel | Zoom toward cursor position |
| Pan arrow buttons | Pan ±50px per click |
| +/− buttons | Scale ×1.25 or ÷1.25 per click |
| Fit button | Calculate fit scale + center offsets, apply |
| Expand button | Toggle `.expanded` class |
| Copy button | SVG→PNG→clipboard pipeline |
| Popout button | `invoke('open_diagram_window', ...)` |

### Zoom-toward-cursor algorithm

When zooming with Ctrl+scroll:
1. Get cursor position relative to the viewport
2. Calculate the point in canvas-space under the cursor: `canvasX = (cursorX - panX) / oldScale`
3. Apply new scale
4. Recalculate pan so the same canvas point stays under the cursor: `panX = cursorX - canvasX * newScale`

---

## diagramTransform.ts — Pure State Logic

Extracted for testability. No DOM dependencies.

```typescript
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;
export const ZOOM_FACTOR = 1.25;  // per step
export const PAN_STEP = 50;       // px per arrow click

export interface DiagramTransform {
  scale: number;
  panX: number;
  panY: number;
}

export function zoomAtPoint(
  t: DiagramTransform,
  direction: 1 | -1,
  cursorX: number,
  cursorY: number
): DiagramTransform;

export function pan(
  t: DiagramTransform,
  dx: number,
  dy: number
): DiagramTransform;

export function fitToView(
  svgWidth: number,
  svgHeight: number,
  viewportWidth: number,
  viewportHeight: number
): DiagramTransform;

export function clampScale(scale: number): number;
```

---

## Expand Toggle

**Normal state:** Diagram sits inline within `.prose` content flow.

**Expanded state:** Container uses negative margins to break out of prose padding and fill the full preview scroll area width:

```css
.mermaid-container.expanded {
  position: relative;
  width: calc(100% + 2 * var(--prose-padding, 32px));
  margin-left: calc(-1 * var(--prose-padding, 32px));
}
```

- The expand icon toggles between ⤢ (expand) and ⤡ (collapse)
- Pan/zoom state is preserved across expand/collapse
- Viewport dimensions change → fit-to-view recalculates if user clicks fit after expanding

---

## Copy to PNG Pipeline (diagramCopy.ts)

1. Get the SVG element from the container DOM
2. Clone it and inline computed styles (Mermaid SVGs reference class-based styles)
3. Serialize to a Blob URL: `new Blob([outerHTML], {type:'image/svg+xml'})`
4. Create an offscreen `<canvas>` sized at 2× SVG intrinsic dimensions (retina)
5. Load into `new Image()`, draw with `ctx.drawImage(img, 0, 0, w*2, h*2)`
6. `canvas.toBlob('image/png')` → `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`
7. Flash the copy button green with a checkmark for 1.5s to confirm

**foreignObject fallback:** Mermaid SVGs use `<foreignObject>` with HTML for labels. The `drawImage` approach may fail due to cross-origin/taint restrictions on data URLs containing foreign content. If the canvas is tainted:
- Fallback: use `html-to-image` (or similar) library that renders via DOM serialization
- Or: invoke a Tauri command that uses a headless renderer (heavier, deferred to v1.1 if needed)

We'll try the simple canvas path first. If `foreignObject` causes taint errors, we add the fallback.

---

## Popout Window (Tauri Multi-Window)

### Rust IPC Command

```rust
#[command]
async fn open_diagram_window(
    app: AppHandle,
    svg: String,
    title: String,
) -> Result<(), IpcError>
```

- Creates a `WebviewWindow` via `WebviewWindowBuilder::new()`
- Window label: `diagram-{incrementing_id}` (supports multiple popouts)
- Title: `"Diagram — {title}"` (title derived from nearest heading or "Untitled")
- Default size: 800×600, resizable, no menu bar
- URL: `diagram-viewer.html` (bundled as a Tauri asset)
- Initialization script sets `window.__DIAGRAM_SVG__` and `window.__DIAGRAM_TITLE__`

### diagram-viewer.html

A standalone HTML page bundled with the Tauri app:

- Reads `window.__DIAGRAM_SVG__` on load
- Renders in a full-window viewport with the same `mc-canvas` transform approach
- Bottom-right controls: pan arrows, zoom in/out, fit to view
- No top-right controls (no copy/expand/popout — already in a dedicated window)
- Keyboard: arrow keys for pan, `+`/`-` for zoom, `0` for fit, `Esc` to close
- Matches the app's current theme via a `data-theme` attribute passed in the init script
- Self-contained — no imports from the main app bundle

### IPC Contract Update

Add to `ipc.rs`:
```rust
open_diagram_window(app: AppHandle, svg: String, title: String) -> Result<(), IpcError>
```

Add to `ipc.ts`:
```typescript
open_diagram_window: (svg: string, title: string) => Promise<void>;
```

---

## Integration with PreviewPane

### Current Mermaid Hydration Flow

```
renderMarkdown() → <div data-mermaid-pending> with escaped source
  → hydrateDynamicBlocks() finds [data-mermaid-pending]
  → renderMermaid(code) → sanitized SVG
  → div.innerHTML = svg; div.removeAttribute('data-mermaid-pending')
```

### New Post-Hydration Step

After `hydrateDynamicBlocks()` completes:

1. Query all `[data-block-type="mermaid"]:not([data-mermaid-pending])` divs
2. For each div that doesn't already have a MermaidContainer:
   - Extract `innerHTML` (the SVG) and `data-mermaid-src` (the source)
   - Clear the div's content
   - Mount `new MermaidContainer({ target: div, props: { svg, source, blockId } })`
   - Mark the div with `data-mc-mounted` to avoid double-mounting
3. Track mounted instances for cleanup

### On Re-render (content changes)

- Destroy all existing MermaidContainer instances (`component.$destroy()`)
- Run hydration → mount cycle again
- Pan/zoom state resets (the diagram content changed, so old state is meaningless)

### Interaction with Global Preview Zoom

The global preview zoom applies `transform: scale(N)` on the `.prose` article. MermaidContainer's per-diagram transform is nested inside. CSS transforms compose — the per-diagram transform operates in the already-scaled coordinate space. No conflict: global zoom scales everything uniformly, per-diagram zoom is relative to the container.

---

## Styling

### Theme Integration

All control buttons use the existing CSS variables:
- `--surface-2` for button backgrounds (with backdrop-filter blur)
- `--text` / `--text-muted` for icons
- `--accent` for hover highlights
- `--border` for container highlight on hover

### Button Style

```css
.mc-btn {
  width: 28px;
  height: 28px;
  background: color-mix(in srgb, var(--surface-2) 90%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: color 0.15s, background 0.15s;
}
.mc-btn:hover {
  color: var(--text);
  background: var(--surface-2);
}
```

### Hover Fade

```css
.mc-toolbar-top,
.mc-toolbar-bottom,
.mc-hint {
  opacity: 0;
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.mermaid-container:hover .mc-toolbar-top,
.mermaid-container:hover .mc-toolbar-bottom,
.mermaid-container:hover .mc-hint {
  opacity: 1;
  pointer-events: auto;
}
```

---

## Testing

### Unit Tests (diagramTransform.test.ts)

- `zoomAtPoint` — scale clamps to [0.25, 4.0], cursor stays fixed
- `pan` — translates correctly, no clamping (infinite pan is fine)
- `fitToView` — calculates correct scale for landscape, portrait, and square SVGs
- `fitToView` — never over-enlarges (caps at scale=1.0)
- `clampScale` — boundary values

### Unit Tests (diagramCopy.test.ts)

- SVG serialization produces valid blob
- Canvas dimensions are 2× intrinsic (retina)
- Clipboard write is called with image/png MIME type
- Error handling when canvas is tainted (foreignObject fallback path)

### IPC Contract Test Update

- Add `open_diagram_window` to the command list assertion in `ipc_contract.test.ts`

### Manual Verification

- Hover shows/hides controls smoothly
- Pan via drag, scroll, and buttons
- Zoom via Ctrl+scroll and buttons, cursor-anchored
- Fit-to-view on various diagram sizes (small, huge, landscape, portrait)
- Expand/collapse preserves zoom state
- Copy produces sharp PNG on clipboard
- Popout opens new window with diagram, pan/zoom works, Esc closes
- Multiple popouts from different diagrams simultaneously
- Global preview zoom + per-diagram zoom compose correctly
- Theme switch updates control colors

---

## Open Questions / Deferred

- **foreignObject PNG taint:** If the simple canvas pipeline fails for Mermaid SVGs with foreignObject labels, we'll add an `html-to-image` fallback. Deferred until we hit the issue.
- **Popout re-render on theme change:** The popout window gets the theme at creation time. Live theme switching in the popout is deferred — user can close and re-popout.
- **Touch gestures:** Pinch-to-zoom and two-finger pan are deferred (desktop app, not a priority).
