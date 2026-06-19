# Revenant — Repo CLAUDE.md

Markdown viewer and review companion. Tauri 2 (Rust core) + Svelte 5 + TypeScript frontend.

---

## Build / verify commands

```sh
# Rust
cargo build --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
cargo test <module> --manifest-path src-tauri/Cargo.toml  # e.g. reanchor, file_io

# Frontend
npm install          # first time / after package.json changes (also wires the pre-push hook)
npm run build        # produces dist/
npm test             # Vitest (jsdom)
npm run check        # svelte-check — THE frontend type gate (tsc --noEmit does NOT check .svelte files)
npm run verify       # full frontend gate in one shot: check + test + build

# A pre-push hook (.githooks/pre-push, auto-installed by `npm install` via the "prepare"
# script) runs check + vitest before every push. `npx tsc --noEmit` alone is insufficient —
# it skips .svelte files entirely. See tasks/lessons.md (2026-06-19).

# Tauri
cargo tauri dev      # hot-reload dev server
cargo tauri build    # production installer

# Smoke check
revenant --version   # must print version after install
```

## Architecture overview

```
revenant/
├── src/                      # Svelte frontend (Vite)
│   ├── main.ts               # Svelte mount point
│   ├── App.svelte            # App shell — welcome screen + slot layout
│   ├── lib/
│   │   ├── types/ipc.ts      # Typed IPC contract (mirrors src-tauri/src/ipc.rs)
│   │   ├── TabManager.svelte # Tab open/close/switch (WS-C)
│   │   ├── EditorPane.svelte # CodeMirror 6 source editor (WS-C)
│   │   ├── PreviewPane.svelte# markdown-it render + DOMPurify + Mermaid (WS-C)
│   │   ├── AnnotationDrawer.svelte # Right-side annotation list (WS-C)
│   │   ├── ConflictModal.svelte    # Reload / Keep mine (WS-C)
│   │   ├── Toolbar.svelte    # View-mode toggle + Generate review (WS-C)
│   │   ├── ReviewExporter.ts # Formats agent-agnostic review markdown (WS-C)
│   │   ├── render/markdown.ts# markdown-it config + DOMPurify + lazy renderers (WS-C)
│   │   └── stores/           # Svelte stores: tabs.ts, annotations.ts (WS-C)
│   └── tests/                # Vitest tests
│       ├── setup.ts          # Tauri IPC mock
│       ├── ipc_contract.test.ts
│       └── *.test.ts         # WS-C adds review_exporter, annotations, etc.
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json       # CSP, WebView2 fixedRuntime, NSIS PATH hook
│   ├── capabilities/default.json  # Scoped ACL (no blanket fs)
│   └── src/
│       ├── main.rs           # Entry: single-instance + CLI wiring
│       ├── lib.rs            # Plugin init + generate_handler! registration
│       ├── ipc.rs            # IPC contract (commands + types) — FROZEN by WS-A
│       ├── file_io.rs        # Read/write + optimistic-concurrency + watcher (WS-B)
│       ├── annotations.rs    # Sidecar envelope + migrate-or-quarantine (WS-B)
│       ├── reanchor.rs       # Fuzzy re-anchoring (similar crate, ≥0.75) (WS-B)
│       ├── frontmatter.rs    # YAML frontmatter parse/merge (WS-B)
│       ├── paths.rs          # Path canonicalization + confinement (WS-B)
│       ├── settings.rs       # Versioned settings store (WS-D)
│       ├── secrets.rs        # OS keychain wrapper (keyring) (WS-D)
│       └── obsidian.rs       # REST client + fs fallback (WS-D)
├── .github/workflows/
│   ├── ci.yml                # macOS + Windows matrix: cargo test + npm test + build
│   └── release.yml           # Tag-triggered installer matrix
└── docs/                     # Design spec + implementation plan
```

## Key conventions

### IPC contract (ipc.rs / ipc.ts) — FROZEN
All IPC commands and types live in `src-tauri/src/ipc.rs` (Rust) and `src/lib/types/ipc.ts` (TS mirror). WS-A froze this surface. Do NOT add new commands without updating both files. Commands: `open_file`, `unwatch_file`, `save_file(expected_hash)`, `load_annotations`, `save_annotations`, `generate_review`, `export_obsidian`, `get_settings`, `set_settings`, `open_diagram_window`, `snapshot_webview`, `export_html`, `export_pdf`, `read_file_bytes`, `set_rest_key`, `clear_rest_key`, `has_rest_key`, `test_obsidian_connection`, `get_app_version`, `check_for_updates`, `open_release_page`. Events: `open_file_request`, `file_changed`.

### Module ownership
`lib.rs` is owned by WS-A only. WS-B/C/D fill their own module files; they never edit `lib.rs`. All `#[command]` registrations are in `lib.rs`.

