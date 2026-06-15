# Implementation Plan — Version display, Check-for-updates, Windows release pipeline

**Source spec:** `docs/superpowers/specs/2026-06-15-revenant-version-updates-release-design.md` (approved; source of truth for WHAT)
**Plan status:** DRAFT — awaiting human ruling on the conflicts/risks in §2 before `feature-implement`
**Repo:** `slash-hug/revenant` · Tauri 2 (Rust) + Svelte 5 (options-API) + TS

---

## 1. Header — goal, approach, architecture decisions

### Goal
Ship a working, installable **Windows `.exe`** (first release ever), plus an in-app **About** section that shows the current version and a manual **Check for updates** against the public GitHub Releases API, with a **Download** button that opens the release page in the default browser.

### Approach
Three new IPC commands (`get_app_version`, `check_for_updates`, `open_release_page`) extend the FROZEN contract; a new Rust engine module (`updates.rs`) does the GitHub probe + semver compare; a new `AboutSection.svelte` drops into `SettingsPanel` as the third section; and `release.yml` is retargeted to a published Windows-only build. Release execution (secret scan → go public → tag → Windows verify) is **manual ops by the orchestrator**, gated on explicit human confirmation.

### Human rulings (resolved 2026-06-15 — all recommendations accepted)

1. **semver dep** — APPROVED: add `semver = "1"` (correct pre-release handling; already transitively in the lock tree).
2. **reqwest client** — dedicated `OnceLock<Client>` in `updates.rs` with a `revenant-updater` User-Agent (obsidian's client sets none → GitHub 403). Do not reuse `obsidian::rest_client()`.
3. **Chip semantics** — add a `chip-info` class (accent tokens); do NOT overload amber `chip-warn`.
4. **Error granularity** — single generic "Couldn't check for updates" chip for v1 (no 403-specific message).
5. **Repo slug** — confirmed `slash-hug/revenant`; hardcode as a `const`.
6. **opener config block** — VERIFY at impl time (task A2) whether `tauri-plugin-opener` v2 needs a `plugins.opener` block; mandatory local `cargo tauri dev` launch smoke before the round is done.
7. **Ops HARD STOP** — git-history secret scan (M1) then explicit human go-ahead before `gh repo edit --visibility public` (M2). Orchestrator pauses for confirmation at that exact step.

### Architecture decisions (each tied to a research finding)

| Decision | Choice | Driven by |
|---|---|---|
| `UpdateCheck` return shape | Dedicated serializable struct returned as `IpcResult<UpdateCheck>` — `UpdateCheck` is the **Ok** variant (NOT routed through `IpcError`); network/parse failure becomes an `IpcError`. | [review-history] + [architecture]: this matches `IpcResult<T>` types (`FileResult`, `Settings`) — unlike `ConnStatus` which encodes outcomes in its enum. UI shows the error as a chip, not a toast. |
| Where `UpdateCheck` is defined | In `ipc.rs` (re-exported to `ipc.ts`), **not** in `updates.rs`. | [review-history] lessons.md 2026-06-14: IPC-crossing types live in `ipc.rs`. The `updates.rs` engine returns plain data the command wraps. |
| reqwest client | **Dedicated** `OnceLock<reqwest::blocking::Client>` inside `updates.rs` with `ClientBuilder::user_agent("revenant-updater")` + 3s timeout. Do NOT reuse `obsidian::rest_client()`. | [architecture] + [review-history]: `obsidian::rest_client()` is module-private, loopback-tuned, and sets **no** User-Agent. GitHub rejects requests without one (403). A dedicated client also keeps the WS-D obsidian/updates ownership boundary clean (no cross-module coupling). |
| Version comparison | **Add the `semver` crate** (`semver = "1"`) as a direct dep [RESOLVED: approved]; parse both tags with `Version::parse` after stripping a leading `v`. | [architecture] + [ux]: handles pre-release tags (`v0.2.0-beta`) correctly; hand-rolled split-on-dot silently misbehaves. `semver 1.0.28` is already in `Cargo.lock` transitively, so no new tree. |
| Open download page | `tauri-plugin-opener = "2"`, called via its **Rust** API from inside `open_release_page`. No webview capability entry. | spec §2 + [codebase]: Rust-side open preserves "no blanket shell/opener ACL". |
| opener plugin config | **VERIFY** whether `tauri-plugin-opener` needs a `plugins.opener` block in `tauri.conf.json` (the file already has a `plugins.cli` block at line 13). | [review-history] CRITICAL, lessons.md 2026-06-13: a missing plugin config block panics at startup before the window opens — green CI did not catch it. Mandatory local `cargo tauri dev` launch smoke after adding the plugin. |
| Chip semantics for `update-available` | **RESOLVED:** add a new `chip-info` (accent tokens); do NOT overload amber `chip-warn`. | [ux]: existing chip set is ok/warn/err only; an update is informational, not a warning. |
| AboutSection syntax | Svelte 4 **options-API** (`export let`, `createEventDispatcher`), matching `AppearanceSection`/`ObsidianSection` in the Svelte 5 runtime. Do NOT use runes. | [codebase] + [review-history]: mixing runes breaks svelte-check / consistency. "Svelte 4" in the spec means style, not a package downgrade. |
| Version source | `env!("CARGO_PKG_VERSION")` in Rust. | spec §2; all three manifests already synced at `0.1.0`. |
| Release platform / draft / signing | `windows-latest` only; `releaseDraft: false`; drop `TAURI_SIGNING_PRIVATE_KEY*` env (keep `GITHUB_TOKEN`). | spec §4.1 + [codebase]: `/releases/latest` ignores drafts (would always report "up to date"); unsigned per resolved decision. |

### Confirmed codebase facts (verified, not assumed)
- FROZEN command list is **18** commands, not 10 (CLAUDE.md line 77, lib.rs lines 121–141, ipc.ts, ipc_contract.test.ts). Append 3 → **21**.
- `ConnStatus` is re-exported from `obsidian.rs` via `pub use crate::obsidian::ConnStatus;` (ipc.rs line 822). `UpdateCheck` does **not** follow this — it is a fresh struct defined in `ipc.rs`.
- `tauri.conf.json` has a `plugins` block with a `cli` entry (line 12–13). `opener` is absent.
- `Cargo.toml`: `repository = ""` (empty, line 7); `reqwest = { version = "0.12", features = ["blocking", "rustls-tls"] }` present; `mockito` to be confirmed in dev-deps; no `semver` direct dep; no `tauri-plugin-opener`.
- `release.yml`: matrix `[macos-latest, windows-latest]` (line 15), signing env (lines 43–44), `releaseDraft: true` (line 59) — all three need editing.
- `capabilities/default.json` needs **no** opener entry (Rust-side open).
- `src/tests/setup.ts` mocks Tauri IPC; component mounting is not wired (SSR resolution) — AboutSection tests must be **source/logic** coverage, not render.

---

## 2. Conflicts & decisions needed (VERBATIM from research — HUMAN must rule before implementation)

> Each item is reproduced verbatim from the research lenses, followed by the recommended resolution. The plan's §1 decisions assume these recommendations; if the human rules differently, update §1 accordingly.

### Spec conflicts

**[codebase]** Spec §3.1 says 'Svelte 4 options-API, matching the component library' but the project's package.json specifies svelte ^5.0.0. In practice the existing sections (ObsidianSection, AppearanceSection) use options-API syntax in the Svelte 5 runtime (Svelte 5 is backward-compatible with options-API). This is not a contradiction — it means AboutSection should follow the options-API style of its siblings, not Svelte 5 runes syntax. No actual conflict, but implementers must not assume 'Svelte 4' means downgrading the package.
→ **Resolution:** No conflict. AboutSection uses options-API (`export let`, `createEventDispatcher`); package stays `^5.0.0`. Baked into WS-C tasks.

**[codebase]** Spec says the GitHub API call uses 'the existing reqwest OnceLock client' from obsidian.rs. The obsidian.rs OnceLock client is typed as blocking::Client with a 3s timeout, which is correct for the update check. However, the client is a private fn rest_client() in the obsidian module — it cannot be called from updates.rs without either making it pub or duplicating the OnceLock in updates.rs. Implementers must choose: re-export rest_client() from obsidian, or define an identical OnceLock in updates.rs. The spec does not resolve this, leaving ownership ambiguous between WS-D (obsidian module) and WS-D (new updates module).
→ **Resolution (RECOMMEND):** Define a **dedicated** `OnceLock<Client>` in `updates.rs` with a `user_agent("revenant-updater")` and 3s timeout. Reason: obsidian's client sets no User-Agent (GitHub returns 403 without one), and a dedicated client avoids cross-module coupling. Both modules are WS-D so no workstream conflict either way; the dedicated client is cleaner.

**[codebase]** Spec §4.1 says 'Drop the unused TAURI_SIGNING_PRIVATE_KEY* env block'. These env vars exist in release.yml lines 43-44 but are referenced as secrets (${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}). Since the repo is currently private, the secrets may or may not be set in GitHub — their removal is safe because the spec has already resolved to unsigned builds, but the implementer should confirm no other workflow step references these secret names.
→ **Resolution:** Drop lines 43–44. WS-A task includes a grep across `.github/workflows/**` confirming no other reference. Verified safe (unsigned decision).

**[ux]** The spec says chip state 'update-available' can reuse the existing chip palette but does not assign a specific chip class. The existing chip set (ok=green, warn=amber, err=red) has no neutral-informational variant. Using chip-warn for an update notification is a semantic mismatch that will read as 'something is wrong' rather than 'something is available'. The spec should either explicitly assign chip-warn and accept this trade-off, or add a chip-info class using accent tokens.
→ **Resolution (RECOMMEND):** Add a `chip-info` class in AboutSection's scoped `<style>` using `--accent-soft`/`--accent-text` tokens (with the matching `:global([data-theme="dark"]) .chip-info` override). Low cost, correct semantics. **HUMAN: confirm or accept `chip-warn`.**

**[ux]** The spec describes `open_release_page(url)` as 'validate url is on the github.com/slash-hug/revenant/releases host'. The repo is currently private and hosted under `slash-hug/revenant` per the spec, but the Cargo.toml `repository` field is empty (line 7). The URL validation in the Rust command must use the correct canonical repo slug — verify the public repo URL matches before hardcoding the host guard.
→ **Resolution:** Hardcode slug constant `slash-hug/revenant` in `updates.rs`; validate by **parsing** the URL (host == `github.com`, path starts with `/slash-hug/revenant/releases`, scheme == `https`). The `url` passed is the parsed `html_url` from the GitHub response. **HUMAN: confirm the final public repo slug before tagging v0.1.0** (also fills the empty `Cargo.toml repository` field — optional WS-A nicety).

**[ux]** The spec freezes the IPC command list by saying 'all three added to ipc.rs + ipc.ts + registered in lib.rs; FROZEN command list in CLAUDE.md updated.' However, CLAUDE.md's frozen command list (in the Commands section) is not shown as already containing get_app_version, check_for_updates, or open_release_page. Implementors must update that list as part of WS-A, not after the fact.
→ **Resolution:** WS-A appends the 3 commands to CLAUDE.md line 77 **in the same commit** as the lib.rs registration. Baked into WS-A task A4.

**[architecture]** No semver crate dep; version compare needs semver or hand-rolled -- surface this new dep.
→ **Resolution (RECOMMEND):** Add `semver = "1"` to Cargo.toml (WS-A owns Cargo.toml). **NEW DEPENDENCY — needs human approval per global rule §9.**

**[architecture]** Spec reuse of the loopback reqwest client is overstated; use a dedicated WS-D client. Frozen list is 17 not 10.
→ **Resolution:** Dedicated client (see above). Frozen list is actually **18** verified in-repo (one more than architecture's count) → 21 after this change.

**[review-history]** ...the 'existing reqwest OnceLock client' for check_for_updates ... is a module-private function (`rest_client()`) inside `obsidian.rs` — not pub and not accessible from a new `updates.rs` ... This needs an explicit decision: expose `rest_client()` as `pub(crate)` in obsidian.rs, move it to a shared `http.rs` helper, or define a separate OnceLock in updates.rs.
→ **Resolution (RECOMMEND):** Separate OnceLock in `updates.rs` (see above). No change to obsidian.rs.

**[review-history]** The spec is silent on whether tauri-plugin-opener requires a `plugins.opener` config block in tauri.conf.json. Per the 2026-06-13 lesson, every Tauri plugin that requires config WILL panic at startup without it. The spec only mentions `.plugin(tauri_plugin_opener::init())` ... If opener needs a config section, the spec omits it, and the missing block would cause a startup panic on the very first launch.
→ **Resolution (BLOCKING VERIFY):** WS-A task A2 must check the `tauri-plugin-opener` v2 docs for a required config block and add it if needed; a **local `cargo tauri dev` launch smoke is mandatory** before the round is marked done. **HUMAN: confirm opener config requirement was checked.**

**[review-history]** ...'trim the matrix to windows-latest' in release.yml ... ci.yml runs the full ... matrix on both macos-latest and windows-latest ... the release.yml and ci.yml matrices intentionally diverge after this change.
→ **Resolution:** Accepted/expected. Only `release.yml` is trimmed; `ci.yml` keeps both OSes (CI continues to validate macOS builds). No action beyond awareness.

**[review-history]** ...UpdateCheck is NOT routed through IpcError (it is the Ok variant), making it unlike ConnStatus ... The UpdateCheck approach is different (richer struct) and must match the pattern for all existing IpcResult<T> types in ipc.rs.
→ **Resolution:** `IpcResult<UpdateCheck>` with `UpdateCheck` as Ok; failures map to `IpcError` (`UPDATE_CHECK_FAILED` code). Matches `FileResult`/`Settings` pattern. Baked into WS-A/WS-D.

### Open risks

**[codebase]** Repo visibility gate (spec §4.2 step 2): 'Make the repo public — confirm with the user at this exact step before flipping.' This is an irreversible action that permanently exposes the full git history. The spec correctly flags it as a hard stop requiring explicit human confirmation. A full history secret scan (git log, git diff-tree) must precede this step. The repo's CLAUDE.md notes the REST key lives in the OS keychain only, but the scan must still run.
→ **Resolution:** Manual-ops M1 (secret scan) → M2 (human-confirmed flip). Hard stop.

**[codebase]** tauri-plugin-opener version compatibility: ... adds tauri-plugin-opener to Cargo.toml without specifying a version. ... Implementer must verify that tauri-plugin-opener '2' exists and is compatible with the tauri '2' version locked in Cargo.lock before adding it, to avoid a resolver conflict.
→ **Resolution:** Pin `tauri-plugin-opener = "2"`; verified by `cargo build` succeeding in task A2.

**[codebase]** The update check hardcodes the GitHub API endpoint to 'slash-hug/revenant'. ... If the repo is renamed or transferred during the go-public step, the baked API URL in updates.rs will be wrong. Human must confirm the target repo path before tagging v0.1.0.
→ **Resolution:** Slug constant in `updates.rs`. **HUMAN confirms slug before M3 (tag).**

**[codebase]** ci.yml's security-guard job (lines 21-28) scans for 'tauri_plugin_(fs|shell)::init' but not for 'tauri_plugin_opener::init' ... a separate review of open_release_page's URL host-check is needed at code-review time.
→ **Resolution:** Add `open_release_page` URL host-check to the WS-D test suite + flag for the independent code review (Security Engineer lens). Opener is intentionally not a blanket escalation, so no security-guard change.

**[codebase]** The launch-smoke step in ci.yml (line 154) ... After adding tauri-plugin-opener, the binary must still boot cleanly without panicking on the new plugin init.
→ **Resolution:** Covered by mandatory local `cargo tauri dev` smoke (task A2) + the existing CI smoke.

**[codebase]** Spec §7 says 'component mounting is not wired for this repo's vitest setup — SSR resolution'. ... AboutSection's chip-state logic test should be written as a pure-logic unit test (no render) ...
→ **Resolution:** WS-C extracts chip-state mapping into a pure TS helper (`aboutChipState.ts` or an exported fn) and unit-tests that; no component render.

**[ux] HUMAN DECISION REQUIRED — Public repo timing:** ... The secret-scan step (§4.2.1) must complete and be reviewed by the product owner before `gh repo edit ... --visibility public` is run. If the scan is skipped or the result is not reviewed, the full git history becomes public immediately and any accidentally committed token or key is permanently exposed even after removal (git history is public, forks exist).
→ **Resolution:** M1 scan output is shown to the human; M2 flip waits for explicit "go".

**[ux] HUMAN DECISION REQUIRED — reqwest OnceLock client sharing:** ... decide: (a) expose the OnceLock from obsidian.rs as `pub` and import it in updates.rs, or (b) create a second OnceLock in updates.rs. Option (a) is cleaner but introduces a coupling ... This ownership boundary is unresolved in the spec.
→ **Resolution (RECOMMEND):** Option (b) — dedicated client in updates.rs (needs User-Agent obsidian lacks). **HUMAN: confirm.**

**[ux] HUMAN DECISION REQUIRED — semver comparison crate:** ... add the `semver` crate or do a manual string comparison. Adding `semver` is the safe choice (handles pre-release tags) but adds a dependency. ... This decision affects Cargo.toml (WS-A owned) and needs explicit approval before implementation.
→ **Resolution (RECOMMEND):** Add `semver = "1"`. **HUMAN: approve the dependency.**

**[ux] RISK — Windows SmartScreen UX:** ... does not describe how this is communicated to the first-time Windows installer. The release body ... mentions the PATH note but not SmartScreen. A first-time user on a managed/corporate Windows machine may not have 'More info' available ...
→ **Resolution:** Add a one-line SmartScreen note to the `releaseBody` in release.yml (WS-A). QA/doc gap, not code.

**[ux] RISK — SettingsPanel max-height on 720p Windows:** At 1280x720 the panel body cap is min(70vh, 640px) = 504px. ... the About section may require scrolling to reach on a short display — which is acceptable but should be explicitly verified in the Windows QA step.
→ **Resolution:** No code change (Done button is pinned). Add to Windows QA checklist (M4).

**[ux] RISK — GitHub API rate limit on shared IPs:** ... 60 req/hr/IP ... The error chip handles this gracefully, but the error message 'Couldn't check for updates' gives no hint that rate-limiting is the cause. Consider mapping HTTP 403 from the GitHub API to a distinct message or the same generic chip — this is a UX decision for the implementor.
→ **RESOLVED:** Single generic "Couldn't check for updates" chip for v1. No 403-specific message.

**[architecture]** Decide semver vs hand-rolled, and shared vs dedicated reqwest client.
→ **Resolution:** semver crate + dedicated client (above).

**[architecture]** Secret-scan full git history before the non-reversible visibility flip (human gate); pin opener plugin to v2; releases-latest ignores drafts and returns latest non-prerelease only; validate single-instance/PATH on real Windows; open_release_page must do exact host+releases-path match over https.
→ **Resolution:** All folded into M1/M2/M3/M4 + WS-A (`releaseDraft: false`, pin opener v2) + WS-D (host+path+https validation).

**[review-history] CRITICAL — tauri-plugin-opener config block:** If tauri-plugin-opener requires a `plugins.opener` block in tauri.conf.json ... and none is added, the app will panic at startup before the window opens ... This was not caught by CI (green build + green tests) in that incident. A human must verify the opener plugin's config requirements before shipping, and the launch smoke must be run after adding the plugin.
→ **Resolution:** BLOCKING — task A2 verify + mandatory local `cargo tauri dev` smoke. **HUMAN gate.**

**[review-history] SECRET SCAN before going public:** ... a full git history secret scan before `gh repo edit --visibility public`. This is a one-way operation ... The scan must be confirmed clean by the orchestrator before the visibility flip, and the user must explicitly approve the flip.
→ **Resolution:** M1 → M2 hard stop (above).

**[review-history] releaseDraft: true in current release.yml will silently break the in-app update check:** with `releaseDraft: true`, GitHub's `/repos/.../releases/latest` endpoint does NOT return draft releases. ... This must be flipped to `false` before the first tag push.
→ **Resolution:** WS-A task A5 flips to `false`. Verified before M3.

**[review-history] Windows launch smoke required post-opener-plugin:** ... tauri-plugin-opener is a new plugin — this is an explicit trigger [for `cargo tauri dev`]. The CI launch smoke ... only covers a non-release build; the release workflow itself does not have a smoke step ...
→ **Resolution:** Local `cargo tauri dev` smoke after A2 (mandatory) + Windows install smoke at M4.

**[review-history] Svelte 4 options-API consistency:** ... AboutSection must follow the same pattern — mixing Svelte 5 runes syntax ($state, $derived) would break the component or fail svelte-check ...
→ **Resolution:** options-API only (WS-C). svelte-check is a gate.

**[review-history] open_release_page URL validation:** ... The URL must come from the parsed `html_url` field of the GitHub releases response ... and should be validated by parsing the host and checking the path prefix.
→ **Resolution:** Parse-and-check (host==github.com, scheme==https, path prefix `/slash-hug/revenant/releases`). URL originates from `html_url`. WS-D + security review.

---

## 3. File map

### Create
| File | Workstream | Purpose |
|---|---|---|
| `src-tauri/src/updates.rs` | WS-D | Update-check engine: dedicated reqwest client, GitHub probe, semver compare, URL validation helper. `pub` helpers called by ipc.rs. |
| `src-tauri/src/tests/updates_tests.rs` | WS-D | mockito-based parse/compare/error tests + URL-validation tests. |
| `src/lib/settings/AboutSection.svelte` | WS-C | About section UI (version + check/download + chips). options-API. |
| `src/lib/settings/aboutChipState.ts` | WS-C | Pure chip-state mapping helper (unit-testable without render). |
| `src/tests/about_section.test.ts` | WS-C | Unit tests for `aboutChipState.ts` + AboutSection source-shape assertions. |

### Modify
| File | Workstream | Change |
|---|---|---|
| `src-tauri/src/ipc.rs` | WS-A | Add `UpdateCheck` struct + 3 `#[command]`s delegating to `updates.rs`. |
| `src/lib/types/ipc.ts` | WS-A | Add `UpdateCheck` interface + 3 typed wrappers. |
| `src-tauri/src/lib.rs` | WS-A | Register 3 commands in `generate_handler!`; add `.plugin(tauri_plugin_opener::init())`. |
| `src-tauri/Cargo.toml` | WS-A | Add `tauri-plugin-opener = "2"`, `semver = "1"`; (optional) fill `repository`. |
| `src-tauri/tauri.conf.json` | WS-A | Add `plugins.opener` block **only if** the plugin requires one (verify). |
| `CLAUDE.md` | WS-A | Append 3 commands to FROZEN list (line 77). |
| `.github/workflows/release.yml` | WS-A | Matrix→`windows-latest`; `releaseDraft: false`; drop signing env; add SmartScreen note to body. |
| `src/tests/ipc_contract.test.ts` | WS-A | Add 3 command wrappers + `UpdateCheck` shape assertion. |
| `src-tauri/src/tests/mod.rs` | WS-D | Register `pub mod updates_tests;`. |
| `src/lib/SettingsPanel.svelte` | WS-C | Import + render `<AboutSection />` as third section. |

### NOT modified (explicitly)
- `src-tauri/capabilities/default.json` — no opener permission (Rust-side open).
- `src-tauri/src/obsidian.rs` — client stays private; not shared.
- `tauri.conf.json` CSP — update check is Rust-side; no webview network change.
- `.github/workflows/ci.yml` — keeps both-OS matrix (intentional divergence from release.yml).

---

## 4. Workstreams (ZERO file overlap)

> Ownership follows CLAUDE.md: WS-A owns ipc.rs/ipc.ts/lib.rs/Cargo.toml/capabilities/tauri.conf.json/workflows/CLAUDE.md/ipc_contract.test.ts. WS-D owns engine modules + their tests (`mod.rs`). WS-C owns Svelte components + `*.test.ts` (except ipc_contract). No file appears in two workstreams.

- **WS-A — Foundation / IPC / CI** — owns: `ipc.rs`, `ipc.ts`, `lib.rs`, `Cargo.toml`, `tauri.conf.json`, `CLAUDE.md`, `release.yml`, `ipc_contract.test.ts`.
- **WS-D — Update-check engine (Rust)** — owns: `updates.rs`, `tests/updates_tests.rs`, `tests/mod.rs`.
- **WS-C — Frontend (About section)** — owns: `AboutSection.svelte`, `aboutChipState.ts`, `about_section.test.ts`, `SettingsPanel.svelte`.
- **Manual ops (orchestrator, after merge)** — secret scan, go-public, tag, Windows verify. No source files.

**Sequencing:** WS-A defines the contract (UpdateCheck + command signatures + opener plugin) first because WS-D's command bodies and WS-C's wrappers depend on it. WS-A's `ipc.rs` command bodies call `crate::updates::*`, so WS-A and WS-D must agree on the `updates.rs` `pub fn` signatures up front (stated in tasks below). WS-C depends only on the `ipc.ts` wrappers (WS-A). Manual ops run last, after all three merge.

---

## 5. Tasks

### WS-A — Foundation / IPC / CI

**A1 — Add `UpdateCheck` type + 3 command stubs to the contract**
- `src-tauri/src/ipc.rs`: add `#[derive(Debug, Clone, Serialize, Deserialize)] pub struct UpdateCheck { pub current: String, pub latest: String, pub update_available: bool, pub release_url: String }`. Add three `#[tauri::command]`s: `get_app_version() -> String` (returns `env!("CARGO_PKG_VERSION").to_string()`); `check_for_updates() -> IpcResult<UpdateCheck>` (delegates to `crate::updates::check_for_updates()` on a `spawn_blocking`, maps engine error to `IpcError { code: "UPDATE_CHECK_FAILED", .. }`); `open_release_page(url: String) -> IpcResult<()>` (delegates to `crate::updates::open_release_page(&url)`).
- Agreed `updates.rs` signatures (WS-D implements): `pub fn check_for_updates() -> Result<UpdateCheck, UpdatesError>` and `pub fn open_release_page(url: &str) -> Result<(), UpdatesError>`, where `UpdateCheck` is imported from `crate::ipc`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` — compiles (will need a temporary `crate::updates` stub from WS-D or a `todo!()` placeholder until WS-D lands; coordinate at merge).

**A2 — Add deps + opener plugin + verify config block**
- `src-tauri/Cargo.toml`: add `tauri-plugin-opener = "2"` and `semver = "1"` under `[dependencies]`.
- `src-tauri/src/lib.rs`: add `.plugin(tauri_plugin_opener::init())` to the Builder chain.
- Check `tauri-plugin-opener` v2 docs: if it requires a `plugins.opener` block, add it to `src-tauri/tauri.conf.json` (sibling of the existing `cli` block). If not required, leave unchanged and note "verified: no config block needed."
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` succeeds (no resolver conflict), then **mandatory** `cargo tauri dev` — window opens, no `PluginInitialization` panic. (lessons.md 2026-06-13/06-14 trigger.)

**A3 — Add TS mirror types + wrappers**
- `src/lib/types/ipc.ts`: add `export interface UpdateCheck { current: string; latest: string; update_available: boolean; release_url: string }`. Add wrappers: `getAppVersion(): Promise<string>` → `invoke<string>("get_app_version")`; `checkForUpdates(): Promise<UpdateCheck>` → `invoke<UpdateCheck>("check_for_updates")`; `openReleasePage(url: string): Promise<void>` → `invoke<void>("open_release_page", { url })`.
- **Verify:** `npx tsc --noEmit` — no errors.

**A4 — Update CLAUDE.md FROZEN list + register handlers**
- `src-tauri/src/lib.rs`: append `ipc::get_app_version, ipc::check_for_updates, ipc::open_release_page` to `generate_handler!`.
- `CLAUDE.md` line 77: append `` `get_app_version`, `check_for_updates`, `open_release_page` `` to the Commands list (same commit as the lib.rs registration).
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` compiles; manually confirm CLAUDE.md count is 21.

**A5 — Retarget release.yml**
- `.github/workflows/release.yml`: matrix `os: [windows-latest]`; remove the `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env lines (43–44); `releaseDraft: false`; add a one-line SmartScreen note to `releaseBody` ("Windows may show an 'unknown publisher' prompt — choose More info → Run anyway."). Remove the now-dead "Upload macOS installer" step.
- Grep `.github/workflows/**` to confirm no other reference to the dropped secret names or `macos`.
- **Verify:** `grep -rn "TAURI_SIGNING\|macos-latest" .github/workflows/release.yml` returns nothing; YAML lints (visual review of the diff).

**A6 — Add the 3 commands to ipc_contract.test.ts**
- `src/tests/ipc_contract.test.ts`: import `getAppVersion`, `checkForUpdates`, `openReleasePage`; add them to the "exports all required command wrappers" block (`typeof === 'function'`) and add an invoke-name assertion for each; add a compile-time `UpdateCheck` shape assertion mirroring the `Settings`/`Sidecar` pattern.
- **Verify:** `npm test` — ipc_contract suite passes.

### WS-D — Update-check engine (Rust)

**D1 — Create `updates.rs` skeleton + error type + dedicated client**
- `src-tauri/src/updates.rs`: define `pub enum UpdatesError` (`thiserror`: `Network`, `Parse`, `InvalidUrl`) and a private `fn client() -> &'static reqwest::blocking::Client` (`OnceLock`, `ClientBuilder::user_agent("revenant-updater").timeout(Duration::from_secs(3))`).
- Add `pub mod updates;` to `lib.rs`? **No** — `lib.rs` is WS-A. Instead WS-A adds the `mod updates;` declaration in A1/A4. (Note: module declaration is WS-A; the file content is WS-D. Coordinate: WS-A adds `mod updates;` next to the other module decls.)
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` compiles.

**D2 — Implement `check_for_updates()`**
- `GET https://api.github.com/repos/slash-hug/revenant/releases/latest` (slug as a `const`); parse `tag_name` + `html_url` from JSON; strip leading `v`; `semver::Version::parse` both; `update_available = latest > current`; build `crate::ipc::UpdateCheck`. Map reqwest/JSON/parse failures to `UpdatesError`. (Optional per §2: map HTTP 403 to a distinct message.)
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` compiles.

**D3 — Implement `open_release_page(url)` with strict validation**
- Parse `url`; reject unless `scheme == "https"`, `host == "github.com"`, path starts with `/slash-hug/revenant/releases`. On pass, call the `tauri-plugin-opener` Rust API to open it. On fail → `UpdatesError::InvalidUrl`.
- **Verify:** `cargo build --manifest-path src-tauri/Cargo.toml` compiles.

**D4 — Tests (mockito, mirrors obsidian_tests.rs)**
- `src-tauri/src/tests/updates_tests.rs`: semver compare newer/older/equal → `update_available`; GitHub-response parse via `mockito::Server`; network/parse error → graceful `Err` (no panic); URL-validation accept/reject cases (https github.com path-prefix vs http, evil host, wrong path).
- `src-tauri/src/tests/mod.rs`: add `pub mod updates_tests;`.
- Confirm `mockito` is in `[dev-dependencies]` (it is per research; if absent, flag to WS-A since Cargo.toml is WS-A-owned).
- **Verify:** `cargo test updates --manifest-path src-tauri/Cargo.toml` — all pass.

### WS-C — Frontend (About section)

**C1 — Chip-state helper + tests**
- `src/lib/settings/aboutChipState.ts`: pure fn mapping `{ status: 'idle'|'checking'|'up-to-date'|'update-available'|'error', check?: UpdateCheck }` → `{ chipClass, chipText, showDownload }`. `update-available` → `chip-info`; `up-to-date` → `chip-ok`; `error` → `chip-err` with text "Couldn't check for updates".
- `src/tests/about_section.test.ts`: unit-test every branch of the helper.
- **Verify:** `npm test` — about_section suite passes; `npx tsc --noEmit` clean.

**C2 — Build `AboutSection.svelte`**
- options-API (`export let`, no props needed beyond internal state via plain `let`). On mount call `getAppVersion()` (show a `Loading…` placeholder with `aria-live="polite"` until it resolves — UX gap fix). "Check for updates" button → `checkForUpdates()` with a `checking` spinner (lift the SVG/`@keyframes spin` from ObsidianSection); render chip via `aboutChipState`. "Download" button → `openReleasePage(check.release_url)` with a brief `aria-busy` state. Keep the check button enabled after error (retry). Add scoped `<style>` copying `.section-title`, `.field-row`, `.btn-sm`, `.chip*` classes + a new `.chip-info` (accent tokens) + the `:global([data-theme="dark"])` chip overrides. Chip element gets `role="status"`.
- **Verify:** `npm run build` succeeds; `npx tsc --noEmit` clean; svelte-check passes (run via `npm test` / `npm run check` if defined).

**C3 — Wire into SettingsPanel**
- `src/lib/SettingsPanel.svelte`: import `AboutSection`; render `<AboutSection />` after `<AppearanceSection />` in `.sp-body`.
- **Verify:** `npm run build` succeeds; `settings_panel_shell.test.ts` still passes (`npm test`).

### Manual ops (orchestrator — AFTER all workstreams merge; human-gated)

**M1 — Full git-history secret scan**
- Scan all commits (`git log -p`, `git grep` across history) for key/token/PAT/connection-string patterns (`sk-`, `ghp_`, `Bearer`, `password=`, REST keys). Expected clean (REST key is keychain-only). **Show output to the human.**
- **Verify:** scan reviewed and confirmed clean by the human.

**M2 — Make repo public (HARD STOP)**
- Only after M1 is confirmed clean AND the human explicitly approves: `gh repo edit slash-hug/revenant --visibility public`. Confirm the final slug first.
- **Verify:** `gh repo view slash-hug/revenant --json visibility` → `"public"`.

**M3 — Tag v0.1.0 and push**
- Confirm all three manifests are `0.1.0`. `git tag v0.1.0 && git push origin v0.1.0`. Watch the Actions run build the Windows `.exe` and publish a **non-draft** release.
- **Verify:** GitHub release exists, not draft, `.exe` attached; `gh api repos/slash-hug/revenant/releases/latest` returns the v0.1.0 tag.

**M4 — Windows verification**
- Install the `.exe` on a real Windows machine. Confirm `revenant --version` in a **new** terminal. Confirm Settings → About → Check for updates reports "Up to date". Verify the About section is reachable (scroll OK at 720p) and the SmartScreen flow works.
- **Verify:** all four checks pass on the Windows target.

---

## 6. Out of scope (v1)
- Auto-update install (`tauri-plugin-updater`).
- Code signing / notarization.
- macOS release builds (release.yml is Windows-only now; ci.yml still builds macOS).
- Auto-check-on-launch (manual button only).
- Exposing/refactoring `obsidian::rest_client()` into a shared http module.
- GitHub API authentication / raising the 60 req/hr rate limit.
- Any CSP / webview network capability change.
- Adding an opener permission to `capabilities/default.json`.
