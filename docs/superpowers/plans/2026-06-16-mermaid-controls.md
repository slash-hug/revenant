# Mermaid Diagram Interactive Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub-style per-diagram pan/zoom controls, expand, copy-to-PNG, and popout-to-new-window to every rendered Mermaid diagram in the preview pane.

**Architecture:** Each Mermaid SVG gets wrapped in a `MermaidContainer` Svelte component (mounted imperatively after hydration) that provides CSS-transform-based pan/zoom with hover-revealed overlay controls. The popout opens a new Tauri OS window via an IPC command, loading a self-contained `diagram-viewer.html`. Pure transform logic is extracted into `diagramTransform.ts` for testability.

**Tech Stack:** Svelte 5 (runes), Tauri 2 (WebviewWindowBuilder), TypeScript, Vitest, CSS transforms, Canvas API (SVG→PNG copy)

**Spec:** `docs/superpowers/specs/2026-06-16-mermaid-controls-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/diagramTransform.ts` | Create | Pure pan/zoom/fit state logic (no DOM) |
| `src/tests/diagram_transform.test.ts` | Create | Unit tests for transform logic |
| `src/lib/diagramCopy.ts` | Create | SVG→PNG clipboard pipeline |
| `src/tests/diagram_copy.test.ts` | Create | Unit tests for copy pipeline |
| `src/lib/MermaidContainer.svelte` | Create | Interactive diagram wrapper component |
| `src/lib/PreviewPane.svelte` | Modify | Post-hydration MermaidContainer mounting |
| `src-tauri/src/ipc.rs` | Modify | Add `open_diagram_window` command |
| `src-tauri/src/lib.rs` | Modify | Register `open_diagram_window` handler |
| `src/lib/types/ipc.ts` | Modify | Add `openDiagramWindow` wrapper |
| `src/tests/ipc_contract.test.ts` | Modify | Add to command list assertion |
| `src-tauri/diagram-viewer.html` | Create | Standalone popout viewer page |
| `src-tauri/tauri.conf.json` | Modify | Register diagram-viewer.html pattern if needed |
| `src-tauri/capabilities/default.json` | Modify | Add diagram window to `windows` list |

---

### Task 1: diagramTransform.ts — Pure State Logic

**Files:**
- Create: `src/lib/diagramTransform.ts`
- Create: `src/tests/diagram_transform.test.ts`

- [ ] **Step 1: Write failing tests for clampScale**

Create `src/tests/diagram_transform.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  clampScale,
  zoomAtPoint,
  pan,
  fitToView,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_FACTOR,
  PAN_STEP,
  type DiagramTransform,
} from '$lib/diagramTransform';

describe('diagramTransform', () => {
  describe('clampScale', () => {
    it('clamps below minimum', () => {
      expect(clampScale(0.1)).toBe(ZOOM_MIN);
    });
    it('clamps above maximum', () => {
      expect(clampScale(10)).toBe(ZOOM_MAX);
    });
    it('passes through values in range', () => {
      expect(clampScale(1.5)).toBe(1.5);
    });
    it('clamps exactly at boundaries', () => {
      expect(clampScale(ZOOM_MIN)).toBe(ZOOM_MIN);
      expect(clampScale(ZOOM_MAX)).toBe(ZOOM_MAX);
    });
  });

  describe('pan', () => {
    it('adds dx and dy to current pan', () => {
      const t: DiagramTransform = { scale: 1, panX: 10, panY: 20 };
      const result = pan(t, 50, -30);
      expect(result).toEqual({ scale: 1, panX: 60, panY: -10 });
    });
    it('preserves scale', () => {
      const t: DiagramTransform = { scale: 2.5, panX: 0, panY: 0 };
      const result = pan(t, PAN_STEP, 0);
      expect(result.scale).toBe(2.5);
    });
  });

  describe('zoomAtPoint', () => {
    it('zooms in by ZOOM_FACTOR', () => {
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, 0, 0);
      expect(result.scale).toBeCloseTo(ZOOM_FACTOR);
    });
    it('zooms out by 1/ZOOM_FACTOR', () => {
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, -1, 0, 0);
      expect(result.scale).toBeCloseTo(1 / ZOOM_FACTOR);
    });
    it('clamps zoom to max', () => {
      const t: DiagramTransform = { scale: ZOOM_MAX, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, 100, 100);
      expect(result.scale).toBe(ZOOM_MAX);
    });
    it('clamps zoom to min', () => {
      const t: DiagramTransform = { scale: ZOOM_MIN, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, -1, 100, 100);
      expect(result.scale).toBe(ZOOM_MIN);
    });
    it('keeps the cursor point stable after zoom', () => {
      const cursorX = 200, cursorY = 150;
      const t: DiagramTransform = { scale: 1, panX: 0, panY: 0 };
      const result = zoomAtPoint(t, 1, cursorX, cursorY);
      // Point under cursor in canvas-space before: (200 - 0) / 1 = 200
      // Point under cursor in canvas-space after:  (200 - panX) / newScale
      // They should be equal:
      const canvasBefore = (cursorX - t.panX) / t.scale;
      const canvasAfter = (cursorX - result.panX) / result.scale;
      expect(canvasAfter).toBeCloseTo(canvasBefore);
    });
  });

  describe('fitToView', () => {
    it('scales landscape SVG to fit viewport width', () => {
      const result = fitToView(800, 200, 400, 300);
      expect(result.scale).toBeCloseTo(0.5); // 400/800
    });
    it('scales portrait SVG to fit viewport height', () => {
      const result = fitToView(200, 800, 400, 300);
      expect(result.scale).toBeCloseTo(0.375); // 300/800
    });
    it('never over-enlarges (caps at 1.0)', () => {
      const result = fitToView(100, 50, 800, 600);
      expect(result.scale).toBe(1.0);
    });
    it('centers the SVG in the viewport', () => {
      const result = fitToView(800, 200, 400, 300);
      // Scaled SVG: 400×100. Viewport: 400×300.
      // panX=0 (fills width), panY = (300 - 100) / 2 = 100
      expect(result.panX).toBeCloseTo(0);
      expect(result.panY).toBeCloseTo(100);
    });
    it('handles zero-size SVG gracefully', () => {
      const result = fitToView(0, 0, 400, 300);
      expect(result.scale).toBe(1.0);
      expect(result.panX).toBe(0);
      expect(result.panY).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run src/tests/diagram_transform.test.ts`
