# Preview Zoom & Uncapped Reading Width — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSS-transform-based preview zoom (50–200%) with keyboard/scroll controls and settings persistence, and remove the 760px reading column cap.

**Architecture:** A Svelte writable store (`previewZoom`) initialized from `Settings.preview_zoom` drives a CSS `transform: scale()` on the `.prose` container. Keyboard and wheel handlers in PreviewPane adjust the store; a debounced persist function writes back via `patchSettings`. The settings panel gets a new slider row in AppearanceSection.

**Tech Stack:** Svelte 4 (stores, options-API components), Rust (serde struct), TypeScript, CSS transforms, Vitest

**Spec:** `docs/superpowers/specs/2026-06-16-preview-zoom-design.md`

---

### Task 1: Add `preview_zoom` to Rust Settings struct

**Files:**
- Modify: `src-tauri/src/settings.rs:21-55`

- [ ] **Step 1: Add the default function and field**

In `src-tauri/src/settings.rs`, add a default function before the `Settings` struct and a new field to the struct:

```rust
/// Default preview zoom percentage.
fn default_preview_zoom() -> u32 { 100 }
```

Add the field to the `Settings` struct, after `rest_key_ref`:

```rust
    /// Preview zoom level as a percentage (50–200). Default 100.
    #[serde(default = "default_preview_zoom")]
    pub preview_zoom: u32,
```

- [ ] **Step 2: Update the Default impl**

In the `Default` impl for `Settings`, add:

```rust
            preview_zoom: 100,
```

after the `rest_key_ref: None,` line.

- [ ] **Step 3: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: All existing tests pass (the new field with `serde(default)` is backward-compatible — existing JSON without the field deserializes to 100).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat: add preview_zoom field to Settings struct"
```

---

### Task 2: Add `preview_zoom` to TypeScript Settings interface and update IPC contract test

**Files:**
- Modify: `src/lib/types/ipc.ts:62-78`
- Modify: `src/tests/ipc_contract.test.ts:116-125` (Settings shape assertion)
- Modify: `src/tests/settings_panel.test.ts:34-43` (makeSettings helper)

- [ ] **Step 1: Add the field to the Settings interface**

In `src/lib/types/ipc.ts`, add a new field to the `Settings` interface after `rest_key_ref`:

```typescript
  /** Preview zoom percentage (50–200). Default 100. */
  preview_zoom: number;
```

- [ ] **Step 2: Update the IPC contract test Settings shape assertion**

In `src/tests/ipc_contract.test.ts`, find the `Settings` type shape assertion test (around line 116-125). Add `preview_zoom: 100,` to the `settings` object literal:

```typescript
    const settings: Settings = {
      schema_version: 1,
      vaults: [],
      default_export_subfolder: "reviews",
      theme: "dark",
      export_on_save: false,
      rest_key_ref: "obsidian-rest",
      preview_zoom: 100,
    };
```

- [ ] **Step 3: Update the settings_panel.test.ts makeSettings helper**

In `src/tests/settings_panel.test.ts`, add `preview_zoom: 100,` to the `makeSettings` helper (around line 34-43):

```typescript
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schema_version: 1,
    vaults: [],
    default_export_subfolder: 'reviews',
    theme: 'dark',
    export_on_save: false,
    rest_key_ref: null,
    preview_zoom: 100,
    ...overrides,
  };
}
```

- [ ] **Step 4: Search for any other Settings object literals in tests and update them**

Grep for `schema_version: 1` in `src/tests/` to find all Settings object literals. Every one must include `preview_zoom: 100`. The known locations are:

- `ipc_contract.test.ts` line ~117 (done in step 2)
- `ipc_contract.test.ts` line ~188 (`setRestKey` test) — add `preview_zoom: 100,`
- `ipc_contract.test.ts` line ~205 (`clearRestKey` test) — add `preview_zoom: 100,`
- `settings_panel.test.ts` line ~35 (done in step 3)

- [ ] **Step 5: Run frontend tests**

Run: `npm test`
Expected: All 339+ tests pass.

- [ ] **Step 6: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/types/ipc.ts src/tests/ipc_contract.test.ts src/tests/settings_panel.test.ts
git commit -m "feat: add preview_zoom to TS Settings interface and update tests"
```

---

### Task 3: Create previewZoom store

