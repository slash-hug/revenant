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

## `tsc --noEmit` + `vite build` + `npm test` all pass while the app is broken — run `svelte-check` (2026-06-14)

**What happened:** The annotation-markers feature-implement round merged with a
green `tsc --noEmit`, `vite build`, and 114 passing Vitest tests — yet
`svelte-check` found 4 errors that would ship a broken feature:
- `AnnotationSeals.svelte`: a JS comment in the `<script>` contained the literal
  text `<style>` and `{@html <style>}`. `svelte2tsx`'s lightweight tag scanner
  (which svelte-check uses, but the real `svelte/compiler` parser and Vite's
  bundler do NOT) treated those literals as real tags, decided the `<script>`
  was "left open," and reported the component as having **no default export** —
  cascading into a `PreviewPane` import error. The component compiled and ran
  fine under Vite; only svelte-check caught it.
- `AnnotationDrawer.svelte`: the detached-section delete buttons still called the
  old 1-arg `requestDelete(id)` after the active section was changed to
  `(e, id)`. `tsc` doesn't typecheck the internals of `.svelte` files; svelte-check
  does — so the arity mismatch was invisible to `tsc --noEmit`.
- `import.meta.env.DEV` failed to typecheck because `tsconfig.types` is an
  explicit allowlist (`["vitest/globals","node"]`) that excluded `vite/client`.

**Rules:**
- **`svelte-check` is a required gate, distinct from `tsc --noEmit`.** `tsc`
  checks `.ts` files and the module graph but does NOT typecheck the contents of
  `.svelte` `<script>`/markup (arity, prop types, store call signatures).
  `vite build` doesn't typecheck at all. A round is not "green" until
  `svelte-check` is clean. The feature-implement workflow ran tsc+build+test but
  not svelte-check — add it to the verification set.
- **Never put `<style>`, `</script>`, or `{@html ...}` literals in a Svelte
  `<script>` comment.** `svelte2tsx`'s scanner mis-reads them as tags even though
  the real compiler tolerates them. Rephrase ("a dynamic style rule", "sanitized
  HTML injection") instead of writing the literal tag text.
- When `tsconfig.compilerOptions.types` is set, it's an exhaustive allowlist —
  using `import.meta.env` requires adding `"vite/client"` to it.

## Rendered DOM keeps source newlines; selection.toString() turns them into spaces (2026-06-14)

**What happened:** The annotation ink wash highlighted single-word selections
fine but **multi-line selections didn't highlight at all** in the preview (and only
partially in the editor). Cause: markdown-it keeps a paragraph's soft line-breaks
as literal `\n` characters in the rendered HTML text nodes, but the `quoted_text`
saved from `window.getSelection().toString()` has those breaks as **spaces**. So
`renderedText.indexOf(quoted_text)` fails for any span crossing a soft-wrapped
line. The editor had the same problem **plus** markdown delimiters: the source has
`` `revenant <file.md>` `` (backticks) where the rendered selection has plain
`revenant <file.md>`, so matching the rendered quote against the raw source fails
on two axes (whitespace + syntax).

