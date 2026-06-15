# Revenant — Version display, Check-for-updates, and Windows release pipeline

**Status:** Approved design — ready for `feature-research` → `feature-implement` (code), plus manual release ops
**Date:** 2026-06-15
**Tier:** Tier-2 (new section component + 3 IPC commands + new plugin dep + CI/config edits + tests)
**Repo:** `slash-hug/revenant`

---

## 1. Problem / Goal

Revenant ships no version surface and has never produced an installable build. The
primary goal is concrete: **a working, installable Windows `.exe` so the app can be used
on a real Windows machine**, plus an in-app way to see the current version and learn when
a newer release exists.

The release pipeline (`.github/workflows/release.yml`) is already scaffolded
(tag-triggered `v*`, macOS + Windows matrix via `tauri-action`, uploads `.dmg`/`.exe`,
creates a **draft** release) but has never run — the repo is private and Actions billing
is unfunded. Making the repo public unblocks free Actions minutes.

## 2. Resolved decisions

| Decision | Choice | Rationale |
|---|---|---|
| Update mechanism | **Lightweight GitHub-Releases check** | One Rust IPC call to the public Releases API; no signing keys, no auto-install, no update manifest. Clean upgrade path to the full `tauri-plugin-updater` later. |
| Release platforms (now) | **Windows-only** | The stated need. macOS runners can be re-added to the matrix in one line later. |
| Code signing | **Unsigned** | Personal use. Windows SmartScreen shows an "unknown publisher" prompt (More info → Run anyway); zero cost/setup. Defer signing until external users. |
| Check timing | **Manual button only** | No network call unless the user clicks "Check for updates." Quietest, least code. |
| Open download page | **Rust-side via `tauri-plugin-opener`** | Invoked from within a Rust command, so no webview shell/opener ACL is granted; preserves the "no blanket shell" posture. |
| Version source | **`env!("CARGO_PKG_VERSION")`** in Rust | Matches Cargo.toml / tauri.conf.json; no app-plugin capability; stays "all-through-Rust". |

## 3. Part A — Settings "About" section (feature)

### 3.1 UI

A new **`src/lib/settings/AboutSection.svelte`** appended to `SettingsPanel`'s section list
(third, after Obsidian + Appearance) — the drop-in section pattern from #37.

```
About
  Revenant   v0.1.0
  [ Check for updates ]    ● Up to date
        └ (when newer)     Update available — v0.2.0   [ Download ]
        └ (on failure)     Couldn't check for updates
```

Chip states: `idle` → `checking` (spinner) → `up-to-date` / `update-available` (+ Download
button) / `error`. Follows the existing section styling (Svelte 4 options-API, matching the
component library).

### 3.2 New IPC commands (frozen-contract change, WS-A)

| Command | Behavior | Returns |
|---|---|---|
| `get_app_version()` | `env!("CARGO_PKG_VERSION")` | `String` |
| `check_for_updates()` | `GET https://api.github.com/repos/slash-hug/revenant/releases/latest` via the existing `reqwest` `OnceLock` client (`User-Agent: revenant-updater`, probe timeout); parse `tag_name`, strip leading `v`, semver-compare to current | `UpdateCheck { current, latest, update_available, release_url }` |
| `open_release_page(url)` | Validate `url` is on the `github.com/slash-hug/revenant/releases` host, then open it in the default browser via `tauri-plugin-opener`'s **Rust** API | `()` |

- `UpdateCheck` is a dedicated serializable struct returned as `IpcResult<UpdateCheck>`
  (not routed through `IpcError`); network/parse failure maps to an `IpcError` the UI shows
  as "Couldn't check for updates."
- All three added to `ipc.rs` + `ipc.ts` mirror + registered in `lib.rs`; FROZEN command
  list in `CLAUDE.md` updated.
- New Rust dependency `tauri-plugin-opener` + `.plugin(tauri_plugin_opener::init())` in
  `lib.rs`. No new webview capability (the open is performed Rust-side).

### 3.3 Update semantics

- `update_available` is true only when the latest published release's semver is strictly
  greater than the running version.
- The GitHub call requires a `User-Agent` header (GitHub rejects requests without one).
- Unauthenticated rate limit (60 req/hr/IP) is irrelevant for manual checks.