**Files:**
- Create: `src/lib/stores/previewZoom.ts`

- [ ] **Step 1: Create the store file**

Create `src/lib/stores/previewZoom.ts`:

```typescript
/**
 * previewZoom.ts — reactive preview zoom level store.
 *
 * Drives CSS transform: scale() on the .prose reading column.
 * Initialized from Settings.preview_zoom on app load; persisted via
 * debounced patchSettings on change.
 */

import { writable, get } from 'svelte/store';
import { settings, patchSettings } from './settings';

/** Zoom boundaries. */
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
export const ZOOM_DEFAULT = 100;

/** Clamp a raw value to the valid zoom range. */
export function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v / ZOOM_STEP) * ZOOM_STEP));
}

/** The preview zoom percentage (50–200). */
export const previewZoom = writable<number>(ZOOM_DEFAULT);

/**
 * Initialize zoom from loaded settings.
 * Called once after loadSettings() in the app startup path.
 */
export function initPreviewZoom(): void {
  const s = get(settings);
  if (s) {
    previewZoom.set(clampZoom(s.preview_zoom));
  }
}

// ---------------------------------------------------------------------------
// Debounced persistence
// ---------------------------------------------------------------------------

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DELAY_MS = 400;

function debouncedPersist(zoom: number): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void patchSettings({ preview_zoom: zoom });
    persistTimer = null;
  }, PERSIST_DELAY_MS);
}

/**
 * Set zoom to an absolute value (clamped). Persists to settings.
 */
export function setZoom(raw: number): void {
  const clamped = clampZoom(raw);
  previewZoom.set(clamped);
  debouncedPersist(clamped);
}

/**
 * Adjust zoom by a signed delta (e.g. +10 or -10). Persists to settings.
 */
export function adjustZoom(delta: number): void {
  setZoom(get(previewZoom) + delta);
}

/**
 * Reset zoom to 100%. Persists to settings.
 */
export function resetZoom(): void {
  setZoom(ZOOM_DEFAULT);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/stores/previewZoom.ts
git commit -m "feat: add previewZoom store with clamp and debounced persistence"
```

---

### Task 4: Write unit tests for previewZoom store

**Files:**
- Create: `src/tests/preview_zoom.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/tests/preview_zoom.test.ts`:

```typescript
/**
 * preview_zoom.test.ts — unit tests for the previewZoom store.
 *
 * Covers:
 *  - clampZoom clamps to 50–200 range and rounds to nearest step
 *  - setZoom / adjustZoom / resetZoom update the store correctly
 *  - initPreviewZoom reads from settings store
 *  - setZoom persists via patchSettings (debounced)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  previewZoom,
  clampZoom,
  setZoom,
  adjustZoom,
  resetZoom,
  initPreviewZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
  ZOOM_STEP,
} from '../lib/stores/previewZoom';
import { settings } from '../lib/stores/settings';

// Mock patchSettings to avoid IPC calls.
vi.mock('../lib/stores/settings', async () => {
  const actual = await vi.importActual<typeof import('../lib/stores/settings')>('../lib/stores/settings');
  return {
    ...actual,
    patchSettings: vi.fn().mockResolvedValue(undefined),
  };
});

import { patchSettings } from '../lib/stores/settings';
const mockPatch = vi.mocked(patchSettings);

beforeEach(() => {
  vi.useFakeTimers();
  previewZoom.set(ZOOM_DEFAULT);
  mockPatch.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// clampZoom
// ---------------------------------------------------------------------------

describe('clampZoom', () => {
  it('returns value unchanged when within range and on a step', () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(50)).toBe(50);
    expect(clampZoom(200)).toBe(200);
    expect(clampZoom(130)).toBe(130);
  });

  it('clamps below minimum to ZOOM_MIN', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(-10)).toBe(ZOOM_MIN);
    expect(clampZoom(30)).toBe(ZOOM_MIN);
  });

  it('clamps above maximum to ZOOM_MAX', () => {
    expect(clampZoom(250)).toBe(ZOOM_MAX);
    expect(clampZoom(210)).toBe(ZOOM_MAX);
  });

  it('rounds to nearest step', () => {
    expect(clampZoom(93)).toBe(90);
    expect(clampZoom(97)).toBe(100);
    expect(clampZoom(105)).toBe(110);
    expect(clampZoom(55)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// setZoom / adjustZoom / resetZoom
// ---------------------------------------------------------------------------

describe('setZoom', () => {
  it('sets the store to the clamped value', () => {
    setZoom(150);
    expect(get(previewZoom)).toBe(150);
  });

  it('clamps out-of-range values', () => {
    setZoom(999);
    expect(get(previewZoom)).toBe(ZOOM_MAX);
    setZoom(0);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });

  it('debounce-persists via patchSettings', () => {
    setZoom(120);
    // Not called immediately.
    expect(mockPatch).not.toHaveBeenCalled();
    // After debounce delay.
    vi.advanceTimersByTime(500);
    expect(mockPatch).toHaveBeenCalledWith({ preview_zoom: 120 });
  });

  it('coalesces rapid calls (only last value persists)', () => {
    setZoom(110);
    setZoom(120);
    setZoom(130);
    vi.advanceTimersByTime(500);
    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith({ preview_zoom: 130 });
  });
});

describe('adjustZoom', () => {
  it('increments by ZOOM_STEP', () => {
    previewZoom.set(100);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(110);
  });

  it('decrements by ZOOM_STEP', () => {
    previewZoom.set(100);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(90);
  });

  it('clamps at boundaries', () => {
    previewZoom.set(ZOOM_MAX);
    adjustZoom(ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MAX);

    previewZoom.set(ZOOM_MIN);
    adjustZoom(-ZOOM_STEP);
    expect(get(previewZoom)).toBe(ZOOM_MIN);
  });
});

describe('resetZoom', () => {
  it('resets to ZOOM_DEFAULT', () => {
    previewZoom.set(170);
    resetZoom();
    expect(get(previewZoom)).toBe(ZOOM_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// initPreviewZoom
// ---------------------------------------------------------------------------

describe('initPreviewZoom', () => {
  it('reads preview_zoom from settings store', () => {
    settings.set({
      schema_version: 1,
      vaults: [],
      default_export_subfolder: '',
      theme: 'system',
      export_on_save: false,
      rest_key_ref: null,
      preview_zoom: 140,
    });
    initPreviewZoom();
    expect(get(previewZoom)).toBe(140);
  });

  it('clamps invalid settings value', () => {
    settings.set({
      schema_version: 1,
      vaults: [],
      default_export_subfolder: '',
      theme: 'system',
      export_on_save: false,
      rest_key_ref: null,
      preview_zoom: 999,
    });
    initPreviewZoom();
    expect(get(previewZoom)).toBe(ZOOM_MAX);
  });

  it('uses default when settings store is null', () => {
    previewZoom.set(150);
    settings.set(null);
    initPreviewZoom();
    // Should remain unchanged (no settings loaded yet).
    expect(get(previewZoom)).toBe(150);
  });
});
```

- [ ] **Step 2: Run the new test**

Run: `npm test -- --reporter=verbose src/tests/preview_zoom.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass (340+).

- [ ] **Step 4: Commit**

```bash
git add src/tests/preview_zoom.test.ts
git commit -m "test: add unit tests for previewZoom store"
```

---

### Task 5: Remove `max-width: 760px` from `.prose`

**Files:**
- Modify: `src/lib/styles/markdown.css:19-27`

- [ ] **Step 1: Remove max-width from the .prose rule**

In `src/lib/styles/markdown.css`, change the `.prose` rule from:

```css
.prose {
  padding: 32px 44px 64px;
  font-family: var(--font-prose);
  max-width: 760px;
  color: var(--text);
  position: relative;
  z-index: 1;
}
```

to:

```css
.prose {
  padding: 32px 44px 64px;
  font-family: var(--font-prose);
  color: var(--text);
  position: relative;
  z-index: 1;
}
```

- [ ] **Step 2: Run frontend tests**

Run: `npm test`
Expected: All tests pass (no test depends on the 760px cap).

- [ ] **Step 3: Commit**

```bash
git add src/lib/styles/markdown.css
git commit -m "feat: remove 760px max-width cap from prose reading column"
```

---

### Task 6: Wire zoom transform into PreviewPane

**Files:**
- Modify: `src/lib/PreviewPane.svelte`

- [ ] **Step 1: Import the zoom store and helpers**

In `src/lib/PreviewPane.svelte`, add these imports near the top `<script>` block alongside the existing imports:

```typescript
  import {
    previewZoom,
    adjustZoom,
    resetZoom,
    ZOOM_STEP,
  } from './stores/previewZoom';