**Rules:**
- When matching a **rendered** selection back to either the rendered DOM or the
  **source**, never use exact `indexOf`. Normalize whitespace (collapse all runs
  to a single space) on BOTH sides, and when matching against source markdown,
  also strip inline delimiters (`` ` `` `*` `_` `~`). Keep a normalized→original
  offset map so you can map the match back to real positions. See
  `annotationHighlight.findSpan(haystack, needle, stripMarkdown)`.
- Preview-created anchors are **coarse**: `handlePreviewMouseUp` stores
  `start_line` = the block's `data-source-line`, `char_start: 0`,
  `char_end: quoted_text.length` — these char offsets do NOT point at the real
  text. Treat `quoted_text` (via `findSpan`) as the source of truth for locating
  the span; the stored line/char is only a last-resort fallback.
- A green test suite can still miss this: every re-anchor/highlight test used
  single-line fixtures. Multi-line + inline-formatted spans are a distinct case —
  test them explicitly.

## A rectangle is a box, no gradient rescues it — re-imagine, don't tune (2026-06-14)

**What happened:** The annotation "wash" went through three failed visual rounds —
a flat translucent background (read as a highlighter box), a thin text-decoration
underline (`text-decoration-thickness` renders thin in WKWebView regardless of the
value), and a bottom-weighted gradient rect behind the text (still read as a
"misaligned highlight box"). Each was a *tuning* attempt on a fundamentally
box-shaped mark. The fix was to **re-imagine** the effect: a hand-inked SVG
**brush underline** (tapered, slightly irregular) — organic, on-brand (sumi ink),
and unmistakably "annotated."

**Rules:**
- The CSS Custom Highlight API (`::highlight()`) accepts only a limited property
  set — `color`, `background-color`, `text-decoration*`, `text-shadow`,
  `-webkit-text-stroke`. **No gradients, no border-radius, no background-image.**
  If the design needs an organic/gradient mark, the Highlight API can't do it;
  draw an SVG overlay (preview) or use an SVG `background-image` data-URI on a real
  element (the CodeMirror decoration span) instead.
- When a user pushes back on the same visual twice, stop tuning parameters and
  re-open the *concept* (a quick visual-companion comparison of 2-3 distinct
  directions beats a fourth tweak of the wrong one).
- One token drives a themed mark cleanly: `--ann-underline` (light/dark) for the
  SVG fill, plus `--ann-brush-img` / `--ann-brush-img-faint` data-URIs (color
  baked per theme) for the editor's background-image brush.

## WS-A Settings/IPC round: define cross-module types in the owner module (2026-06-14)

**What happened:** The plan called for `ConnStatus` to be defined in `obsidian.rs`
(WS-D's file) and imported into `ipc.rs` (WS-A's file). In a parallel-worktree
implementation the WS-D stub hadn't landed, so `ipc.rs` couldn't import from
`obsidian.rs`. The type was moved to `ipc.rs` (the IPC contract module) where it
logically belongs — it is a value that crosses the IPC seam, not an Obsidian
internal detail. `obsidian.rs` references `crate::ipc::ConnStatus`.

**Rule:** Types that cross the IPC boundary (serialized to/from the frontend)
belong in `ipc.rs`. Module-internal types (error variants, intermediate structs)
belong in their owning module. When a type appears in both a Rust module and the
TypeScript mirror, it belongs in `ipc.rs`.

## Stale FROZEN command list was never updated when export commands were added (2026-06-14)

**What happened:** `CLAUDE.md`'s FROZEN command list omitted `export_html`,
`export_pdf`, and `read_file_bytes` — commands already registered in `lib.rs`
since the export-commands round. The stale list was misleading: implementers
checking it before adding a command would think those three didn't exist.

**Rule:** Any time a new `#[tauri::command]` is registered in `lib.rs`, the FROZEN
command list in `CLAUDE.md` must be updated in the same commit. Treat the FROZEN
list as a source of truth for the IPC surface — a stale list is a bug.

## keyring is a Cargo crate, not a Tauri plugin — do not add plugins.keyring block (2026-06-14)

**What happened (anticipated):** The plan noted that a spurious `plugins.keyring`
block in `tauri.conf.json` would panic at startup. `keyring` is a pure Cargo
dependency (`secrets.rs`); it is not a Tauri plugin and needs no configuration entry.

**Rule:** Only Tauri plugins that implement `Plugin` + require config need a
`plugins.<name>` block. Cargo crates accessed via `use keyring::...` directly need
nothing in `tauri.conf.json`. When adding a new Cargo dependency, explicitly verify
whether it is a Tauri plugin before touching `tauri.conf.json`.

## set_settings is preserve-ref single-writer — never write rest_key_ref through the general path (2026-06-16)

**Context:** The `set_settings` IPC command was changed to call
`set_settings_preserving_ref` (WS-D) instead of the verbatim `set_settings`
pass-through. This enforces a single-writer discipline: only the key handlers
(`set_rest_key` / `clear_rest_key`) may write `rest_key_ref`; the general settings
path preserves whatever is on disk.

**Rule:** Never route a write that should change `rest_key_ref` through the general
`set_settings` IPC command. It will silently preserve the on-disk value. Use
`set_rest_key` / `clear_rest_key` to update the keychain reference. If a new code
path needs to clear or update `rest_key_ref` directly, it must call the verbatim
`crate::settings::set_settings` module fn (not the IPC command) or go through
`set_rest_key` / `clear_rest_key`.

## Keychain rollback double-failure: return original error, no retry (2026-06-16)

**Context:** `set_rest_key` first writes the key to the OS keychain, then writes
the updated settings to disk. If the settings write fails, the keychain entry is
deleted (rollback). If the rollback deletion also fails, both the keychain and
settings are in an inconsistent state — the keychain holds a key with no
corresponding `rest_key_ref` in settings (the "orphan" edge case).

**Rule:** On double-failure (settings write fails AND rollback delete fails), swallow
the rollback error via `let _ = delete_rest_key(...)` and return the ORIGINAL
settings-write error. Do NOT add a retry loop — the user can re-enter the key to
recover. Document the orphan edge case in a code comment so future readers
understand why the delete error is silently swallowed.

## Windows Credential Manager write→delete race requires real-hardware verification (2026-06-16)

**Context:** The keychain rollback in `set_rest_key` (delete the credential if the
settings write fails) involves a back-to-back write→delete in the same
`spawn_blocking` call. On macOS this is reliable. On Windows, Credential Manager
may race on back-to-back write→delete in rapid succession. The mock keychain used
in unit tests does not persist across `Entry::new()` calls, so the rollback path
cannot be fully tested without the real OS keychain.

**Rule:** Write the rollback test against the mock where possible (assert
`delete_rest_key` is invoked on the failure path via a forced settings-write error).
Mark the real-keychain Windows path as `#[ignore]` with a comment requiring manual
verification on real hardware before shipping. See `src-tauri/src/tests/settings_tests.rs`
D3 for the integration test pattern.

## A workflow shipped APPROVED with a NUL byte corrupting a source file (2026-06-16)

**What happened:** The #38 (callouts/wikilinks) feature-implement workflow returned
`APPROVED` after 3 review rounds with green gates, but had silently corrupted an
*unrelated* line in `src/lib/render/markdown.ts` — the hljs cache key `${lang} ${code}`
(a space) became `${lang}\x00${code}` (a raw NUL byte). esbuild/tsc tolerated the NUL,
so `tsc`, `svelte-check`, `npm test`, and the review agents all passed it. But the NUL
made the whole file register as **binary**: `file` reported "data", and `grep`/editors
bailed on it, which is how it was caught during pre-merge verification (greps for
`callout`/`wikilink` returned nothing on a file that clearly contained them).

**Rule:** "Green gates + APPROVED" does not prove a workflow-touched file is clean text.
Compilers tolerate sub-textual corruption (NUL bytes, BOMs, control chars) that breaks
tooling and editors. Before merging a workflow's output, run a byte/encoding sanity check
on the files it changed — e.g. `file <changed files>` (flag anything reporting "data"
instead of text) and/or a NUL scan (`grep -lP '\x00'` / `git diff --check`). Cheap, and
it catches a class of corruption that the normal gates structurally cannot.
