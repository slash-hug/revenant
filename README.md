# Revenant

A markdown viewer and **review companion** for the age of AI-written docs — Tauri 2 + Svelte 5 desktop app for macOS and Windows.

Open a markdown spec, plan, or draft; read it in source or rendered view; leave **anchored ink-seal annotations** that survive the document being rewritten; then export an **agent-agnostic `.review.md`** that any coding agent (Claude Code, Copilot CLI, …) can read back. It closes the human-in-the-loop review cycle over AI-generated markdown — without locking you to any one editor, agent, or OS.

## Screenshots

> The **Paper** (light) and **Graphite** (dark) themes — Geist · Literata · JetBrains Mono,
> teal-cyan annotation ink. Rendered from the live Svelte frontend; native window chrome omitted.

**Review workspace — source editor, live preview, and annotation drawer**

> ⚠️ **The two workspace shots below are being refreshed** — they predate the in-document seal
> markers, brush-wash highlight, command palette, and resizable panes.

![Revenant workspace, Paper theme](docs/screenshots/workspace-light.png)

**Ink-dissolution open transition** — a suminagashi (墨流し) GPU fluid simulation plays as the
first document opens: themed ink swirls across the page, then dissolves to reveal the document.

![Revenant suminagashi open transition](docs/screenshots/transition-light.png)

**Welcome screen**

![Revenant welcome screen](docs/screenshots/welcome-light.png)

**Graphite (dark) theme**

![Revenant workspace, Graphite theme](docs/screenshots/workspace-dark.png)

## Features

### Read & edit
- **Source editor** (CodeMirror 6) and **live preview** side-by-side, or either alone — Source / Split / Preview view modes
- Rendered markdown with **Mermaid diagrams**, **syntax highlighting** (highlight.js), tables, and frontmatter
- **Resizable panes** — drag the editor/preview split and the drawer width; both persist per device
- **Tabs** — open many documents; a single persistent instance (`revenant doc.md` in any terminal focuses the window and opens a new tab)
- **Drag-and-drop** `.md` files onto the window; native file picker and a **recent-files** list on the welcome screen

### Annotate & review
- **In-document ink-seal markers** — a brand-distinct suminagashi "seal" sits in the editor gutter and the preview margin for every annotation; the annotated span gets a **brush-wash highlight**
- **Drawer ⇄ document navigation** — click a seal to focus its comment in the drawer, or a drawer card to wash and scroll to its span
- **Anchored sidecar annotations** stored next to the document (`<doc>.md.annotations.json`) with **fuzzy re-anchoring** — comments stay pinned to their span after the document is edited; un-locatable comments are marked *detached*, never lost
- **Edit** a comment's body inline in the drawer; **undoable delete** (a toast offers Undo); whole-document **general notes**
- **Agent-agnostic review export** — "Generate review" writes a plain `<doc>.review.md` with no hardcoded AI-assistant names, ready for any agent to read
- **Export to Obsidian** — Local REST API, with a filesystem-copy fallback

### Get around fast
- **⌘K command palette** — fuzzy-searchable launcher over every action (open file, switch view, toggle drawer, generate review, export, jump to any comment, switch/close tab)
- **Keyboard model** — ⌘1/2/3 (Source/Split/Preview) · ⌘\ (drawer) · ⌘⇧R (generate review) · ⌘⌥M (add comment on selection) · ⌥↑/↓ (cycle comments) · ⌘O (open) · ⌘K (palette)
- **Conflict detection** — an external edit while you have unsaved changes surfaces a **Reload / Keep mine** modal; never a silent clobber

### Look & feel
- **Light / dark / system theme** — Paper (warm off-white) and Graphite (near-black) palettes on one token layer, persisted and synced live to the OS preference when set to "system"
- **Ink-dissolution open transition** — a dependency-free WebGL2 GPU fluid simulation (advection + curl + pressure) when the first document opens; `prefers-reduced-motion` safe
- **Status bar** — Saved / Unsaved state, abbreviated file path, line count, comment count, file type, encoding

## Prerequisites

