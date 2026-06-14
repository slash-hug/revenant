# Revenant

Markdown viewer and review companion — Tauri 2 + Svelte desktop app.

Open markdown files in tabs, edit source, preview rendered output side-by-side, leave anchored annotations, and export an agent-agnostic `.review.md` for any AI reviewer.

## Screenshots

> The "Paper" (light) and "Graphite" (dark) themes — Geist · Literata ·
> JetBrains Mono, steel-blue accent, blue-violet for detached annotations.
> Rendered from the live Svelte frontend; native window chrome omitted.

**Welcome screen**

![Revenant welcome screen](docs/screenshots/welcome-light.png)

**Review workspace — source editor, live preview, and annotation drawer (light)**

![Revenant workspace, Paper theme](docs/screenshots/workspace-light.png)

**Review workspace (dark)**

![Revenant workspace, Graphite theme](docs/screenshots/workspace-dark.png)

## Features

- Single persistent instance: `revenant doc.md` in any terminal focuses the existing window and opens a new tab
- Source editor (CodeMirror 6) + live preview with Mermaid diagrams and syntax highlighting
- Anchored sidecar annotations stored next to the document (`.md.annotations.json`)
- Conflict detection: external edits are surfaced with Reload / Keep mine options
- Export to Obsidian vault (Local REST API or filesystem copy fallback)
- Agent-agnostic review export — no hardcoded AI assistant names in output

## Prerequisites

- **macOS / Windows** — v1 targets; Linux may work but is untested
- **Rust** ≥ 1.77 — install via [rustup](https://rustup.rs/)
- **Tauri CLI** — `cargo install tauri-cli --version "^2"`
- **Node.js** ≥ 20 + **npm** ≥ 10
- **Windows:** WebView2 fixed-runtime bundled in the installer (no IT policy dependency)

## Install

### macOS — from source

```sh
git clone https://github.com/codelogiq/revenant.git
cd revenant
npm install
cargo tauri build
# Installer at: src-tauri/target/release/bundle/dmg/revenant_*.dmg
```

### Windows — from source

```powershell
git clone https://github.com/codelogiq/revenant.git
cd revenant
npm install
cargo tauri build
# Installer at: src-tauri\target\release\bundle\nsis\revenant_*_x64-setup.exe
```

> **Windows PATH note:** The NSIS installer registers `revenant` on the system PATH.
> You must open a **new terminal session** after installation for the PATH change to take effect.
> If `revenant` is still not found, run `revenant.exe` from its install directory once, or restart your terminal / IDE.

## Usage

```sh
# Open a file (creates or focuses the existing window)
revenant path/to/document.md

# Open multiple files
revenant README.md docs/spec.md

# Print version
revenant --version
```

## Development

```sh
# Install JS dependencies
npm install

# Start Tauri dev server (hot-reload)
npm run tauri:dev

# Run frontend tests
npm test

# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Production build
npm run tauri:build
```

## Architecture

| Layer | Technology |
|-------|-----------|
| Frontend | Svelte 5 + TypeScript + Vite |
| Desktop shell | Tauri 2 (Rust) |
| Editor | CodeMirror 6 |
| Markdown render | markdown-it + DOMPurify + Mermaid + highlight.js |
| Annotation storage | JSON sidecar (`.md.annotations.json`) next to each document |
| Fuzzy re-anchoring | `similar` crate (Rust) — content-hash short-circuit + ≥0.75 normalized similarity |
| Obsidian export | Local REST API + filesystem fallback |
| Secrets | OS keychain via `keyring` crate (no plaintext REST keys) |

See `docs/` for the full design spec and implementation plan.

## Annotation sidecars and git

On first annotation, Revenant adds `*.annotations.json` to the nearest `.gitignore`
so sidecars never dirty `git status`. Review export files (`*.review.md`) are also excluded.

## Security

- All file I/O goes through the Rust core — the webview has no blanket filesystem ACL
- Markdown output is sanitized with DOMPurify before injection into the preview
- Obsidian REST API key stored in the OS keychain, never in config JSON
- Strict Tauri CSP configured for Mermaid compatibility