Expected: FAIL — module `$lib/diagramTransform` not found

- [ ] **Step 3: Implement diagramTransform.ts**

Create `src/lib/diagramTransform.ts`:

```typescript
/**
 * diagramTransform.ts — pure pan/zoom state logic for Mermaid diagram containers.
 *
 * No DOM dependencies. All functions take a DiagramTransform and return a new one.
 * Extracted for testability — MermaidContainer.svelte uses these to manage its
 * per-diagram viewport state.
 */

/** Zoom boundaries. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4.0;
/** Multiplicative zoom factor per step. */
export const ZOOM_FACTOR = 1.25;
/** Pixels per arrow-button pan click. */
export const PAN_STEP = 50;

export interface DiagramTransform {
  scale: number;
  panX: number;
  panY: number;
}

/** Identity transform — no zoom, no pan. */
export const IDENTITY: DiagramTransform = { scale: 1, panX: 0, panY: 0 };

/** Clamp a scale value to [ZOOM_MIN, ZOOM_MAX]. */
export function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/**
 * Zoom in (direction=1) or out (direction=-1) anchored to the cursor point.
 * The point under the cursor stays fixed after the zoom.
 */
export function zoomAtPoint(
  t: DiagramTransform,
  direction: 1 | -1,
  cursorX: number,
  cursorY: number,
): DiagramTransform {
  const factor = direction === 1 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const newScale = clampScale(t.scale * factor);
  if (newScale === t.scale) return t;

  // Keep the canvas point under the cursor fixed:
  // canvasPoint = (cursor - pan) / oldScale
  // newPan = cursor - canvasPoint * newScale
  const canvasX = (cursorX - t.panX) / t.scale;
  const canvasY = (cursorY - t.panY) / t.scale;
  return {
    scale: newScale,
    panX: cursorX - canvasX * newScale,
    panY: cursorY - canvasY * newScale,
  };
}

/** Translate by (dx, dy) pixels. No bounds clamping — infinite pan is allowed. */
export function pan(t: DiagramTransform, dx: number, dy: number): DiagramTransform {
  return { scale: t.scale, panX: t.panX + dx, panY: t.panY + dy };
}

/**
 * Calculate a transform that fits the SVG (svgW×svgH) into the viewport
 * (vpW×vpH), centered. Never over-enlarges — caps scale at 1.0.
 */
export function fitToView(
  svgW: number,
  svgH: number,
  vpW: number,
  vpH: number,
): DiagramTransform {
  if (svgW <= 0 || svgH <= 0) return { ...IDENTITY };
  const scale = Math.min(1.0, vpW / svgW, vpH / svgH);
  const scaledW = svgW * scale;
  const scaledH = svgH * scale;
  return {
    scale,
    panX: (vpW - scaledW) / 2,
    panY: (vpH - scaledH) / 2,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/tests/diagram_transform.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/diagramTransform.ts src/tests/diagram_transform.test.ts
git commit -m "feat: add diagramTransform pure state logic with tests"
```

---

### Task 2: diagramCopy.ts — SVG→PNG Clipboard Pipeline

**Files:**
- Create: `src/lib/diagramCopy.ts`
- Create: `src/tests/diagram_copy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tests/diagram_copy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { svgToBlob, copyDiagramAsPng } from '$lib/diagramCopy';

describe('diagramCopy', () => {
  describe('svgToBlob', () => {
    it('creates a Blob with SVG MIME type', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const blob = svgToBlob(svg);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/svg+xml;charset=utf-8');
    });

    it('includes xmlns if missing', () => {
      const svg = '<svg width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const blob = svgToBlob(svg);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('copyDiagramAsPng', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns false when clipboard API is unavailable', async () => {
      // jsdom doesn't provide navigator.clipboard
      const container = document.createElement('div');
      container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const result = await copyDiagramAsPng(container);
      expect(result).toBe(false);
    });

    it('returns false when no SVG element found', async () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>no svg here</p>';
      const result = await copyDiagramAsPng(container);
      expect(result).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run src/tests/diagram_copy.test.ts`
