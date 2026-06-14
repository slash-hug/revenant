# Engineering lessons — Revenant

Repo-specific lessons. Append after any correction tied to this codebase.

## Build + unit tests passing ≠ the app launches (2026-06-13)

**What happened:** All four workstreams shipped with green `cargo build`,
`cargo test` (73), `npm test` (53), `svelte-check`, and `vite build`. None of
those ever *start the Tauri app*. The first real launch crashed instantly:
`tauri-plugin-cli` was registered with no `plugins.cli` block in
`tauri.conf.json` → `PluginInitialization("cli", invalid type: null, expected
struct Config)` panic before the window opened. A second abort lurks in tao's
macOS `didFinishLaunching` underneath it.

**Lesson:** For a desktop (Tauri) app, a green CI matrix proves the code
compiles and the logic units pass — it does **not** prove the binary boots.
A launch smoke test is a separate, mandatory gate.

**Rule:**
- Treat "the app actually launches and renders" as a required verification step,
  distinct from build/test. The review loop here approved an app that crashes on
  every launch because nothing ran it.
- Every Tauri plugin that needs config (`cli`, `updater`, …) must have its
  `plugins.<name>` block in `tauri.conf.json`, or it panics at startup. Adding a
  `.plugin(x::init())` line is not enough.
- `tauri.conf.json` is compiled into the binary via `generate_context!` — editing
  it requires a rebuild, not just a restart.
- When you can't run the native window (headless/remote/no Screen-Recording perms),
  you can still get a faithful UI smoke test + screenshots by rendering the Svelte
  frontend in headless chromium (Playwright `channel:'chrome'`) with a mocked
  `window.__TAURI_INTERNALS__.invoke`. See `docs/screenshots/` and the project memory.

## The macOS 26 launch crash was a zero-size placeholder icon (2026-06-14)

**What happened:** After fixing the cli-plugin panic, the app still aborted in
tao's `applicationDidFinishLaunching` with a non-unwinding panic and NO Rust
message. The missing message is the tell: it was a **foreign Objective-C
exception**, not a Rust panic. Caught under lldb (`breakpoint set -n
objc_exception_throw`, run, `expression -O -- (id)$x0`), the reason was:
`Cannot lock focus on image <NSImage … Size={0, 0}> because it is size zero.`
Root cause: the scaffolded `src-tauri/icons/icon.icns` was an **8-byte stub**
(and `icon.ico` was 1×1). macOS 26 (Tahoe) throws when AppKit renders the
zero-size Dock/app icon at launch; older macOS silently tolerated it.

**Fix:** regenerate real icons with `cargo tauri icon <1024² source.png>`.

**Rules:**
- Placeholder/zero-byte icons are a launch-blocker on macOS 26+. After scaffold,
  verify `file src-tauri/icons/icon.icns` is real (hundreds of KB, `ic08` type),
  not an 8-byte stub.
- Icon files are NOT tracked as Cargo build inputs — changing them does not
  trigger a rebuild. Force `tauri-build` to re-embed: `cargo clean -p <crate>`
  or `touch src-tauri/tauri.conf.json` before rebuilding.
