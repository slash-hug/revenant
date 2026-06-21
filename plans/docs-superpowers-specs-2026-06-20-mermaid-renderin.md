# Implementation Plan — Mermaid Rendering Quality + Zoom UX

**Spec (source of truth):** `docs/superpowers/specs/2026-06-20-mermaid-rendering-ux-design.md`
**Branch:** `feat/mermaid-rendering-ux`
**Status:** AWAITING HUMAN APPROVAL — resolve the conflicts in the next section before any code is written.

---

## 1. Header — Goal, Approach, Architecture Decisions

### Goal
Make inline Mermaid diagrams render like GitHub (natural size, fit-to-column, crisp, never upscaled), kill the ctrl+wheel / scroll-jacking collision, surface page zoom in a persistent bottom status bar, and delete the dead OS-popout window — without touching Mermaid theme colors, fonts, card framing, parsing, or the DOMPurify sanitization pipeline.

### Approach
Convert `MermaidContainer.svelte` from an always-on interactive mini-viewport into a **static, fit-to-width presenter** with a hover/focus control strip. Relocate the full pan/zoom/drag interaction into a **new in-app `MermaidLightbox.svelte`** rendered top-layer via native `<dialog>.showModal()`. Add a **new `PreviewStatusBar.svelte`** bound to the existing `previewZoom` store for discoverable page zoom. Remove the `handleZoomWheel` collision from `PreviewPane.svelte`. Atomically remove the frozen `open_diagram_window` IPC command and all dead popout assets.

### Architecture decisions (each tied to a research finding)

1. **Lightbox is a native `<dialog>` rendered top-layer via `showModal()`, NOT a fixed-position div.**
   - *Drivers:* [architecture] ".prose is CSS-scaled (PreviewPane.svelte:715); use native dialog showModal like ConflictModal.svelte:36" + [ux] focus-management finding (native `<dialog>` gives the browser focus trap and Esc/cancel for free, avoiding a collision with the three existing window-level keydown handlers — `handleAddCommentKeydown`, `handleZoomKeydown`, AnnotationDrawer Esc). A scaled `.prose` ancestor would otherwise distort a normally-positioned overlay; the top-layer escapes all stacking contexts and the `transform: scale()`.

2. **PreviewPane→Lightbox communication is via an `onExpand` callback prop passed to the imperatively-mounted `MermaidContainer`, plus PreviewPane-owned `$state` for "which diagram is open".**
   - *Driver:* [codebase] open risk — Svelte 5 `mount()` passes props down but gives no event bus back. A callback prop is the cleanest match to the spec's "PreviewPane owns which diagram is open" (§3) and is preferred over a shared store. MermaidContainer's expand button invokes `onExpand({ svg, source, blockId })`; PreviewPane sets its lightbox `$state` and renders one PreviewPane-level `<MermaidLightbox>`.

3. **Inline sizing uses pure CSS (`max-width:100%; height:auto`) and a separate `min(1.0, vpW/svgW)` calc — it NEVER calls `fitToView()`.**
   - *Drivers:* [ux] + [review-history] — `fitToView()` (diagramTransform.ts:71) caps at 2.0× upscale, intentionally raised in commit 0ef6d6e. The lightbox keeps that 2.0× behavior; the inline presenter must cap at 1.0 (never upscale, spec §1). They must not share a `fitToView` call. `diagramTransform.ts` itself is unchanged.

4. **Inline hover strip in-place zoom uses a local transform with a TIGHTER inline bound, not the lightbox's full ZOOM_MIN/MAX.**
   - *Driver:* [codebase] conflict #4 — spec says inline zoom is "bounded so the inline block stays reasonable" but no value given. **Recommended:** inline ±zoom clamps to `[1.0, 2.0]` (down-only fit + up to 2× in-place via the strip), the diagram block height grows with content, and `fit` returns to 1.0/fit-to-width. Full unbounded pan/zoom lives only in the lightbox. (Confirm in conflicts section.)

5. **Copy-as-PNG scale becomes `Math.max(window.devicePixelRatio || 1, 2)` (one-line change in diagramCopy.ts).**
   - *Drivers:* [architecture]/[review-history]/[codebase] — current hardcoded `scale=2` (diagramCopy.ts:59) satisfies the "minimum 2×" floor but under-samples on 3× Retina. Spec §5 intent.