Expected: FAIL — module `$lib/diagramCopy` not found

- [ ] **Step 3: Implement diagramCopy.ts**

Create `src/lib/diagramCopy.ts`:

```typescript
/**
 * diagramCopy.ts — SVG→PNG clipboard pipeline for Mermaid diagram containers.
 *
 * Converts an SVG element to a PNG blob via an offscreen canvas, then writes
 * it to the clipboard. Uses 2× resolution for retina sharpness.
 *
 * foreignObject fallback: Mermaid SVGs may use <foreignObject> with HTML labels.
 * The canvas drawImage approach can fail with cross-origin taint errors for such
 * SVGs. In that case, copyDiagramAsPng returns false and the caller can show a
 * notification. A dom-to-image fallback can be added later if needed.
 */

/** Serialize an SVG string into a Blob suitable for loading into an Image. */
export function svgToBlob(svgMarkup: string): Blob {
  let markup = svgMarkup;
  if (!markup.includes('xmlns=')) {
    markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
}

/**
 * Extract the intrinsic size of an SVG from its width/height or viewBox.
 * Returns [width, height] in pixels. Falls back to bounding rect if attributes
 * are missing.
 */
function getSvgDimensions(svg: SVGSVGElement): [number, number] {
  const w = svg.width?.baseVal?.value;
  const h = svg.height?.baseVal?.value;
  if (w && h && w > 0 && h > 0) return [w, h];

  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return [parts[2], parts[3]];
    }
  }

  const rect = svg.getBoundingClientRect();
  return [rect.width || 400, rect.height || 300];
}

/**
 * Copy the first SVG found inside `container` as a PNG to the clipboard.
 *
 * Returns true on success, false on failure (no SVG, no clipboard API,
 * canvas tainted by foreignObject, etc.).
 */
export async function copyDiagramAsPng(container: HTMLElement): Promise<boolean> {
  const svg = container.querySelector('svg');
  if (!svg) return false;

  if (!navigator.clipboard?.write) return false;

  try {
    const [w, h] = getSvgDimensions(svg);
    const scale = 2; // retina

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));

    const blob = svgToBlob(clone.outerHTML);
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      img.width = w;
      img.height = h;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;

      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!pngBlob) return false;

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ]);
      return true;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run src/tests/diagram_copy.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/diagramCopy.ts src/tests/diagram_copy.test.ts
git commit -m "feat: add SVG-to-PNG clipboard pipeline for diagram copy"
```

---

### Task 3: IPC — open_diagram_window Command (Rust)

**Files:**
- Modify: `src-tauri/src/ipc.rs` (append command near end, before `snapshot_webview`)
- Modify: `src-tauri/src/lib.rs` (add to `generate_handler!`)
- Modify: `src-tauri/capabilities/default.json` (add diagram window identifier)

- [ ] **Step 1: Add `open_diagram_window` command to ipc.rs**

Append before the `snapshot_webview` command (around line 1010 in `ipc.rs`):

```rust
/// Open a rendered Mermaid diagram in a new OS window for focused viewing.
///
/// Creates a new WebviewWindow showing `diagram-viewer.html` with the SVG
/// injected via an initialization script. Supports multiple concurrent popouts
/// (window labels are `diagram-0`, `diagram-1`, etc.).
///
/// `svg` is the sanitized SVG markup. `title` is a human-readable label
/// derived from the nearest heading in the document (or "Untitled").
#[tauri::command]
pub async fn open_diagram_window(
    app: AppHandle,
    svg: String,
    title: String,
) -> IpcResult<()> {
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let label = format!("diagram-{}", id);

    // Escape the SVG and title for safe injection into a JS string literal.
    let svg_escaped = svg
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "");
    let title_escaped = title
        .replace('\\', "\\\\")
        .replace('\'', "\\'");

    let init_script = format!(
        "window.__DIAGRAM_SVG__ = '{}'; window.__DIAGRAM_TITLE__ = '{}';",
        svg_escaped, title_escaped
    );

    let window_title = if title.is_empty() {
        "Diagram".to_string()
    } else {
        format!("Diagram — {}", title)
    };

    tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("diagram-viewer.html".into()))
        .title(&window_title)
        .inner_size(800.0, 600.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .initialization_script(&init_script)
        .build()
        .map_err(|e| IpcError {
            code: "WINDOW_ERROR".to_string(),
            message: format!("Failed to create diagram window: {}", e),
        })?;

    Ok(())
}
```

- [ ] **Step 2: Register in lib.rs generate_handler!**

In `src-tauri/src/lib.rs`, add `ipc::open_diagram_window` to the `generate_handler!` macro, after `ipc::open_release_page`:

```rust
            ipc::open_release_page,
            // Diagram popout window
            ipc::open_diagram_window,
```

- [ ] **Step 3: Update capabilities/default.json**

In `src-tauri/capabilities/default.json`, add the diagram window label pattern to the `windows` list:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability granted to the main window. No blanket fs ACL — all file I/O is routed through Rust IPC commands (A7/C16). No shell permissions — the app never spawns OS processes from the webview. The dialog permission backs the welcome screen's native 'Open file…' picker and the Settings panel's vault directory picker (dialog:default already includes allow-open).",
  "windows": ["main", "diagram-*"],
  "permissions": [
    "core:default",
    "dialog:default",
    "dialog:allow-save"
  ]
}
```

The wildcard `diagram-*` matches all `diagram-0`, `diagram-1`, etc. windows.

- [ ] **Step 4: Verify Rust compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

Note: `cargo test` will have pre-existing failures in `paths::tests` — ignore those. The new command has no Rust-side test (it requires a running Tauri app context).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: add open_diagram_window IPC command for popout viewer"
```

---

### Task 4: IPC — TypeScript Contract Update

**Files:**
- Modify: `src/lib/types/ipc.ts`
- Modify: `src/tests/ipc_contract.test.ts`

- [ ] **Step 1: Add `openDiagramWindow` wrapper to ipc.ts**

Append before the version/update-check section comment (around line 395 in `ipc.ts`):

```typescript
// ---------------------------------------------------------------------------
// Diagram popout window
// ---------------------------------------------------------------------------

/**
 * Open a rendered Mermaid diagram in a new OS window for focused viewing.
 *
 * `svg` is the sanitized SVG markup. `title` is a human-readable label
 * (e.g. from the nearest heading). Multiple popouts can be open simultaneously.
 */
export function openDiagramWindow(svg: string, title: string): Promise<void> {
  return invoke<void>("open_diagram_window", { svg, title });
}
```

- [ ] **Step 2: Update ipc_contract.test.ts**

Add the import and assertion. In the imports (around line 29), add `openDiagramWindow`:

```typescript
  openDiagramWindow,
```

In the "exports all required command wrappers" test, add:

```typescript
    // Diagram popout window
    expect(typeof openDiagramWindow).toBe("function");
```

Add a new test case:

```typescript
  it("openDiagramWindow calls invoke with correct command name", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await openDiagramWindow('<svg>test</svg>', 'My Diagram');
    expect(mockInvoke).toHaveBeenCalledWith("open_diagram_window", {
      svg: '<svg>test</svg>',
      title: 'My Diagram',
    });
  });
```

- [ ] **Step 3: Run tests — verify they pass**

Run: `npx vitest run src/tests/ipc_contract.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/types/ipc.ts src/tests/ipc_contract.test.ts
git commit -m "feat: add openDiagramWindow to TS IPC contract"
```

---

### Task 5: MermaidContainer.svelte — The Interactive Wrapper

**Files:**
- Create: `src/lib/MermaidContainer.svelte`

This is the core component. It uses Svelte 5 runes syntax (`$state`, `$effect`, `onclick`, etc.) to match `App.svelte`.

- [ ] **Step 1: Create MermaidContainer.svelte**

Create `src/lib/MermaidContainer.svelte`:

```svelte
<script lang="ts">
  /**
   * MermaidContainer.svelte — interactive wrapper for rendered Mermaid diagrams.
   *
   * Wraps a sanitized SVG in a pan/zoom viewport with GitHub-style overlay
   * controls that appear on hover. Uses CSS transforms for pan/zoom, which
   * composes cleanly with the global preview zoom on .prose.
   *
   * Mounted imperatively by PreviewPane after Mermaid hydration via
   * `new MermaidContainer({ target, props })`.
   */
  import {
    type DiagramTransform,
    IDENTITY,
    zoomAtPoint,
    pan,
    fitToView,
    PAN_STEP,
    clampScale,
    ZOOM_FACTOR,
  } from './diagramTransform';
  import { copyDiagramAsPng } from './diagramCopy';
  import { openDiagramWindow } from './types/ipc';

  interface Props {
    svg: string;
    source: string;
    blockId: string;
  }

  let { svg, source, blockId }: Props = $props();

  let transform: DiagramTransform = $state({ ...IDENTITY });
  let expanded = $state(false);
  let hovering = $state(false);
  let copyFeedback = $state(false);

  let viewportEl: HTMLDivElement | undefined = $state(undefined);
  let canvasEl: HTMLDivElement | undefined = $state(undefined);

  // ── Dragging state ──────────────────────────────────────────────────────
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = transform.panX;
    dragStartPanY = transform.panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    transform = { ...transform, panX: dragStartPanX + dx, panY: dragStartPanY + dy };
  }

  function onPointerUp() {
    dragging = false;
  }

  // ── Scroll: pan or zoom ─────────────────────────────────────────────────
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = viewportEl?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      transform = zoomAtPoint(transform, e.deltaY < 0 ? 1 : -1, cx, cy);
    } else {
      transform = pan(transform, -e.deltaX, -e.deltaY);
    }
  }

  // ── Button handlers ─────────────────────────────────────────────────────
  function panUp()    { transform = pan(transform, 0, PAN_STEP); }
  function panDown()  { transform = pan(transform, 0, -PAN_STEP); }
  function panLeft()  { transform = pan(transform, PAN_STEP, 0); }
  function panRight() { transform = pan(transform, -PAN_STEP, 0); }

  function zoomIn() {
    const vp = viewportEl?.getBoundingClientRect();
    if (!vp) return;
    transform = zoomAtPoint(transform, 1, vp.width / 2, vp.height / 2);
  }

  function zoomOut() {
    const vp = viewportEl?.getBoundingClientRect();
    if (!vp) return;
    transform = zoomAtPoint(transform, -1, vp.width / 2, vp.height / 2);
  }

  function fit() {
    if (!viewportEl || !canvasEl) return;
    const svg = canvasEl.querySelector('svg');
    if (!svg) { transform = { ...IDENTITY }; return; }
    const vp = viewportEl.getBoundingClientRect();
    const svgW = svg.width?.baseVal?.value || svg.getBoundingClientRect().width || 400;
    const svgH = svg.height?.baseVal?.value || svg.getBoundingClientRect().height || 300;
    transform = fitToView(svgW, svgH, vp.width, vp.height);
  }

  function toggleExpand() {
    expanded = !expanded;
  }

  async function copyPng() {
    if (!canvasEl) return;
    const ok = await copyDiagramAsPng(canvasEl);
    if (ok) {
      copyFeedback = true;
      setTimeout(() => { copyFeedback = false; }, 1500);
    }
  }

  async function popout() {
    try {
      const nearestHeading = viewportEl
        ?.closest('.prose')
        ?.querySelector('h1, h2, h3')
        ?.textContent ?? '';
      await openDiagramWindow(svg, nearestHeading || 'Untitled');
    } catch (err) {
      console.warn('Failed to open diagram window:', err);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="mermaid-container"
  class:expanded
  onmouseenter={() => hovering = true}
  onmouseleave={() => hovering = false}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="mc-viewport"
    bind:this={viewportEl}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
    style="cursor: {dragging ? 'grabbing' : 'grab'};"
  >
    <div
      class="mc-canvas"
      bind:this={canvasEl}
      style="transform: translate({transform.panX}px, {transform.panY}px) scale({transform.scale}); transform-origin: 0 0;"
    >
      {@html svg}
    </div>
  </div>

  <!-- Top-right toolbar -->
  <div class="mc-toolbar mc-toolbar-top" class:visible={hovering}>
    <button class="mc-btn" title={expanded ? 'Collapse' : 'Expand full-width'} onclick={toggleExpand}>
      {#if expanded}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1L1 1 1 5M11 1l4 0 0 4M5 15l-4 0 0-4M11 15l4 0 0-4"/></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1H1v3M12 1h3v3M4 15H1v-3M12 15h3v-3"/></svg>
      {/if}
    </button>
    <button class="mc-btn" class:mc-btn-ok={copyFeedback} title="Copy as PNG" onclick={copyPng}>
      {#if copyFeedback}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l3 3 7-7"/></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="10" height="10" rx="2"/><path d="M2 12V2h10"/></svg>
      {/if}
    </button>
    <button class="mc-btn" title="Open in new window" onclick={popout}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="14" height="11" rx="2"/><path d="M1 6h14"/></svg>
    </button>
  </div>

  <!-- Bottom-right toolbar: pan + zoom -->
  <div class="mc-toolbar mc-toolbar-bottom" class:visible={hovering}>
    <div class="mc-nav-grid">
      <button class="mc-btn mc-nav-up" title="Pan up" onclick={panUp}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 6H3z"/></svg>
      </button>
      <button class="mc-btn mc-nav-zin" title="Zoom in" onclick={zoomIn}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4M7 5v4"/></svg>
      </button>
      <button class="mc-btn mc-nav-left" title="Pan left" onclick={panLeft}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8l6-5v10z"/></svg>
      </button>
      <button class="mc-btn mc-nav-fit" title="Fit to view" onclick={fit}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l4 4M14 2l-4 4M2 14l4-4M14 14l-4-4"/><rect x="5" y="5" width="6" height="6" rx="1"/></svg>
      </button>
      <button class="mc-btn mc-nav-right" title="Pan right" onclick={panRight}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13 8l-6-5v10z"/></svg>
      </button>
      <button class="mc-btn mc-nav-down" title="Pan down" onclick={panDown}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 13l5-6H3z"/></svg>
      </button>
      <button class="mc-btn mc-nav-zout" title="Zoom out" onclick={zoomOut}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4"/></svg>
      </button>
    </div>
  </div>

  <!-- Bottom-left hint -->
  <div class="mc-hint" class:visible={hovering}>
    Scroll to pan · Ctrl+scroll to zoom
  </div>
</div>

<style>
  .mermaid-container {
    position: relative;
    border: 1px solid transparent;
    border-radius: var(--r-md, 8px);
    transition: border-color 0.2s;
    margin: 16px 0;
  }
  .mermaid-container:hover {
    border-color: var(--border, rgba(255,255,255,0.1));
  }
  .mermaid-container.expanded {
    width: calc(100% + 64px);
    margin-left: -32px;
  }

  .mc-viewport {
    overflow: hidden;
    min-height: 100px;
    border-radius: var(--r-md, 8px);
  }
  .mc-canvas {
    will-change: transform;
  }

  /* Toolbar fade */
  .mc-toolbar, .mc-hint {
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  .mc-toolbar.visible, .mc-hint.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .mc-toolbar-top {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
  }

  .mc-toolbar-bottom {
    position: absolute;
    bottom: 8px;
    right: 8px;
  }

  .mc-nav-grid {
    display: grid;
    grid-template-columns: 28px 28px 28px;
    grid-template-rows: 28px 28px 28px;
    gap: 3px;
    /* Named grid areas for the d-pad + zoom layout */
    grid-template-areas:
      ".    up   zin"
      "left fit  right"
      ".    down zout";
  }
  .mc-nav-up    { grid-area: up; }
  .mc-nav-zin   { grid-area: zin; }
  .mc-nav-left  { grid-area: left; }
  .mc-nav-fit   { grid-area: fit; }
  .mc-nav-right { grid-area: right; }
  .mc-nav-down  { grid-area: down; }
  .mc-nav-zout  { grid-area: zout; }

  .mc-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: color-mix(in srgb, var(--surface-2, #2a2a3c) 90%, transparent);
    border: 1px solid var(--border, rgba(255,255,255,0.12));
    border-radius: 6px;
    color: var(--text-muted, #999);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
    transition: color 0.15s, background 0.15s;
  }
  .mc-btn:hover {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }
  .mc-btn-ok {
    color: #4ade80;
  }

  .mc-hint {
    position: absolute;
    bottom: 8px;
    left: 8px;
    font-size: 11px;
    color: var(--text-faint, rgba(255,255,255,0.35));
    font-family: system-ui, sans-serif;
    user-select: none;
  }
</style>
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/MermaidContainer.svelte
git commit -m "feat: add MermaidContainer interactive diagram wrapper"
```

