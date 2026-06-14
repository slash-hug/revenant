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