6. **Frozen-IPC removal is ONE atomic commit across all 7 touch points** (ipc.rs command + `js_string_literal` helper + its 4 tests, lib.rs registration, ipc.ts wrapper, ipc_contract.test.ts entries, CLAUDE.md frozen list, capabilities/diagram.json, public/diagram-viewer.{html,js}).
   - *Drivers:* [review-history] TRAP (5-edit frozen-surface removal; precedent = 2026-06-14 stale FROZEN list lesson) + [architecture] (capabilities/diagram.json and js_string_literal+4 tests are dead too) + [review-history] (deleting diagram-viewer.html in a different commit than the Rust command → WebviewWindowBuilder panic on `cargo tauri dev`). All in WS-A.

7. **Lightbox receives the already-sanitized SVG STRING as a prop and `{@html}`s it once — it never harvests `div.innerHTML` from the DOM.**
   - *Driver:* [review-history] TRAP — re-harvesting from DOM or re-sanitizing breaks the renderMermaid()→sanitizeMermaidSvg()→prop chain. The lightbox must accept the same pre-sanitized string MermaidContainer already holds.

---

## 2. CONFLICTS & OPEN RISKS — FOR HUMAN DECISION (verbatim)

> The human must rule on each of these before implementation begins. Recommended resolution follows each item.

### ✅ HUMAN DECISIONS — RESOLVED 2026-06-20

All `DECISION NEEDED` items below are resolved; implementer follows these and does NOT re-raise:

1. **Inline upscale reversal (review-history, line ~79):** CONFIRMED — **inline never upscales (cap 1.0); lightbox keeps the 2.0× `fitToView` cap.** `diagramTransform.ts` and its test unchanged; inline uses `min(1.0, vpW/svgW)`.
2. **Inline hover-strip zoom bound (codebase conflict, line ~58):** CONFIRMED — **tight `[1.0, 2.0]`; `fit` returns to fit-to-width.** Unbounded pan/zoom is lightbox-only.
3. **Product/UX sign-off (line ~126):** CONFIRMED — ctrl+wheel page zoom is removed, and multiple OS popout windows are replaced by the single in-app lightbox. Both are the intended point of the feature.

All other "Recommended" resolutions in this section are accepted as the planner wrote them (callback prop for lightbox comms, native `<dialog showModal()>`, `Math.max(devicePixelRatio, 2)` copy-PNG, atomic 7-touch-point IPC removal, AppearanceSection helper-text update, KeyboardShortcutsModal zoom row).

### Spec conflicts (verbatim)

- **[codebase]** diagramCopy.ts uses a hardcoded scale=2 (line 59) rather than Math.max(2, window.devicePixelRatio) as the spec's §5 implies ('rasterizes at devicePixelRatio (minimum 2×)'). The spec adds a test asserting scale ≥ 2×, which the current code passes, but the devicePixelRatio adaptation the spec describes is not yet implemented and will need a code change to fully match the spec's stated intent.
  - **Recommended:** Implement `scale = Math.max(window.devicePixelRatio || 1, 2)` in diagramCopy.ts (WS-D, Task D-1). Matches §5 intent; test asserts ≥2×.

- **[codebase]** AppearanceSection.svelte helper text (line 43) reads 'Use Ctrl+scroll or Ctrl+Plus/Minus to adjust from the preview.' — after handleZoomWheel is removed the Ctrl+scroll reference becomes inaccurate. The spec does not explicitly call out updating this string, but it will be stale after the change.
  - **Recommended:** Update copy to "Use the zoom bar at the bottom of the preview, or Ctrl+Plus/Minus / Ctrl+0." (WS-C, Task C-6). Essential for source-mode zoom discoverability.