---

### Task 6: PreviewPane — Post-Hydration MermaidContainer Mounting

**Files:**
- Modify: `src/lib/PreviewPane.svelte`

This task wires MermaidContainer into the existing hydration pipeline. After Mermaid blocks are rendered, a second pass wraps each in a MermaidContainer instance.

- [ ] **Step 1: Add MermaidContainer import**

At the top of the `<script>` block in `PreviewPane.svelte` (after the existing imports, around line 33), add:

```typescript
  import MermaidContainer from './MermaidContainer.svelte';
  import { mount, unmount } from 'svelte';
```

- [ ] **Step 2: Add container tracking and mount function**

After the `isHydrating` variable declaration (around line 83), add:

```typescript
  // Mounted MermaidContainer instances — tracked for cleanup on re-render.
  let mountedContainers: ReturnType<typeof mount>[] = [];

  /**
   * Post-hydration step: wrap each rendered Mermaid div in a MermaidContainer.
   * Called after hydrateDynamicBlocks() completes successfully.
   */
  function mountMermaidContainers() {
    if (!previewEl) return;

    // Destroy previous containers
    for (const instance of mountedContainers) {
      unmount(instance);
    }
    mountedContainers = [];

    const divs = previewEl.querySelectorAll<HTMLElement>(
      '[data-block-type="mermaid"]:not([data-mermaid-pending]):not([data-mc-mounted])',
    );

    for (const div of divs) {
      const svgContent = div.innerHTML;
      const source = decodeURIComponent(div.getAttribute('data-mermaid-src') ?? '');
      const blockId = div.dataset.blockId ?? '';

      if (!svgContent.includes('<svg')) continue;

      // Clear the div and mount MermaidContainer into it
      div.innerHTML = '';
      div.setAttribute('data-mc-mounted', '');

      const instance = mount(MermaidContainer, {
        target: div,
        props: { svg: svgContent, source, blockId },
      });
      mountedContainers.push(instance);
    }
  }
```

- [ ] **Step 3: Call mountMermaidContainers after hydration**

In the `hydrateDynamicBlocks()` function (around line 200, after the Mermaid `Promise.allSettled` block and before the code blocks section), add:

```typescript
      // Mount interactive containers on the hydrated Mermaid blocks
      mountMermaidContainers();
```

Also add it after `reRenderMermaidForTheme()` completes (inside that function, at the end around line 370):

```typescript
    // Re-mount containers after theme re-render
    mountMermaidContainers();
```

- [ ] **Step 4: Clean up containers on destroy**

In the `onDestroy` callback or at the end of the script, ensure containers are cleaned up. Find the existing `onDestroy` and add:

```typescript
  onDestroy(() => {
    // ... existing cleanup ...
    for (const instance of mountedContainers) {
      unmount(instance);
    }
    mountedContainers = [];
  });
```

If there's no existing `onDestroy`, add one.