- **macOS / Windows** — v1 targets; Linux is planned but untested
- **Rust** ≥ 1.77 — install via [rustup](https://rustup.rs/)
- **Node.js** ≥ 20 + **npm** ≥ 10 — the Tauri CLI ships as an npm dev dependency; no separate `cargo install` needed
- **Windows:** the installer uses the WebView2 **download bootstrapper** — WebView2 ships with Windows 11 and Windows 10 21H2+, and the bootstrapper fetches it on older builds. For locked-down or air-gapped machines, build the **fixed-version** variant (see [Locked-down Windows](#locked-down-windows-fixed-version-webview2))

## Install

### macOS — from source

```sh
git clone https://github.com/slash-hug/revenant.git
cd revenant
npm install
npm run tauri:build
# Installer at: src-tauri/target/release/bundle/dmg/revenant_*.dmg
```

### Windows — from source

```powershell
git clone https://github.com/slash-hug/revenant.git
cd revenant
npm install
npm run tauri:build
# Installer at: src-tauri\target\release\bundle\nsis\revenant_*_x64-setup.exe
```

> **Windows PATH note:** The NSIS installer registers `revenant` on the system PATH.
> Open a **new terminal session** after installation for the change to take effect.
> If `revenant` is still not found, run `revenant.exe` from its install directory once, or restart your terminal / IDE.

### Locked-down Windows (fixed-version WebView2)

The default installer relies on the WebView2 download bootstrapper. For machines with no internet
access or where IT policy blocks the bootstrapper, build an installer that **bundles a fixed
version** of the WebView2 runtime — no download at install time. This is opt-in (it adds ~180 MB),
so it lives in a config overlay (`src-tauri/tauri.windows-fixed.conf.json`) rather than the default build.

1. Download the **Fixed Version** runtime CAB (x64) from the
   [WebView2 download page](https://developer.microsoft.com/microsoft-edge/webview2/#download-section).
   The pinned version is `130.0.2849.80`; if you choose another, update the `path` in the overlay to match.
2. Expand it into `src-tauri/` so the folder name matches the overlay's `path` (PowerShell, from the repo root):

   ```powershell
   expand "Microsoft.WebView2.FixedVersionRuntime.130.0.2849.80.x64.cab" -F:* `
     "src-tauri\Microsoft.WebView2.FixedVersionRuntime.130.0.2849.80.x64"
   ```

3. Build with the overlay merged over the base config:

   ```powershell
   npm run tauri -- build --config src-tauri/tauri.windows-fixed.conf.json
   ```

The runtime folder is git-ignored (never committed). The base build and CI stay on the bootstrapper.

## Usage

```sh
# Open a file (creates or focuses the existing window)
revenant path/to/document.md

# Open multiple files
revenant README.md docs/spec.md

# Print version
revenant --version
```

Then: read in Source / Split / Preview (⌘1 / ⌘2 / ⌘3), select text and press **⌘⌥M** to leave a
comment, press **⌘⇧R** to write a `.review.md`, and press **⌘K** any time for the command palette.

## Development

```sh
npm install                                          # install JS dependencies
npm run tauri:dev                                     # Tauri dev server (hot-reload)

npm test                                              # frontend tests (Vitest)
npx tsc --noEmit                                      # TypeScript type check
npm run check                                         # svelte-check
cargo test --manifest-path src-tauri/Cargo.toml       # Rust tests

npm run tauri:build                                   # production build
```

See `CLAUDE.md` for the architecture, module ownership, and the frozen IPC contract.

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Svelte 5 + TypeScript + Vite |
| Desktop shell | Tauri 2 (Rust) |
| Editor | CodeMirror 6 |
| Markdown render | markdown-it + DOMPurify + Mermaid + highlight.js |
| Command palette | `CommandPalette.svelte` + `commandFilter.ts` — native `<dialog>`, fuzzy filter |
| Annotation markers | `AnnotationSeals.svelte` — suminagashi ink-seal gutter/margin markers + brush-wash highlight |
| Design tokens | `src/lib/styles/tokens.css` — semantic CSS custom properties; Paper (light) and Graphite (dark) on a single token layer |
| Theming | `src/lib/stores/theme.ts` + `ThemeToggle.svelte` — light / dark / system, OS media-query sync, persisted |
| Typography | Geist (UI) · Literata (prose) · JetBrains Mono (editor/code) — self-hosted offline via `@fontsource` (no CDN) |
| Open transition | `src/lib/fx/fluid.ts` + `Suminagashi.svelte` — WebGL2 GPU fluid simulation, dependency-free, `prefers-reduced-motion` safe |
| File picker / CLI | `tauri-plugin-dialog` (welcome "Open file…") · `tauri-plugin-cli` (`--version`, file args) |
| Annotation storage | JSON sidecar (`.md.annotations.json`) next to each document |
| Fuzzy re-anchoring | `similar` crate (Rust) — content-hash short-circuit + ≥0.75 normalized similarity |
| Obsidian export | Local REST API + filesystem fallback |
| Secrets | OS keychain via `keyring` crate (no plaintext REST keys) |

See `docs/` for the full design specs and implementation plans.

## Annotation sidecars and git

On first annotation, Revenant adds `*.annotations.json` to the nearest `.gitignore` so sidecars
never dirty `git status`. Review export files (`*.review.md`) are excluded too.

## Security

- **All file I/O goes through the Rust core.** The webview is granted only `dialog` and `core` capabilities — no filesystem or shell permissions — so it cannot read or write disk directly.
- **Path confinement** — writes (`save_file`, `export_obsidian`) are confined to the configured vault directories, with an explicit `..`-traversal guard layered over the lexical check.
- **Optimistic concurrency** — `save_file` requires the expected on-disk hash; a mismatch returns `HASH_MISMATCH` and writes nothing, surfacing the Reload / Keep-mine modal.
- **Sanitized rendering** — markdown-it and Mermaid output are run through DOMPurify (with a tighter Mermaid-scoped profile) before any DOM injection.
- **Secrets** — the Obsidian REST key lives only in the OS keychain; settings persist an opaque `rest_key_ref`, never the key. A release-build assertion rejects any settings JSON containing secret-shaped fields.
- **Strict CSP** — configured in `tauri.conf.json`, scoped for Mermaid's worker/lazy chunks.

## License

Not yet licensed for redistribution. © CodeLogiq.