- A non-unwinding panic ("panic in a function that cannot unwind") in a macOS
  delegate with no preceding Rust message = a thrown ObjC/C++ exception. Don't
  chase Rust code; catch the throw under lldb (`objc_exception_throw` /
  `__cxa_throw`) to get the real reason. (Here it sent us down a false
  `MainThreadMarker`/objc2 trail — tao#1171 — that wasn't our bug.)

## The open-transition document snapshot must come from the real renderer (2026-06-14)

**What happened:** The suminagashi open transition captured the document with
`html-to-image` (DOM → SVG `<foreignObject>` → `<img>` → canvas) to feed the GPU
ink reveal. On macOS the editor's JetBrains Mono "snapped" when the reveal handed
off to the live DOM. Root cause: **WebKit does not render `@font-face` fonts inside
the SVG-foreignObject rasteriser**, so the snapshot fell back to a system font.
Chromium / WebView2 render it correctly — which is exactly why it never reproduced
in the headless Chromium harness or on Windows. Fixed by capturing from the real
renderer: a native macOS `WKWebView.takeSnapshot` command (`src-tauri/src/snapshot.rs`,
objc2), with html-to-image kept as the cross-platform fallback.

Then a cascade of subtler artifacts, each pinned by a console diagnostic rather
than guesswork (the WKWebView font issue is invisible in the Chromium harness, so
visual judgment had to come from the user):
- **Ghosting** during the hand-off → the slow cross-fade overlapped two layers;
  replaced with a short crossfade / opaque hold.
- **Sharpness pop** → the fluid canvas was capped at 1.5× DPR while the live DOM
  renders at native 2×; render the transition canvas at native DPR.
- **Positional shift** → `takeSnapshot` returns the **webview BOUNDS**, which are
  ~32 CSS px TALLER than the layout viewport. The web content is **top-flush**
  (CSS origin = webview top-left, NO native title bar in the capture — proven by
  landmarking the accent-blue button: its snapshot row ÷ backing-scale == its live
  CSS top, so contentTopRow == 0); the excess is at the BOTTOM. Crop the bottom
  excess, keep the top `innerHeight × backingScale` rows. (Cropping the top was the
  bug that shoved the page up ~32px.)
- **End flash** → softening (blurring) the snapshot out during the dissolve made
  the canvas *brighter* (blurred paper-over-text is lighter). With pixel-perfect
  alignment the soften is unnecessary; a plain opacity crossfade between identical
  images is invisible.

**Rules:**
- Don't rasterise the DOM with html-to-image on WebKit/WKWebView when fonts matter
  — it silently drops `@font-face`. Use the platform's real snapshot
  (`WKWebView.takeSnapshot`); keep html-to-image only for Chromium/WebView2.
- The Chromium screenshot harness can't reproduce WKWebView-specific rendering
  (fonts, snapshot geometry). For those, instrument with `console.log` and have the
  human read it off `cargo tauri dev` — measuring beats guessing, especially for a
  taste/visual call you can't see headlessly.
- `WKWebView.takeSnapshot` (nil config) captures the webview **bounds**, not the
  CSS viewport, and includes no native chrome; content is top-flush. Map it to the
  live viewport by cropping the BOTTOM excess (`naturalHeight − innerHeight×scale`),
  derived from the snapshot's own backing scale so it survives a capped canvas DPR.
- **`WKWebView.takeSnapshot` does NOT composite the WebGL canvas layer** — it reads
  the live web content *underneath* an accelerated `<canvas>`. So for the open
  transition, keep the GL cover canvas **fully opaque the entire time** (`fillBackground`
  before the fonts/layout wait); the snapshot still captures the real `.ws` beneath it.
  The earlier code went *transparent* for the capture to "see `.ws` through" the
  canvas — that exposed the raw sharp doc for the whole fonts.ready + nextPaint +
  snapshot window = a visible flicker before the ink. Never reveal the canvas to
  snapshot; the WebGL layer is invisible to `takeSnapshot` regardless. (Confirmed
  2026-06-14: opaque-cover = zero flash + correct capture.)
- New IPC commands go in BOTH `ipc.rs` and `ipc.ts` (+ contract test) and are
  registered in `lib.rs`; macOS-only native deps go under
  `[target.'cfg(target_os = "macos")'.dependencies]`, pinned to the objc2 versions
  `wry` already locks so no extra crates enter the tree.

## Launch smoke gate is open after fd-lock + async annotation load (2026-06-14)

**Context:** WS-1/WS-2 hardening made `load_annotations` async, added a doc-read
to `save_annotations`, and introduced `fd-lock` (a new Cargo dependency using raw
OS file descriptors outside `tauri-plugin-fs`). All three verified green in
`cargo build` + `cargo test` + `npm test`, but none of those start the binary.

**Unconfirmed launch behaviour:** `cargo tauri dev` on macOS with the actual binary
has not been verified by a human since this round landed. Per the 2026-06-13 lesson,
green CI does NOT prove the binary boots. The async IPC handler, the doc-read in
`save_annotations`, and the `fd-lock` OS calls in particular must be exercised
under the real runtime — not just in unit tests — before declaring the round done.

**Rule:** After any round that changes Tauri async commands, adds new OS-level
dependencies (fd-lock, keyring, etc.), or touches the Tauri plugin list, run
`cargo tauri dev` and confirm the window opens before marking the round complete.
Flag this explicitly in the review so it is not silently deferred.

## The launch smoke caught what 88 green tests missed (2026-06-14)

WS-1 "made re-anchoring real" and shipped with 88 passing Rust tests — yet the
first real annotation (`"Randy"`, a word inside a longer line) **detached** on
reload. Cause: `probe_verbatim` matched **whole-line equality** (`lines[i] ==
quoted`), and *every* unit + integration test used whole-line quoted text
(`"line 2"`, `"match text"`). Real selections are sub-line words/phrases →
whole-line match fails → fuzzy scores the short needle against the long line
below 0.75 → detached. Fixed by matching single-line selections via **substring
containment**.

**Rules:**
- **Test fixtures must mirror real data.** Re-anchoring tests used whole-line
  selections; the common case (a word in a line) was never exercised. When a
  feature's tests all share an unrealistic shape, that shape is an untested gap.
- A green test matrix is not a substitute for the launch smoke on a real doc —
  this round it caught the re-anchor sub-line bug, the open-transition start
  flash, and two Mermaid rendering bugs, none visible to CI.
- **Sanitize Mermaid/SVG with DOMPurify's built-in profiles**
  (`USE_PROFILES: { svg: true, svgFilters: true, html: true }` + explicit
  `<style>`/`<foreignObject>`), not a hand-rolled tag/attr allowlist — a partial
  list silently strips the `<style>` theming (→ black nodes) and `foreignObject`
  labels. Keep that permissive config **scoped to Mermaid output only**; general
  markdown stays on the stricter config so a doc can't inject CSS/HTML.
- Mermaid bakes theme colors into the SVG at render time, so a cached diagram
  keeps its theme. Re-render on `<html data-theme>` change (MutationObserver) to
  follow light/dark; the stock 'dark' node fill (#1f2020) needs `mainBkg` lifted
  off the app's dark card for contrast.
