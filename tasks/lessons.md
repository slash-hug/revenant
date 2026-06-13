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