- [ ] **Step 5: Verify build and tests pass**

Run: `npm run build && npm test`
Expected: Build succeeds, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/lib/PreviewPane.svelte
git commit -m "feat: mount MermaidContainer on hydrated diagrams in preview"
```

---

### Task 7: diagram-viewer.html — Standalone Popout Page

**Files:**
- Create: `src-tauri/diagram-viewer.html`

This is the standalone HTML page loaded by the popout window. It must be self-contained — no imports from the main app bundle. It reads `window.__DIAGRAM_SVG__` set by the initialization script.

Note: Tauri 2 resolves `WebviewUrl::App("diagram-viewer.html")` relative to the `frontendDist` directory (which is `../dist`). So this file needs to be copied into the `dist/` output during build, OR placed where Vite will include it. The simplest approach: put it in `public/diagram-viewer.html` so Vite copies it to `dist/` automatically.

- [ ] **Step 1: Create public/diagram-viewer.html**

Create `public/diagram-viewer.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Diagram Viewer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #1a1a2e;
      --surface: rgba(30, 30, 46, 0.9);
      --border: rgba(255, 255, 255, 0.12);
      --text: #cdd6f4;
      --text-muted: #888;
      --text-faint: rgba(255, 255, 255, 0.35);
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
      height: 100vh;
      user-select: none;
    }

    #viewport {
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      cursor: grab;
    }
    #viewport.dragging { cursor: grabbing; }

    #canvas {
      will-change: transform;
      transform-origin: 0 0;
    }

    /* Controls */
    .toolbar {
      position: fixed;
      bottom: 16px;
      right: 16px;
      display: grid;
      grid-template-columns: 32px 32px 32px;
      grid-template-rows: 32px 32px 32px;
      gap: 3px;
      grid-template-areas:
        ".    up   zin"
        "left fit  right"
        ".    down zout";
    }

    .btn {
      width: 32px;
      height: 32px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
      transition: color 0.15s, background 0.15s;
    }
    .btn:hover { color: var(--text); }

    .nav-up    { grid-area: up; }
    .nav-zin   { grid-area: zin; }
    .nav-left  { grid-area: left; }
    .nav-fit   { grid-area: fit; }
    .nav-right { grid-area: right; }
    .nav-down  { grid-area: down; }
    .nav-zout  { grid-area: zout; }

    .hint {
      position: fixed;
      bottom: 16px;
      left: 16px;
      font-size: 11px;
      color: var(--text-faint);
    }

    .title-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
      display: flex;
      align-items: center;
      padding: 0 12px;
      font-size: 12px;
      color: var(--text-muted);
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      -webkit-app-region: drag;
    }
  </style>