- **[codebase]** The spec says PreviewPane.svelte 'owns which diagram (if any) is open in the lightbox' (§3), but the lightbox open/close state will require a reactive variable and a way for MermaidContainer to signal PreviewPane... This communication channel is not spelled out in the spec and will need an architectural decision during implementation.
  - **Recommended:** `onExpand` callback prop on MermaidContainer + PreviewPane `$state` (Architecture decision #2). Reject shared-store option.

- **[codebase]** The spec says the inline MermaidContainer hover strip includes 'zoom −, zoom +, fit, copy PNG, expand' buttons (§2), but also says 'button-driven only; never grabs the wheel' and the zoom is 'bounded so the inline block stays reasonable'. The specific bound value and the transform state for inline zoom are not specified — the existing DiagramTransform/diagramTransform.ts (ZOOM_MIN=0.25, ZOOM_MAX=4.0) would be reused but whether a tighter inline bound applies is left to the implementer.
  - **Recommended:** Tighter inline bound `[1.0, 2.0]`, `fit` returns to fit-to-width (Architecture decision #4). Unbounded zoom is lightbox-only.

- **[ux]** Section 4 says 'Remove handleZoomWheel and the onwheel binding on .pv-scroll'. The AppearanceSection.svelte helper text for preview zoom currently reads: 'Use Ctrl+scroll or Ctrl+Plus/Minus to adjust from the preview.' This copy must also be updated or the setting description will describe a removed interaction.
  - **Recommended:** Same as above — Task C-6.

- **[ux]** Section 6 removes open_diagram_window from the CLAUDE.md frozen IPC command list, but CLAUDE.md itself is listed as WS-A ownership... the testing section (§ 'Rust') only mentions cargo build/test, not the CLAUDE.md update. The CLAUDE.md edit is a documentation change that must accompany the Rust removal — omitting it means the next developer sees an IPC command listed that no longer exists.
  - **Recommended:** CLAUDE.md edit is part of the single atomic WS-A IPC-removal commit (Task A-1).

- **[ux]** The spec states diagramTransform.ts is 'reused as-is by lightbox (no change expected)'. However, fitToView() in diagramTransform.ts (L71) applies a max upscale of 2.0... This contradicts Section 1's 'Never upscale' rule for the inline presenter... Inline sizing must use a different scale calculation (min(1.0, vpW/svgW)) that does not call fitToView(), not a shared call to the existing function.
  - **Recommended:** Inline = CSS `max-width:100%` + `min(1.0, vpW/svgW)`; lightbox = `fitToView()` unchanged (Architecture decision #3). diagramTransform.ts untouched.

- **[architecture]** Section 6 should also delete capabilities/diagram.json and js_string_literal plus its 4 tests.
  - **Recommended:** Add both to the WS-A atomic removal (Task A-1). Confirmed dead — only open_diagram_window uses them.

- **[architecture]** Section 3 must say the lightbox renders top-layer via native dialog showModal since .prose is scaled.
  - **Recommended:** Adopted (Architecture decision #1). Lightbox = native `<dialog showModal()>`.

- **[architecture]** Components table should add diagramCopy.ts (section 5 DPI) and note the inline presenter dropping pan/zoom handlers.
  - **Recommended:** diagramCopy.ts added to file map under WS-D; inline drop noted in Task C-1.

- **[review-history]** The spec says 'Never upscale (remove the current up-to-2x fit-scaling)' but commit 0ef6d6e deliberately raised the fitToView cap from 1.0 to 2.0... This is a RESOLVED design decision being reversed — the spec's author should be aware the prior cap change was intentional, not accidental.
  - **DECISION NEEDED:** Confirm the reversal is intended for the INLINE path only. **Recommended:** Inline never upscales (cap 1.0); lightbox keeps the 2.0× cap. The 0ef6d6e rationale ("small diagrams readable") still holds in the lightbox where the user opted in. No change to diagramTransform.ts or its test.

- **[review-history]** The spec says 'Copy-as-PNG rasterizes at devicePixelRatio (minimum 2x) instead of 1x.' Current diagramCopy.ts:58 uses hardcoded scale=2, not window.devicePixelRatio... Code needs to change to Math.max(window.devicePixelRatio || 1, 2) — the spec and code are not aligned here.
  - **Recommended:** Implement the one-line change (Task D-1).

### Open risks (verbatim)

- **[codebase]** Svelte 5 imperative mount/unmount pattern in PreviewPane.mountMermaidContainers() passes props to MermaidContainer but receives no events back... Options are: (a) pass an onExpand callback prop to MermaidContainer, (b) use a shared Svelte store for lightbox state... a callback prop is the cleanest match but needs explicit design.
  - **Recommended:** Option (a), callback prop (Architecture decision #2).

- **[codebase]** The diagram-viewer.html popout uses a separate Tauri WebviewWindow with its own CSP context... the js_string_literal() helper function (ipc.rs lines 1253–1259) is private to the open_diagram_window block — it should be deleted along with the command to avoid dead code, but implementers should verify no other command reuses it (currently none do).
  - **Recommended:** Delete js_string_literal + 4 tests in Task A-1; grep-verify zero other callers first.

- **[codebase]** tauri.conf.json has no dedicated CSP entry for the diagram-viewer window — it relies on the global app CSP. The lightbox being an in-app Svelte overlay means CSP concerns are unchanged. However, if any future work re-introduces an OS popout, the app-level CSP would need diagram-viewer-specific scoping.
  - **Recommended:** No action now; note for future. Lightbox stays under global CSP (no eval, DOMPurify-sanitized).

- **[codebase]** The spec removes the 'Scroll to pan · Ctrl+scroll to zoom' hint text from MermaidContainer (line 255–257)... but the card-level .mermaid-container hover border (line 267–270) is framing the spec says to keep. Care must be taken not to remove the border-color transition or card padding while stripping the viewport/toolbar chrome.
  - **Recommended:** Task C-1 explicitly preserves card border/background/padding (markdown.css:141–150) and removes only viewport/toolbar/hint chrome.

- **[codebase]** diagramTransform.ts fitToView() will continue to be used by the lightbox, but the existing test at diagram_transform.test.ts line 88 asserts the 2× upscale cap. If the spec ever relaxes the lightbox upscale cap... this test would need updating. No risk for the current spec.
  - **Recommended:** Leave diagram_transform.test.ts unchanged; it must stay green.

- **[codebase]** The spec lists CLAUDE.md as a file to update... this is a WS-A file. Under the module ownership rules, only WS-A may touch CLAUDE.md... WS-A must coordinate or handle the CLAUDE.md + ipc.rs + lib.rs + ipc.ts + public/ deletions as a separate atomic step.
  - **Recommended:** All IPC-removal edits are WS-A only, one atomic commit (Task A-1). WS-C never touches frozen/WS-A files.

- **[ux]** TOUCH / TRACKPAD INPUT: ...After the change, two-finger scroll over a diagram should scroll the page — this is the desired behavior — but it requires verification that no residual preventDefault() call in the new static MermaidContainer blocks natural page scroll.
  - **Recommended:** Task C-1 removes onWheel/preventDefault entirely; manual verification step (M-1) on trackpad.

- **[ux]** SVG INTRINSIC DIMENSIONS: ...some (particularly in Mermaid v11) output width='100%'... The inline static presenter must handle the width='100%' case explicitly... Manual testing with at least one flowchart, one sequence diagram, and one pie chart is needed.
  - **Recommended:** Task C-1 normalizes intrinsic width/height from viewBox when width is '100%' (reuse getSvgDimensions logic from diagramCopy.ts pattern); manual matrix M-2 (flowchart + sequence + pie).

- **[ux]** ANNOTATION SEAL RECOMPUTE: ...Adding the PreviewStatusBar as a fixed-height flex child of .preview-pane will change the effective height of .pv-scroll and trigger a seal recompute on every pane open. This is harmless but should be verified not to cause a visible flash.
  - **Recommended:** PreviewStatusBar is a fixed-height flex sibling of `.pv-scroll` (mirrors the existing `.banner` pattern, PreviewPane.svelte:695–701). Manual verify no seal flash (M-3).

- **[ux]** LIGHTBOX Z-INDEX STACKING: ...A lightbox implemented as a native <dialog showModal()> gets the browser's top-layer treatment, which sits above all z-index stacking contexts... if NOT a native dialog... it must use z-index above --z-toast (70).
  - **Recommended:** Native `<dialog>` (Architecture decision #1) — top-layer, no z-index math needed.

- **[ux]** KEYBOARD SHORTCUT DISCOVERY FOR PAGE ZOOM: After removing Ctrl+scroll, the only discoverable paths to page zoom are (a) the new bottom status bar, (b) Ctrl+±/Ctrl+0, (c) the Settings slider. The bottom bar is only visible in the preview pane — not in source-only view mode... the Settings slider remains the cross-mode zoom control, and the AppearanceSection helper text update is essential.
  - **Recommended:** Accept. Task C-6 (helper text) + Task C-7 (add zoom row to KeyboardShortcutsModal under "View").

- **[architecture]** Deleting js_string_literal needs its 4 tests deleted too (CI has no deny-warnings).
  - **Recommended:** Task A-1 deletes the 4 tests with the helper.

- **[architecture]** Lightbox must keep DOMPurify-sanitized injection; don't re-run Mermaid.
  - **Recommended:** Lightbox `{@html}`s the pre-sanitized prop once (Architecture decision #7). No Mermaid re-run, no re-sanitize, no DOM harvest.

- **[architecture]** Product/UX should ack: ctrl+wheel zoom removed and multi-popout becomes single-instance.
  - **DECISION NEEDED (product sign-off):** Confirm acceptable that (1) ctrl+wheel page zoom is gone and (2) multiple OS popout windows are replaced by a single in-app lightbox. **Recommended:** Accept both — they are the explicit point of the feature.

- **[review-history]** TRAP: IPC frozen-surface removal requires 5 simultaneous edits (ipc.rs, lib.rs, ipc.ts, ipc_contract.test.ts, CLAUDE.md) in one atomic commit. Missing any one leaves a broken reference. Precedent: 2026-06-14 'Stale FROZEN command list'.
  - **Recommended:** Task A-1 is a single atomic commit covering all 7 touch points (the 5 + capabilities/diagram.json + public/diagram-viewer.{html,js}).

- **[review-history]** TRAP: {@html svg}... If MermaidLightbox injects it a second time via innerHTML or {@html} without the same sanitized-prop guarantee (e.g. by re-fetching div.innerHTML from the DOM instead of the original prop), it reintroduces an unsanitized injection path. The lightbox must accept the pre-sanitized string as a prop.
  - **Recommended:** Architecture decision #7. Enforced in Task C-2.

- **[review-history]** TRAP: svelte-check is NOT gated by a pre-push hook... npm run check must be run explicitly before merge.
  - **Recommended:** `npm run check` is a mandatory verification gate in every WS-C task; pre-merge gate G-1.

- **[review-history]** TRAP: The new inline hover strip replaces the old always-visible d-pad/zoom grid. PR #65 fixed a 'visible || true' regression... The new strip must not reintroduce always-on chrome — hovering=$state(false) with class:visible={hovering} is the correct pattern.
  - **Recommended:** Task C-1 uses `hovering=$state(false)` + focus state; no `|| true`. Reviewer checklist item.

- **[review-history]** TRAP: reRenderMermaidForTheme() in PreviewPane replaces div.innerHTML... the re-mount logic must still correctly unmount old instances... If the old MermaidContainer teardown cancels the fitRaf/copyTimer but the new static presenter has its own effects, they must also be cleaned up.
  - **Recommended:** Task C-1 keeps `$effect` teardown for any remaining timers; Task C-3 keeps mountMermaidContainers unmount loop (PreviewPane.svelte:99–107) intact. Manual theme-switch verify M-4.

- **[review-history]** TRAP: Deleting public/diagram-viewer.html must happen in the same commit as removing open_diagram_window from ipc.rs and lib.rs... a mid-refactor state where the command exists but the file is gone is dangerous on cargo tauri dev.
  - **Recommended:** Task A-1 single atomic commit.

- **[review-history]** TRAP: The spec instructs keeping handleZoomKeydown (ctrl+± / ctrl+0) but removing handleZoomWheel and its onwheel binding. Both are in PreviewPane.svelte lines 660-680. Removing the wrong handler or leaving the onwheel binding accidentally will either silently break keyboard zoom or fail to fix the collision.
  - **Recommended:** Task C-4 removes ONLY handleZoomWheel (PreviewPane.svelte:661) + `onwheel={handleZoomWheel}` (line 705); explicitly keeps handleZoomKeydown + its window listener.

- **[review-history]** RISK: The macOS WKWebView sharpness lesson (2026-06-14) established that transform: scale() on .prose can soften text at non-100% zoom... Users may observe the blur side-effect more often and attribute it to the new feature. No code change is needed but a manual verification at 75% and 125% zoom is warranted.
  - **Recommended:** Manual verify M-5 at 75% / 125%. Note in PR that page-zoom blur is pre-existing and out of scope (spec §Risks).

- **[review-history]** RISK: New .svelte files... must not contain literal closing tag text '</'+'script>' or '</'+'style>' in comments — svelte2tsx mis-parses them.
  - **Recommended:** Reviewer checklist for Tasks C-2 and C-5; JSDoc rephrases any tag references.

- **[review-history]** RISK: The pre-push hook at .git/hooks/pre-push is absent... Confirm npm install has been run or manually install the hook before starting WS-C, otherwise svelte-check will not be enforced on push.
  - **Recommended:** Pre-flight gate G-0: run `npm install` (wires the prepare hook) before any WS-C work. If hook still absent, run `npm run check` manually as the gate.

---

## 3. File Map

### Create
- `src/lib/MermaidLightbox.svelte` (WS-C) — fullscreen native `<dialog>` overlay hosting full pan/zoom/fit/copy; relocated interaction logic.
- `src/lib/PreviewStatusBar.svelte` (WS-C) — bottom zoom control bound to previewZoom store.
- `src/tests/mermaid_lightbox.test.ts` (WS-C) — open/close + sanitized-prop tests.
- `src/tests/preview_status_bar.test.ts` (WS-C) — −/+/slider/clamp/reset tests.
- `src/tests/mermaid_inline_sizing.test.ts` (WS-C) — fit-to-width / 1:1 / never-upscale tests.

### Modify
- `src/lib/MermaidContainer.svelte` (WS-C) — static presenter + hover/focus strip; remove viewport/pan/wheel/popout; add onExpand prop.
- `src/lib/PreviewPane.svelte` (WS-C) — remove handleZoomWheel + onwheel binding; mount PreviewStatusBar; own lightbox state; render MermaidLightbox; pass onExpand to MermaidContainer.
- `src/lib/styles/markdown.css` (WS-C) — diagram block fit-to-width, no fixed-height, no upscale; preserve card framing/colors.
- `src/lib/settings/AppearanceSection.svelte` (WS-C) — update stale Ctrl+scroll helper text.
- `src/lib/KeyboardShortcutsModal.svelte` (WS-C) — add zoom shortcuts row under "View".
- `src/lib/diagramCopy.ts` (WS-D) — `scale = Math.max(window.devicePixelRatio || 1, 2)`.
- `src/tests/diagram_copy.test.ts` (WS-D) — assert scale ≥ 2× (spy on canvas/scale).
- `src-tauri/src/ipc.rs` (WS-A) — remove open_diagram_window command + js_string_literal helper + its 4 tests.
- `src-tauri/src/lib.rs` (WS-A) — remove registration.
- `src/lib/types/ipc.ts` (WS-A) — remove openDiagramWindow wrapper.
- `src/tests/ipc_contract.test.ts` (WS-A) — remove import (L32), typeof check (L69), test block (L312–320).
- `CLAUDE.md` (WS-A) — remove open_diagram_window from frozen list (L82).

### Delete
- `public/diagram-viewer.html` (WS-A)
- `public/diagram-viewer.js` (WS-A)
- `src-tauri/capabilities/diagram.json` (WS-A)

### Unchanged (verified) — do NOT touch
- `src/lib/diagramTransform.ts` (reused as-is by lightbox; inline does NOT call fitToView)
- `src/lib/stores/previewZoom.ts` (already exports all needed primitives)
- `src/tests/diagram_transform.test.ts` (must stay green)
- `src/lib/render/markdown.ts` (sanitization pipeline untouched)

---

## 4. Workstreams (ZERO file overlap)

| WS | Theme | Owns (exclusive) |
|---|---|---|
| **WS-A** | Frozen-IPC + dead-code removal (one atomic commit) | `src-tauri/src/ipc.rs`, `src-tauri/src/lib.rs`, `src/lib/types/ipc.ts`, `src/tests/ipc_contract.test.ts`, `CLAUDE.md`, `public/diagram-viewer.html`, `public/diagram-viewer.js`, `src-tauri/capabilities/diagram.json` |
| **WS-C** | Frontend UX: static presenter, lightbox, status bar, copy-removal, helper/shortcut text | `src/lib/MermaidContainer.svelte`, `src/lib/MermaidLightbox.svelte`, `src/lib/PreviewStatusBar.svelte`, `src/lib/PreviewPane.svelte`, `src/lib/styles/markdown.css`, `src/lib/settings/AppearanceSection.svelte`, `src/lib/KeyboardShortcutsModal.svelte`, `src/tests/mermaid_lightbox.test.ts`, `src/tests/preview_status_bar.test.ts`, `src/tests/mermaid_inline_sizing.test.ts` |
| **WS-D** | Sharpness — copy-PNG DPI | `src/lib/diagramCopy.ts`, `src/tests/diagram_copy.test.ts` |

> **Ordering / dependency:** WS-A and WS-D are independent and can run fully in parallel. **WS-C must land AFTER WS-A** because MermaidContainer.svelte (WS-C) removes the `import { openDiagramWindow } from './types/ipc'` caller; if WS-A removes the export first, WS-C's removal is clean. If run truly in parallel via worktrees, the merge order is A → D → C. WS-C does not touch any WS-A file (the openDiagramWindow *caller* is in MermaidContainer.svelte, which is WS-C's; only the *export* is WS-A's). Coordinate the merge so the export and caller disappear together.

---

## 5. Tasks

### WS-A — Frozen-IPC + dead-code removal

**A-1. Atomic removal of open_diagram_window and all dead popout assets.**
- Pre-check: `grep -rn "js_string_literal\|open_diagram_window\|openDiagramWindow\|diagram-viewer\|capabilities/diagram" src src-tauri public` — confirm the only caller of openDiagramWindow is MermaidContainer.svelte (handed to WS-C) and js_string_literal has no other caller.
- `src-tauri/src/ipc.rs`: delete the `open_diagram_window` command (lines ~1262–1313), the `js_string_literal` helper (~1253–1259), and its 4 unit tests (~1404+).
- `src-tauri/src/lib.rs`: remove `ipc::open_diagram_window` from `generate_handler!` (line ~284).
- `src/lib/types/ipc.ts`: remove the `openDiagramWindow` wrapper (lines ~415–417).
- `src/tests/ipc_contract.test.ts`: remove import (L32), typeof check (L69), and the test block (L312–320).
- `CLAUDE.md`: remove `open_diagram_window` from the frozen command list (L82).
- Delete `public/diagram-viewer.html`, `public/diagram-viewer.js`, `src-tauri/capabilities/diagram.json`.
- **Verify:**
  - `cargo build --manifest-path src-tauri/Cargo.toml` → builds with zero warnings (CI has no deny-warnings but warnings indicate residual dead code).
  - `cargo test --manifest-path src-tauri/Cargo.toml` → green.
  - `npm test` → ipc_contract.test.ts green; no reference to openDiagramWindow remains.
  - `npm run check` → no TS error for the removed wrapper.
  - `grep -rn "open_diagram_window\|openDiagramWindow\|diagram-viewer\|js_string_literal" src src-tauri public CLAUDE.md` → only hit allowed is the caller in MermaidContainer.svelte (removed in WS-C C-1). Expected: zero outside that file once C-1 lands.

### WS-D — Copy-PNG DPI

**D-1. Adaptive devicePixelRatio scale.**
- `src/lib/diagramCopy.ts`: change `const scale = 2` (line ~59) to `const scale = Math.max(window.devicePixelRatio || 1, 2);`.
- **Verify:** `npm run check` → clean.

**D-2. Test for scale ≥ 2×.**
- `src/tests/diagram_copy.test.ts`: add a test that spies on canvas dimensions / the scale applied and asserts the rasterization scale is `>= 2`. Mock `window.devicePixelRatio = 3` in one case and assert scale is 3; default case asserts scale is 2.
- **Verify:** `npm test` → diagram_copy.test.ts green. `npm run check` → clean.

### WS-C — Frontend UX

**C-1. Convert MermaidContainer.svelte to a static presenter.**
- Remove: `viewportEl`/`canvasEl`/`viewportHeight`, `computeViewportHeight()` (150px–70vh clamp), `onWheel` + its `preventDefault()`, drag/pan handlers, cursor-anchored zoom, the popout `import { openDiagramWindow }` + `popout()` (line ~165), and the `.mc-hint` "Scroll to pan · Ctrl+scroll to zoom" text (lines ~255–257).
- Render the sanitized `svg` prop via `{@html svg}` at intrinsic size; apply `max-width:100%; height:auto`. Normalize SVG intrinsic width/height from viewBox when width=='100%' (handle Mermaid v11). Down-only fit via `min(1.0, vpW/svgW)` — never call fitToView, never upscale.
- Add hover/focus control strip (`hovering=$state(false)` + focus handling; `class:visible={hovering || focused}`, NO `|| true`): zoom− / zoom+ (in-place, bound `[1.0, 2.0]`) / fit (→ fit-to-width) / copy PNG / expand. All buttons tab-reachable with tooltips; expand has a tooltip.
- Add `onExpand?: (d: { svg: string; source: string; blockId: string }) => void` to Props; expand button calls `onExpand({ svg, source, blockId })`.
- Keep `$effect` teardown for any remaining timers (copyTimer). Preserve card border/background/padding.
- **Verify:** `npm run check` → clean (watch for timer-type and svelte2tsx tag-in-comment errors). `npm test` → existing tests green.

**C-2. Create MermaidLightbox.svelte.**
- New native `<dialog>` opened via `showModal()`; closes on Esc/cancel, close button, backdrop click.
- Props: `svg: string` (pre-sanitized), `source`, `blockId`, `open: boolean`, `onClose: () => void`. `{@html svg}` ONCE from the prop — never harvest div.innerHTML, never re-sanitize, never re-run Mermaid.
- Host the relocated full pan/zoom/drag/cursor-anchored-zoom/fit using diagramTransform.ts (keep its 2.0× fitToView upscale). Copy-PNG button calls copyDiagramAsPng; on `false` return call `toast.show(...)` (failure path).
- Timers/rAFs typed `ReturnType<typeof setTimeout>`/number; `$effect` teardown. JSDoc must not contain literal closing script/style tags.
- **Verify:** `npm run check` → clean. (Test in C-8.)

**C-3. Wire lightbox state in PreviewPane.svelte.**
- Add `$state` for `lightboxDiagram: { svg, source, blockId } | null`. Pass `onExpand` callback into the imperatively-mounted MermaidContainer (props object in mountMermaidContainers). Render one `<MermaidLightbox>` at PreviewPane level bound to that state with `onClose` clearing it.
- Keep the existing unmount loop (lines 99–107) and reRenderMermaidForTheme path intact. Decide lightbox behavior on theme switch: close the lightbox on theme change (simplest; avoids stale SVG). 
- **Verify:** `npm run check` → clean. `npm test` → green.

**C-4. Remove ctrl+wheel collision in PreviewPane.svelte.**
- Delete `handleZoomWheel` (line ~661) and the `onwheel={handleZoomWheel}` binding on `.pv-scroll` (line ~705). Do NOT touch `handleZoomKeydown` or its window keydown listener.
- **Verify:** `npm run check` → clean. `grep -n "handleZoomWheel\|onwheel" src/lib/PreviewPane.svelte` → zero hits. `grep -n "handleZoomKeydown" src/lib/PreviewPane.svelte` → still present.

**C-5. Create PreviewStatusBar.svelte + mount it.**
- New component: layout `−  [slider]  +   100%`, bound to previewZoom store (`setZoom`/`adjustZoom`/`resetZoom`, `ZOOM_MIN`/`MAX`/`STEP`/`DEFAULT`, `clampZoom`). Mirror the AppearanceSection slider pattern.
- Mount in PreviewPane.svelte as a fixed-height flex sibling of `.pv-scroll` (mirror the `.banner` pattern, ~L695–701) so it does not scroll away and shrinks `.pv-scroll` correctly. Must not overlap Toast.
- **Verify:** `npm run check` → clean. (Test in C-9.)

**C-6. Update AppearanceSection.svelte helper text.**
- Replace line ~43 "Use Ctrl+scroll or Ctrl+Plus/Minus to adjust from the preview." with "Use the zoom bar at the bottom of the preview, or Ctrl+Plus/Minus / Ctrl+0."
- **Verify:** `npm run check` → clean. `grep -n "Ctrl+scroll" src/lib/settings/AppearanceSection.svelte` → zero hits.

**C-7. Add zoom shortcuts to KeyboardShortcutsModal.svelte.**
- Add rows under the "View" group: `Ctrl+=` zoom in, `Ctrl+-` zoom out, `Ctrl+0` reset zoom.
- **Verify:** `npm run check` → clean.

**C-8. Test MermaidLightbox.**
- New `src/tests/mermaid_lightbox.test.ts`: opens from `open=true`/expand; closes on Esc/backdrop/close; asserts injected SVG equals the passed (pre-sanitized) prop string, not DOM-harvested.
- **Verify:** `npm test` → green. `npm run check` → clean.

**C-9. Test PreviewStatusBar.**
- New `src/tests/preview_status_bar.test.ts`: −/+/slider drive previewZoom; clamps to ZOOM_MIN/MAX; reset returns to ZOOM_DEFAULT.
- **Verify:** `npm test` → green.

**C-10. Test inline sizing.**
- New `src/tests/mermaid_inline_sizing.test.ts`: fits-to-width when SVG wider than column; renders 1:1 when smaller; NEVER upscales (scale ≤ 1.0 inline).
- **Verify:** `npm test` → green.

### Cross-cutting gates

- **G-0 (pre-flight):** Run `npm install` to wire the prepare/pre-push hook before WS-C. If `.git/hooks/pre-push` still absent, treat `npm run check` as the manual mandatory gate.
- **G-1 (pre-merge):** `npm run verify` (check + test + build) green on the integrated branch. `cargo build` + `cargo test` green.

### Manual verification (post-merge, single sitting)
- **M-1:** Two-finger trackpad scroll over a diagram scrolls the page (no preventDefault residue).
- **M-2:** Inline render correct for flowchart + sequence diagram + pie chart (width='100%' handled).
- **M-3:** No annotation-seal flash when the status bar first renders.
- **M-4:** Theme switch with diagrams present re-mounts cleanly; open lightbox closes (or updates) without stale SVG.
- **M-5:** Page zoom at 75% and 125% — note any text blur is pre-existing `transform: scale()` behavior, out of scope.
- **M-6:** ctrl+wheel no longer zooms; bottom bar + ctrl+± + ctrl+0 do; Esc closes lightbox; copy-PNG failure shows a toast.
- **M-7:** `revenant --version` smoke check after Rust changes.

---

## 6. Out of Scope

- Mermaid theme variables, fonts, color palette, diagram card framing — explicitly unchanged (spec §Non-goals).
- markdown parsing, DOMPurify two-pass sanitization, Mermaid render/caching pipeline in `markdown.ts` — unchanged.
- Re-architecting page zoom to fix `transform: scale()` WKWebView text softening (spec §Risks acknowledges this is WebView-dependent and out of scope).
- Changing `diagramTransform.ts` or its `fitToView()` 2.0× cap / its test — the lightbox keeps the existing behavior.
- Re-introducing any OS-level popout window or per-window CSP scoping.
- Touch/pointer:coarse-specific affordances beyond ensuring buttons are tab/focus reachable (desktop Tauri app; hover works on trackpad).
- Adding a pre-push svelte-check hook (tracked separately; this plan only requires running `npm install` + manual `npm run check`).