```

- [ ] **Step 2: Add a reactive zoom scale variable**

Add a reactive declaration in the script section (after the existing reactive declarations):

```typescript
  /** CSS scale factor derived from the zoom percentage store. */
  $: zoomScale = $previewZoom / 100;
```

- [ ] **Step 3: Apply the transform to the `.prose` article element**

Change the `<article class="prose">` element (around line 610) from:

```svelte
    <article class="prose">
```

to:

```svelte
    <article
      class="prose"
      style="transform: scale({zoomScale}); transform-origin: top left; width: calc(100% / {zoomScale});"
    >
```

- [ ] **Step 4: Add the Ctrl+scroll wheel handler**

Add a wheel event handler function in the script section (before the `</script>` closing tag, near the other event handlers):

```typescript
  /** Ctrl+scroll wheel → zoom in/out by ZOOM_STEP per notch. */
  function handleZoomWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    // deltaY < 0 = scroll up = zoom in; > 0 = scroll down = zoom out.
    adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }
```

Attach it to the `.pv-scroll` container. Change:

```svelte
    <div class="pv-scroll" bind:this={pvScrollEl}>
```

to:

```svelte
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="pv-scroll" bind:this={pvScrollEl} on:wheel={handleZoomWheel}>
```

- [ ] **Step 5: Add the Ctrl+Plus/Minus/0 keyboard handler**

Add a keyboard handler in the script section:

```typescript
  /** Ctrl+Plus / Ctrl+Minus / Ctrl+0 → zoom controls. */
  function handleZoomKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      adjustZoom(ZOOM_STEP);
    } else if (e.key === '-') {
      e.preventDefault();
      adjustZoom(-ZOOM_STEP);
    } else if (e.key === '0') {
      e.preventDefault();
      resetZoom();
    }
  }
```

Register and clean up the listener in the existing `onMount` block. The PreviewPane already has an `onMount` that registers `handleAddCommentKeydown`. Add the zoom handler alongside it.

In the existing `onMount` callback, change:

```typescript
  onMount(() => {
    window.addEventListener('keydown', handleAddCommentKeydown);
    window.addEventListener('mousedown', handleAffordanceDismiss);
    return () => {
      window.removeEventListener('keydown', handleAddCommentKeydown);
      window.removeEventListener('mousedown', handleAffordanceDismiss);
    };
  });
```

to:

```typescript
  onMount(() => {
    window.addEventListener('keydown', handleAddCommentKeydown);
    window.addEventListener('keydown', handleZoomKeydown);
    window.addEventListener('mousedown', handleAffordanceDismiss);
    return () => {
      window.removeEventListener('keydown', handleAddCommentKeydown);
      window.removeEventListener('keydown', handleZoomKeydown);
      window.removeEventListener('mousedown', handleAffordanceDismiss);
    };
  });
```

- [ ] **Step 6: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/PreviewPane.svelte
git commit -m "feat: wire preview zoom transform and keyboard/scroll handlers"
```

---

### Task 7: Initialize zoom from settings on app startup

**Files:**
- Modify: `src/App.svelte`

- [ ] **Step 1: Import initPreviewZoom**

In `src/App.svelte`, add this import alongside the existing settings import:

```typescript
  import { initPreviewZoom } from '$lib/stores/previewZoom';
```

- [ ] **Step 2: Call initPreviewZoom after loadSettings**

Find the existing call to `loadSettings()` in the app startup flow. It will be inside an `onMount` or an initialization block. Add `initPreviewZoom()` immediately after `loadSettings()` resolves.

Search for the pattern where `loadSettings` is called and add `initPreviewZoom()` after it. For example, if the pattern is:

```typescript
await loadSettings();
```

Change it to:

```typescript
await loadSettings();
initPreviewZoom();
```