</head>
<body>
  <div class="title-bar" id="titleBar"></div>

  <div id="viewport">
    <div id="canvas"></div>
  </div>

  <div class="toolbar">
    <button class="btn nav-up" title="Pan up" onclick="panDir(0, 50)">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 6H3z"/></svg>
    </button>
    <button class="btn nav-zin" title="Zoom in" onclick="zoomCenter(1)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4M7 5v4"/></svg>
    </button>
    <button class="btn nav-left" title="Pan left" onclick="panDir(50, 0)">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8l6-5v10z"/></svg>
    </button>
    <button class="btn nav-fit" title="Fit to view" onclick="fitView()">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l4 4M14 2l-4 4M2 14l4-4M14 14l-4-4"/><rect x="5" y="5" width="6" height="6" rx="1"/></svg>
    </button>
    <button class="btn nav-right" title="Pan right" onclick="panDir(-50, 0)">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13 8l-6-5v10z"/></svg>
    </button>
    <button class="btn nav-down" title="Pan down" onclick="panDir(0, -50)">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 13l5-6H3z"/></svg>
    </button>
    <button class="btn nav-zout" title="Zoom out" onclick="zoomCenter(-1)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4"/></svg>
    </button>
  </div>

  <div class="hint">Scroll to pan · Ctrl+scroll to zoom · Arrow keys to pan · Esc to close</div>

  <script>
    const ZOOM_MIN = 0.25, ZOOM_MAX = 4.0, ZOOM_FACTOR = 1.25, PAN_STEP = 50;
    let scale = 1, panX = 0, panY = 0;
    let dragging = false, dsx = 0, dsy = 0, dpx = 0, dpy = 0;

    const viewport = document.getElementById('viewport');
    const canvas = document.getElementById('canvas');
    const titleBar = document.getElementById('titleBar');

    function clamp(s) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s)); }

    function applyTransform() {
      canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    function panDir(dx, dy) { panX += dx; panY += dy; applyTransform(); }

    function zoomAt(dir, cx, cy) {
      const f = dir === 1 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      const ns = clamp(scale * f);
      if (ns === scale) return;
      const canvasX = (cx - panX) / scale;
      const canvasY = (cy - panY) / scale;
      scale = ns;
      panX = cx - canvasX * scale;
      panY = cy - canvasY * scale;
      applyTransform();
    }

    function zoomCenter(dir) {
      zoomAt(dir, window.innerWidth / 2, window.innerHeight / 2);
    }

    function fitView() {
      const svg = canvas.querySelector('svg');
      if (!svg) { scale = 1; panX = 0; panY = 0; applyTransform(); return; }
      const w = svg.width?.baseVal?.value || svg.getBoundingClientRect().width || 400;
      const h = svg.height?.baseVal?.value || svg.getBoundingClientRect().height || 300;
      const vw = window.innerWidth, vh = window.innerHeight - 32;
      scale = Math.min(1.0, vw / w, vh / h);
      panX = (vw - w * scale) / 2;
      panY = 32 + (vh - h * scale) / 2;
      applyTransform();
    }

    // Drag to pan
    viewport.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      dragging = true; dsx = e.clientX; dsy = e.clientY; dpx = panX; dpy = panY;
      viewport.classList.add('dragging');
      viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener('pointermove', e => {
      if (!dragging) return;
      panX = dpx + e.clientX - dsx;
      panY = dpy + e.clientY - dsy;
      applyTransform();
    });
    viewport.addEventListener('pointerup', () => { dragging = false; viewport.classList.remove('dragging'); });
    viewport.addEventListener('pointercancel', () => { dragging = false; viewport.classList.remove('dragging'); });

    // Scroll: pan or zoom
    viewport.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = viewport.getBoundingClientRect();
        zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        panX -= e.deltaX; panY -= e.deltaY;
        applyTransform();
      }
    }, { passive: false });

    // Keyboard
    document.addEventListener('keydown', e => {
      switch (e.key) {
        case 'ArrowUp':    e.preventDefault(); panDir(0, PAN_STEP); break;
        case 'ArrowDown':  e.preventDefault(); panDir(0, -PAN_STEP); break;
        case 'ArrowLeft':  e.preventDefault(); panDir(PAN_STEP, 0); break;
        case 'ArrowRight': e.preventDefault(); panDir(-PAN_STEP, 0); break;
        case '+': case '=': e.preventDefault(); zoomCenter(1); break;
        case '-':           e.preventDefault(); zoomCenter(-1); break;
        case '0':           e.preventDefault(); fitView(); break;
        case 'Escape':      window.close(); break;
      }
    });

    // Init from injected globals
    function init() {
      const svg = window.__DIAGRAM_SVG__;
      const title = window.__DIAGRAM_TITLE__ || '';
      if (svg) {
        canvas.innerHTML = svg;
        titleBar.textContent = title || 'Diagram';
        document.title = title ? `Diagram — ${title}` : 'Diagram';
        requestAnimationFrame(() => fitView());
      } else {
        canvas.innerHTML = '<p style="padding:40px;color:#888;">No diagram data received.</p>';
      }
    }

    // __DIAGRAM_SVG__ is set by the Tauri initialization script, which runs
    // before DOMContentLoaded. By the time this inline script executes,
    // the global should already be available.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify the file is served by Vite**

Run: `npm run build`
Expected: `dist/diagram-viewer.html` exists in the output.

Verify: `Test-Path dist/diagram-viewer.html` should return True.

- [ ] **Step 3: Commit**

```bash
git add public/diagram-viewer.html
git commit -m "feat: add diagram-viewer.html for popout window"
```

---

### Task 8: Full Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all frontend tests**

Run: `npm test`
Expected: All tests pass (previous count was 354; new tests in Tasks 1-2 add ~15 more).

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: Build succeeds. Check that `dist/diagram-viewer.html` exists.

- [ ] **Step 4: Run Rust build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: Compiles without errors.

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: All tests pass except the 2 pre-existing `paths::tests` failures (unrelated).

- [ ] **Step 6: Manual smoke test with `cargo tauri dev`**

1. Open a markdown file that contains Mermaid diagrams
2. Hover over a diagram — controls should fade in
3. Test pan: drag the diagram, use scroll, use arrow buttons
4. Test zoom: Ctrl+scroll, use +/− buttons
5. Test fit: click the fit button — diagram should center
6. Test expand: click expand — diagram should fill width
7. Test copy: click copy — should flash green checkmark
8. Test popout: click popout — new window should open with the diagram
9. Test popout controls: pan/zoom/fit/keyboard in the popout window
10. Test Esc in popout: should close the popout window

- [ ] **Step 7: Commit any fixes, then push**

```bash
git push origin main
```

---

## Dependency Order

```
Task 1 (diagramTransform)  ──┐
                              ├──► Task 5 (MermaidContainer) ──► Task 6 (PreviewPane wiring)
Task 2 (diagramCopy)       ──┤                                        │
                              │                                        ▼
Task 3 (IPC Rust)          ──┤                                  Task 8 (Verification)
                              │
Task 4 (IPC TypeScript)    ──┘

Task 7 (diagram-viewer.html)  ──────────────────────────────► Task 8
```

- Tasks 1, 2, 3, 4, 7 can be done in parallel (no interdependencies)
- Task 5 depends on Tasks 1, 2, 4 (imports from all three)
- Task 6 depends on Task 5
- Task 8 depends on all previous tasks