## 4. Part B — Release pipeline → Windows installer (ops)

### 4.1 `release.yml` edits (config, WS-A)

- **Trim the matrix to `windows-latest`** (drop `macos-latest`).
- **`releaseDraft: false`** — *critical*: GitHub's `/releases/latest` ignores draft
  releases, so the check (and the public download link) only resolves a **published**
  release.
- Drop the unused `TAURI_SIGNING_PRIVATE_KEY*` env block (the lightweight approach signs
  nothing); keep `GITHUB_TOKEN`.
- NSIS `.exe` is already built (`bundle.targets: "all"`) and uploaded; the existing
  `nsis-hooks.nsh` PATH registration is unchanged.

### 4.2 Release execution (manual ops, run after the code merges)

1. **Scan git history for secrets** before going public — non-negotiable; once public the
   full history is exposed. Expected clean (REST key lives in the OS keychain; only
   `rest_key_ref` is persisted) but verified regardless (scan for key/token/connection-string
   patterns across all commits).
2. **Make the repo public** — `gh repo edit slash-hug/revenant --visibility public`
   (unblocks free Actions). **Confirm with the user at this exact step before flipping.**
3. **Tag `v0.1.0`** and push → `release.yml` builds the Windows `.exe` and publishes the
   GitHub release with the installer attached.
4. **Verify on Windows**: install the `.exe`; confirm `revenant --version` in a new terminal;
   confirm Settings → Check for updates reports "Up to date" against the published v0.1.0.

### 4.3 Version-bump checklist (documented for future releases)

Bump **all three** manifests together — `tauri.conf.json`, `package.json`,
`src-tauri/Cargo.toml` — commit, tag `vX.Y.Z`, push. The tag drives the build; the baked
`CARGO_PKG_VERSION` drives the in-app check.

## 5. Security

- Going public requires the history secret-scan (§4.2.1) as a hard gate.
- The GitHub API call goes out from the Rust core (no CSP/webview-network change).
- `open_release_page` validates the URL host before opening; no blanket shell/opener ACL on
  the webview. Update the `capabilities/default.json` description if needed to reflect the
  scoped opener (the open is Rust-side, so no permission entry is added).

## 6. Out of scope (v1)

Auto-update install (`tauri-plugin-updater`) · code signing · macOS builds ·
auto-check-on-launch. Each has a clean upgrade path and does not require reworking this design.

## 7. Testing

- **Rust** (`updates.rs` or folded into an existing module): semver compare
  (newer/older/equal → `update_available`); GitHub-response parse via `mockito` (mirrors
  `obsidian_tests.rs`); network error → graceful error (no panic).
- **IPC contract** (`ipc_contract.test.ts`): the three new commands present/callable.
- **Frontend**: AboutSection chip-state logic where unit-testable (component mounting is not
  wired for this repo's vitest setup — SSR resolution — so logic/source coverage, not render).

## 8. Rough file set (feature-research/implement splits into zero-overlap workstreams)

- **New:** `src/lib/settings/AboutSection.svelte`; a Rust update-check module (e.g.
  `src-tauri/src/updates.rs`) or additions to an existing module; Rust tests.
- **WS-A (foundation/IPC/CI):** `src-tauri/src/ipc.rs`, `src/lib/types/ipc.ts`,
  `src-tauri/src/lib.rs` (commands + opener plugin init), `src-tauri/Cargo.toml`
  (`tauri-plugin-opener`), `.github/workflows/release.yml`, `CLAUDE.md` (FROZEN list),
  `src/tests/ipc_contract.test.ts`.
- **WS-C (frontend):** `AboutSection.svelte`, wired into `SettingsPanel.svelte`'s section
  list, plus any About chip-state test.
- **WS-D (engine):** the update-check probe (`reqwest` GET + semver compare + parse) and its
  `mockito` tests.
- **Manual ops (orchestrator):** history secret-scan, `gh repo edit ... --visibility public`,
  tag `v0.1.0`, post-build Windows verification.

> `ipc.rs`, `ipc.ts`, `lib.rs`, `Cargo.toml`, `capabilities/**`, `.github/workflows/**`,
> `CLAUDE.md` are WS-A-owned per CLAUDE.md; the update-check command body delegates to the
> WS-D engine module's `pub` helper, keeping ownership clean.