- [ ] **Step 3: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/App.svelte
git commit -m "feat: initialize preview zoom from persisted settings on app start"
```

---

### Task 8: Add zoom slider to AppearanceSection in settings panel

**Files:**
- Modify: `src/lib/settings/AppearanceSection.svelte`

- [ ] **Step 1: Add the zoom slider control**

Replace the entire contents of `src/lib/settings/AppearanceSection.svelte` with:

```svelte
<script lang="ts">
  /**
   * AppearanceSection.svelte — Appearance settings section.
   *
   * Embeds <ThemeToggle> which is self-managed via the `theme.ts` store
   * (localStorage → `<html data-theme>`). This component MUST NOT call
   * `patchSettings` or touch `settings.theme` — the `settings.theme` field is
   * orphaned; `theme.ts` is the canonical source of truth (TRAP 3).
   *
   * Preview zoom: the slider drives `previewZoom` store → CSS transform on
   * `.prose` in PreviewPane. Changes persist via debounced patchSettings.
   *
   * Svelte 4 options-API to match the component library.
   */

  import ThemeToggle from '../ThemeToggle.svelte';
  import SettingGroup from './SettingGroup.svelte';
  import SettingRow from './SettingRow.svelte';
  import {
    previewZoom,
    setZoom,
    ZOOM_MIN,
    ZOOM_MAX,
    ZOOM_STEP,
  } from '../stores/previewZoom';

  function handleZoomInput(e: Event) {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!Number.isNaN(value)) setZoom(value);
  }
</script>

<SettingGroup label="Appearance">
  <SettingRow
    label="Theme"
    helper="Choose between light (Paper) and dark (Graphite) mode."
  >
    <ThemeToggle />
  </SettingRow>

  <SettingRow
    label="Preview zoom"
    helper="Scale the preview reading column. Use Ctrl+scroll or Ctrl+Plus/Minus to adjust from the preview."
  >
    <div class="zoom-control">
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={$previewZoom}
        on:input={handleZoomInput}
        aria-label="Preview zoom level"
        class="zoom-slider"
      />
      <span class="zoom-value">{$previewZoom}%</span>
    </div>
  </SettingRow>
</SettingGroup>

<style>
  .zoom-control {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .zoom-slider {
    width: 120px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .zoom-value {
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    min-width: 3.5ch;
    text-align: right;
  }
</style>
```

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/settings/AppearanceSection.svelte
git commit -m "feat: add preview zoom slider to settings panel"
```

---

### Task 9: Prevent zoom shortcuts from conflicting with App.svelte global shortcuts

**Files:**
- Modify: `src/App.svelte` (if needed)

- [ ] **Step 1: Verify no shortcut conflict**

Check the global keydown handler in `src/App.svelte` (the `handleGlobalKeydown` function). Verify that `Ctrl+0`, `Ctrl+=`, and `Ctrl+-` are NOT already bound.

The existing handler uses `Ctrl+1/2/3` for view modes and `Ctrl+K/O/,` for palette/open/settings. None of these conflict with the zoom keys `=`, `-`, `0` — **however**, `Ctrl+0` could conflict with view mode shortcuts if `0` were bound (it is not — only `1`, `2`, `3` are).

The zoom handler in PreviewPane is registered on `window` alongside the global handler. Because both listen on `window`, order matters. The PreviewPane handler calls `e.preventDefault()` when it matches, which does NOT `stopPropagation()` — but the App handler's `switch` on `e.key` does not match `=`, `-`, or `0` either, so no conflict exists.

No changes needed. Document this verification.

- [ ] **Step 2: Commit (if changes were needed)**

No commit needed for this task — it is a verification step only.

---

### Task 10: Final verification and push

**Files:** None (verification only)

- [ ] **Step 1: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: All Rust tests pass.

- [ ] **Step 2: Run frontend tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Manual smoke test (if app is runnable)**

Build and launch the app. Open a markdown file with Mermaid diagrams.

Verify:
1. Preview fills the available width (no 760px cap).
2. Ctrl+scroll wheel zooms preview in/out (10% steps).
3. Ctrl+Plus / Ctrl+Minus zoom in/out.
4. Ctrl+0 resets to 100%.
5. Open Settings → General → "Preview zoom" slider matches current level.
6. Move the slider — preview updates live.
7. Close and reopen app — zoom level persists.
8. Split mode: zoom affects preview only, editor unchanged.
9. Scroll sync still works at 150% zoom.
10. Export renders at 100% (open exported HTML and confirm normal scale).

- [ ] **Step 5: Push**

```bash
git push origin main
```