### Schema versions
Both sidecar and settings envelopes carry `schema_version: 1`. Known older versions migrate in-place; unknown/newer versions are quarantined (renamed to `.bak`) with a warning — never discarded.

### Optimistic concurrency
`save_file` accepts `expected_hash` (sha256 hex). If the on-disk hash differs, it returns `HASH_MISMATCH` and does not write. The frontend surfaces a ConflictModal (Reload / Keep mine).

### Secrets
The Obsidian REST key is stored in the OS keychain via the `keyring` crate. Only `rest_key_ref` (an opaque reference string) is persisted in settings. NEVER commit or serialize the raw key.

### Security
- All fs ops go through the Rust core — no blanket webview ACL
- markdown-it output sanitized with DOMPurify before DOM injection
- Mermaid SVG output also sanitized
- Strict CSP in tauri.conf.json (allows eval/blob for Mermaid workers)

### Fuzzy re-anchoring
`reanchor.rs` uses the `similar` crate. Algorithm: content-hash short-circuit → probe stored line range → fuzzy match `context_before + quoted_text + context_after` with normalized similarity ≥ 0.75. Below threshold → status: detached. Tie-break: smallest line-distance, then earliest position.

### Agent-agnostic exports
Never hardcode "Claude", "Copilot", or any AI assistant name in review templates, button labels, or output. The "Generate review" button produces plain markdown that any agent can read.

### Annotation sidecars
Written next to the document: `<doc>.md.annotations.json`. On first annotation, an idempotent helper adds `*.annotations.json` to the nearest `.gitignore` (or `.git/info/exclude` if in a repo with no writable `.gitignore`).

### Windows PATH
The NSIS installer registers `revenant` on the system PATH. Users must open a new terminal after install. See README for the workaround.

## Workstream file ownership (no overlap)

| Workstream | Files |
|---|---|
| **WS-A (Foundation)** | `CLAUDE.md`, `.claude/**`, `.gitignore`, `README.md`, `package.json`, `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `vitest.config.ts`, `index.html`, `src/main.ts`, `src/App.svelte`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/ipc.rs`, `src/lib/types/ipc.ts`, `.github/workflows/**` |
| **WS-B (Rust data engine)** | `file_io.rs`, `annotations.rs`, `reanchor.rs`, `frontmatter.rs`, `paths.rs`, `src-tauri/src/tests/**` |
| **WS-C (Frontend)** | `TabManager.svelte`, `EditorPane.svelte`, `PreviewPane.svelte`, `AnnotationDrawer.svelte`, `ConflictModal.svelte`, `Toolbar.svelte`, `render/markdown.ts`, `ReviewExporter.ts`, `stores/tabs.ts`, `stores/annotations.ts`, `src/tests/*.test.ts` (except ipc_contract.test.ts) |
| **WS-D (Settings/Obsidian)** | `settings.rs`, `secrets.rs`, `obsidian.rs`, `src-tauri/src/tests/settings_tests.rs`, `src-tauri/src/tests/obsidian_tests.rs` |

## Recurring bug classes to avoid

See `tasks/lessons.md` (created as issues are discovered).

- **Secrets in config:** REST key must never appear in settings JSON. Only `rest_key_ref` stored.
- **Schema version missing:** Every sidecar/settings write must include `schema_version: 1`.
- **Blanket fs ACL:** Do not add broad fs permissions to `capabilities/default.json`. Rust core handles all I/O.
- **Hardcoded AI labels:** No "Claude", "Copilot", etc. in review output or UI strings.
- **Missing DOMPurify:** Never inject markdown-it or Mermaid output into the DOM without sanitizing first.
- **Single-instance forwarding edge cases:** Windows elevation / AV can interfere; validate on the actual Windows target.
- **HASH_MISMATCH not handled:** Always handle the conflict case in the frontend; never silently clobber.
- **ConnStatus is a dedicated IPC type:** The probe result enum (`ok`/`unauthorized`/`unreachable`) is defined in `ipc.rs` as a Serde type. Do NOT route it through `IpcError`/`obsidian_err()` — it is a success-typed result, not an error path.
- **set_rest_key/clear_rest_key must return Settings:** These commands return the updated `Settings` (not `()`) to avoid stale-store races where a subsequent `patchSettings` clobbers `rest_key_ref`.
- **dialog:allow-open is already granted:** `dialog:default` in `capabilities/default.json` includes `allow-open`. Do NOT add it explicitly — it is redundant and adds confusion.
- **In-memory probe key is transient:** `test_obsidian_connection(key?)` accepts an unsaved raw key for D6 probing. The key must never be logged, echoed back, or persisted inside this command.
