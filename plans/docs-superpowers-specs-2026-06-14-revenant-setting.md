# Implementation Plan — Revenant Settings / Configuration Panel (#37)

**Source spec:** `docs/superpowers/specs/2026-06-14-revenant-settings-panel-design.md` (approved 2026-06-14)
**Plan status:** DRAFT — awaiting human ruling on the decisions block below, then `feature-implement`.
**Date:** 2026-06-14

---

## 1. Header

### Goal
Ship a discoverable Settings panel that edits the existing settings envelope (`get_settings` /
`set_settings`) and writes the Obsidian REST key to the OS keychain, built so adding future settings
is a drop-in (new `*Section.svelte` + `patchSettings`), not a refactor. This unblocks Obsidian
export (no vault could be configured) and REST-key entry (keychain primitives existed but no IPC
exposed them).

### Approach
- **Frontend (WS-C):** `SettingsPanel.svelte` dialog shell composing ordered `*Section.svelte`
  components; a `settings` Svelte store as the single client-side source of truth with a
  `patchSettings` helper; Toolbar gear.
- **Foundation/IPC (WS-A):** four new commands added to the otherwise-frozen IPC surface
  (`ipc.rs` + `ipc.ts` mirror + `lib.rs` registration), panel mount + palette command + `⌘,` in
  `App.svelte`, capabilities note fix, contract test, FROZEN-list update in `CLAUDE.md`.
- **Settings/Obsidian engine (WS-D):** read-only `test_obsidian_connection` probe in `obsidian.rs`,
  the REST-key command *bodies* (delegating to `secrets.rs`), and Rust tests.

### Architecture decisions (with the research finding that drove each)

| Decision | Choice | Driven by |
|---|---|---|
| New Svelte components use **Svelte 4 options-API** (`export let`, `createEventDispatcher`, `on:`, `$:`) — NOT runes | Matches every existing WS-C component (Toolbar, ExportDialog, ConflictModal); App.svelte's runes are the outlier and we don't propagate them into the component library | codebase + review-history (mixed-paradigm risk; `on:` is consistent with ExportDialog, runes would clash with App.svelte's `on:` wiring) |
| `test_obsidian_connection` gets a **dedicated read-only probe**, not `rest_put` | `rest_put` writes a document; a test must not mutate the vault | architecture + review-history (probe-design + CI-timeout findings) |
| `set_rest_key` / `clear_rest_key` **return the updated `Settings`** (not `()`, contra spec §6 table) | Eliminates the read-modify-write race where an optimistic `patchSettings` clobbers `rest_key_ref` | architecture (set/clear returning unit risks stale clobber) |
| `ConnStatus` is a **dedicated serializable enum** returned as `IpcResult<ConnStatus>` — NOT routed through `IpcError`/`obsidian_err()` | The existing `obsidian_err()` maps to `OBSIDIAN_*` error codes; a probe needs a success-typed result with `ok`/`unauthorized`/`unreachable` | codebase (ConnStatus must not reuse IpcError path) |
| All four new commands are **`async` with `spawn_blocking` bodies** | Keychain calls are blocking OS I/O; the probe has a 3s network timeout — synchronous handlers stall the IPC command pool (perf lesson #28) | review-history (TRAP 5) |
| **Do NOT add `dialog:allow-open`** to capabilities; only fix the description comment | `dialog:default` already bundles `allow-open` (confirmed in `gen/schemas/*-schema.json`); adding it explicitly is a redundant no-op | review-history (TRAP 2) + spec-conflict review-history §8 |
| Theme stays on **localStorage via `setThemeMode()`**; AppearanceSection embeds `ThemeToggle` and never calls `patchSettings({theme})` | `theme.ts` is the live source of truth; the `settings.theme` field is orphaned; wiring it to `patchSettings` would fail to update `<html data-theme>` and break Mermaid re-render | review-history (TRAP 3) + codebase |
| `settings` store **eager-loads at app start** (`loadSettings()` in App.svelte init) | Avoids first-open flicker / null-state skeleton; cold-start cost is one short IPC round-trip; lets `handleExportObsidian` read from the store | ux (loading-state + has_rest_key flicker risk) — SEE DECISION D5, human may override to lazy |
| `keyring` used directly via `secrets.rs` — **no `plugins.keyring` block** in `tauri.conf.json` | keyring is a Cargo crate, not a Tauri plugin; a spurious config block panics at startup | review-history (TRAP 4) |
| Mandatory **`cargo tauri dev` launch smoke gate** before done | Green build+test+svelte-check has twice shipped a binary that crashed on launch (cli-plugin panic, zero-size icon) | review-history (TRAP 6) + tasks/lessons.md |

---

## 2. Conflicts & decisions needed (HUMAN MUST RULE BEFORE IMPLEMENTATION)

The following are reproduced VERBATIM from the research lenses. Each carries my recommended
resolution. Items marked **[pre-resolved]** I have already folded into the plan with a sane default;
the human should confirm or override. Items marked **[NEEDS RULING]** change UX/behavior and should
be decided explicitly.

### Spec conflicts

> - [codebase] Spec §5 says 'Visual pattern matches ExportDialog.svelte exactly (native <dialog class="modal">'). ExportDialog uses $: reactive statements (Svelte 4 options API) whereas App.svelte has started mixing in $state/$effect runes. New WS-C components (SettingsPanel, section components) should follow ExportDialog's options-API pattern for internal consistency — the spec does not address this mixed-paradigm reality explicitly.

**[pre-resolved] Recommendation:** New components use **Svelte 4 options-API** to match the component library. Folded into the plan (WS-C tasks specify this).

> - [codebase] Spec §4.1 says 'SettingsPanel.svelte owns only the dialog shell' and describes it as a modal (<dialog>). But the current codebase uses showModal() for all modals (ExportDialog, ConflictModal, UnsavedChangesModal, KeyboardShortcutsModal). The spec's ASCII wireframe and 'Done' button pattern are consistent with this, but the spec does not specify whether it is showModal() (modal with backdrop) or show() (non-modal). All precedents use showModal() — the feature-research phase should confirm which is intended.

**[pre-resolved] Recommendation:** Use **`showModal()`** with `::backdrop` scrim, matching all four existing modals. Folded in.

> - [codebase] Spec §8 says add 'dialog:allow-open' to capabilities/default.json. The current capabilities description comment says 'The dialog permission backs the welcome screen's native Open file... picker only.' — this comment must be updated to also mention the vault picker; the comment is in the JSON file at line 4.

**[pre-resolved] Recommendation:** Update the description comment to mention the vault directory picker. Do NOT add the redundant `dialog:allow-open` permission (see review-history §8 below). Folded into WS-A.

> - [codebase] Spec §12 assigns 'ipc.rs REST-key command bodies' to WS-D, but per CLAUDE.md ipc.rs is WS-A owned. The spec's own footnote acknowledges this and resolves it correctly: 'the REST-key command bodies delegate to secrets.rs/obsidian.rs (WS-D) so ownership stays clean.' This is not a true conflict but a nuance implementers must track.

**[pre-resolved] Recommendation:** WS-A owns the `ipc.rs` command *signatures + registration + the thin body that calls helpers*; WS-D owns the *helper logic* in `obsidian.rs`/`secrets.rs`. To eliminate file overlap on `ipc.rs`, **WS-A writes all of `ipc.rs`** (command shells + bodies), and WS-D delivers the probe + any needed `pub` helpers in `obsidian.rs`/`secrets.rs` that the shells call. This keeps `ipc.rs` single-owner. Folded into the file map (WS-A owns `ipc.rs` entirely; WS-D owns `obsidian.rs` and tests). **Sequencing constraint:** WS-D's probe + helper signatures must land (or be stubbed with agreed signatures) before WS-A wires the bodies — see workstream dependency note.

> - [codebase] Spec §6 defines ConnStatus as an enum with 'ok/unauthorized/unreachable'. The existing obsidian_err() mapping in ipc.rs maps ObsidianError::Misconfigured to 'OBSIDIAN_MISCONFIGURED' and ObsidianError::NotRunning to 'OBSIDIAN_NOT_RUNNING'. The new ConnStatus enum is a separate type only used for test_obsidian_connection — it must NOT reuse the IpcError path but rather be a dedicated serializable struct/enum returned as IpcResult<ConnStatus>.

**[pre-resolved] Recommendation:** `ConnStatus` is a dedicated `#[serde(rename_all="snake_case")] enum { Ok, Unauthorized, Unreachable }` returned as `IpcResult<ConnStatus>`. Folded in.

> - [ux] Spec entry-point 'Toolbar gear' is unreachable from the welcome screen because the Toolbar is not mounted there. The welcome screen shows ThemeToggle in isolation (App.svelte line 561). Either the spec must add a gear to the welcome-screen top bar or explicitly accept that Cmd+, / palette are the only entry points from that screen.

**[RESOLVED — D1] Add a gear button to the welcome-screen `.welcome-top` cluster** beside ThemeToggle, so Settings is reachable before any file is open (first-run setup is the primary motivation). The welcome screen is rendered in `App.svelte`, so this gear (markup + click → open the panel) is **WS-A**, alongside the `settingsOpen` state. The separate toolbar gear (workspace view) is `Toolbar.svelte` → **WS-C** (C-5). Both trigger the same panel.

> - [ux] The spec states ThemeToggle is embedded for 'discoverability' but ThemeToggle already appears prominently on the welcome screen and in the toolbar right cluster. Moving it into the modal reduces its discoverability during normal use (no file open). The spec should clarify that it remains in the toolbar AND appears in the panel — not that it moves.

**[pre-resolved] Recommendation:** ThemeToggle **remains in toolbar + welcome screen AND also appears in AppearanceSection** (it is the same self-contained component reading the same store, so it stays in sync). Nothing is "moved". Folded in.

> - [ux] Spec section 5 says 'Visual pattern matches ExportDialog.svelte exactly' but ExportDialog is 440px wide and has no scrollable body. SettingsPanel with ObsidianSection + AppearanceSection will be taller than any existing modal. The '440px / no scroll' precedent is inadequate for this panel and the spec should specify the panel's height budget and scroll behavior explicitly.

**[RESOLVED — D2]** Panel `max-width: 520px`, body `max-height: min(70vh, 640px)` with `overflow-y: auto`; header ("Settings") and footer ("Done") pinned (non-scrolling), matching CommandPalette's scroll pattern.

> - [ux] The spec adds 'Settings...' as a palette command but App.svelte's buildCommands() (line 461) does not include it. The spec does not call out that buildCommands must be updated (it is in App.svelte, a WS-A-owned file). This is an ownership ambiguity: palette command registration is in WS-A (App.svelte) but the Settings command is part of the WS-C panel feature.

**[pre-resolved] Recommendation:** Palette command registration is **WS-A** (it lives in App.svelte). WS-A adds the `Settings…` command (before the activeTab guard, like `open`/`shortcuts`). Folded into WS-A tasks.

> - [architecture] CLAUDE.md FROZEN list (line 77) omits export_html/pdf/read_file_bytes that lib.rs:133-135 registers, so it is stale; update it (WS-A) when the new commands land.

**[pre-resolved] Recommendation:** WS-A updates the FROZEN command list in `CLAUDE.md` to include the already-shipped `export_html`/`export_pdf`/`read_file_bytes` AND the four new commands. Folded into WS-A.

> - [architecture] test_obsidian_connection cannot reuse rest_put, which writes a document; a distinct read-only probe is required and the spec does not call this out.

**[pre-resolved] Recommendation:** WS-D authors a new read-only probe — an authenticated `GET /vault/` (see D3 for the resolved endpoint + key sourcing). Folded into WS-D.

> - [architecture] set_rest_key/clear_rest_key returning unit risks a stale patchSettings clobbering rest_key_ref; they should return the updated Settings.

**[pre-resolved] Recommendation:** Both return `IpcResult<Settings>`; the frontend store sets the returned value (no separate refetch). This overrides spec §6's `()` return. Folded in.

> - [review-history] Spec §8 says to add 'dialog:allow-open' to capabilities/default.json, but dialog:default (already present) already includes allow-open per the generated schema at src-tauri/gen/schemas/macOS-schema.json. The permission is already granted. Adding it explicitly would be redundant but harmless; however, the spec comment should be corrected so implementers don't waste time verifying why it 'was already there' or add an unintentional duplicate.

**[pre-resolved] Recommendation:** Do NOT add `dialog:allow-open`. Only update the description comment (see capabilities conflict above). Folded into WS-A.

> - [review-history] Spec §5 says 'Visual pattern matches ExportDialog.svelte exactly ... on:cancel → preventDefault + close'. ExportDialog uses the Svelte 4 event directive syntax (on:cancel={handleCancel}). App.svelte uses Svelte 5 runes ($state, $effect, onclick=). The codebase is in a mixed Svelte 4/5 migration state — ExportDialog is still Svelte 4 (createEventDispatcher, on: directives) while App.svelte is Svelte 5. SettingsPanel implementers must decide which paradigm to use; using on: directives in a new component is consistent with ExportDialog but inconsistent with App.svelte's runes style.

**[pre-resolved] Recommendation:** Svelte 4 options-API + `on:` directives for the new components (see first conflict). Folded in.

> - [review-history] Spec §3 says 'localStorage stays the source of truth' for theme and 'the orphaned settings.theme field is left untouched'. But the spec also says AppearanceSection embeds ThemeToggle — which writes to localStorage via setThemeMode(). This means the Appearance section cannot use the patchSettings helper at all for theme, and must not call setSettings({...theme}). The spec is correct in its decision table but the implementation guidance in §4.2 ('bind a control to $settings.field; persist via patchSettings') would be WRONG for the theme field — implementers could accidentally wire ThemeToggle to patchSettings instead of setThemeMode.

**[pre-resolved] Recommendation:** AppearanceSection embeds `ThemeToggle` as-is (it self-manages via `theme.ts`). It MUST NOT touch `patchSettings`/`settings.theme`. A frontend test asserts `patchSettings({vaults})` does not mutate the theme. Folded into WS-C.

### Open risks

> - [codebase] Mixed Svelte 4/5 API in the same app … The new SettingsPanel.svelte and section components need a deliberate choice … Feature-research must decide the convention.

**Resolved:** Svelte 4 options-API (see above).

> - [codebase] test_obsidian_connection probe design: … if the Obsidian REST server is running and key is valid but no vault is configured, the probe would still return 'ok' … Human judgment needed on what the probe actually checks (health endpoint vs vault-list endpoint vs PUT probe).

**[RESOLVED — D3] Probe does an authenticated `GET /vault/`** (the Local REST API's vault-root file listing). This validates connectivity + auth **and** that the REST server's active vault is reachable, giving "Connected" a stronger guarantee than a bare root health check. Status mapping: 200 → `ok`; 401 → `unauthorized`; connection-refused/timeout → `unreachable`. WS-D adds a new read-only `probe_obsidian(key, port)` in `obsidian.rs` (does NOT reuse `rest_put`, which writes) that issues the `GET /vault/` request and maps the response to `ConnStatus`. Chip copy: "✓ Connected". Note: the Local REST API operates on whatever vault Obsidian currently has open, so `ok` means "server reachable, key accepted, vault listing succeeded" — it does not assert the listed vault matches the configured filesystem `vaults[0]` path.

> - [codebase] Keychain permission prompts on macOS: … New IPC tests for set_rest_key must also mock/guard keychain access — the spec mentions 'guarded/mocked per existing secrets test conventions' but no such mock currently exists in the codebase (secrets.rs has no unit tests). This is a gap the feature-research workstream must address.

**[RESOLVED — D4]** Add a **`mock` keyring backend behind `#[cfg(test)]`** in `secrets.rs` (the `keyring` v3 crate ships `keyring::mock` / `set_default_credential_builder` — wire it in a test-only `init_mock_keychain()` helper) so `set_rest_key`/`clear_rest_key`/`has_rest_key` Rust tests never touch the real OS keychain. Fallback only if the mock backend proves unavailable at the installed `keyring` version: gate keychain-touching tests with `#[cfg_attr(not(feature="keychain-tests"), ignore)]`. Touches `secrets.rs` (WS-D file) — ownership stays clean.

> - [codebase] settings_file_path() function is private in ipc.rs and not accessible from the new command bodies … They can call it directly since they're in the same module …

**Resolved:** REST-key command bodies live in `ipc.rs` (WS-A), same module, so they call the private `settings_file_path()` directly. No cross-module leak. Folded in.

> - [codebase] App.svelte handleExportObsidian (line 330) calls getSettings() directly each time … Once a settings store lands, these two sources of truth could diverge … either App.svelte's inline call is replaced by the store, or the store always re-fetches.

**[pre-resolved] Recommendation:** With eager-load (D5), replace the inline `getSettings()` in `handleExportObsidian` with a read from the `settings` store (`get(settings)`), so there is one source of truth. Folded into WS-A. (If human picks lazy-load in D5, keep the inline call.)

> - [codebase] Tauri 2 Svelte 5 plugin-dialog API: the vault picker needs 'directory: true' … The plugin-dialog v2 API shape for directory selection should be verified against actual installed types …

**[pre-resolved] Recommendation:** WS-C verifies `open({ directory: true })` against the installed `@tauri-apps/plugin-dialog` types during implementation; `svelte-check` is the gate. Folded into the WS-C vault-picker task verification.

> - [codebase] 88+ passing Rust tests … keychain behavior differs: macOS uses Keychain Access, Windows uses Credential Manager. Keychain-dependent tests need platform guards.

**Resolved by D4** (mock backend or `#[ignore]`). The probe tests use mockito (already a dev-dep) and are platform-neutral.

> - [ux] RISK: The 'save first, then test' constraint for REST key testing is UX-hostile for first-time setup … Consider allowing test_obsidian_connection to accept an optional raw key parameter for an in-session probe, storing it only in memory and never persisting it …

**[RESOLVED — D6] In-memory probe.** `test_obsidian_connection(key: Option<String>)` takes an optional raw key: when the password input has unsaved text, the frontend passes that typed key so the user can test **before** saving; when the field is empty/saved, it passes `None` and the command falls back to the saved key (via `rest_key_ref` → keychain). The raw key is used transiently for the probe only and is **never persisted** by this command (persistence stays exclusively in `set_rest_key`). Security note for implementers: this adds one more frontend→Rust path for the raw key — it must not be logged, echoed back, or written anywhere; it lives only as a function argument for the duration of the probe. The `ipc.ts` wrapper signature becomes `testObsidianConnection(key?: string)`.

> - [ux] RISK: The settings store's patchSettings optimistic update … has no rollback on IPC failure …

**[pre-resolved] Recommendation:** `patchSettings` snapshots the prior value, sets optimistically, and on `setSettings` rejection **reverts the store** and shows a toast ("Couldn't save settings"). Folded into the WS-C store task.

> - [ux] RISK: has_rest_key() is a round-trip IPC call … eager load at app start vs lazy load at first open …

**[RESOLVED — D5] Eager-load `settings` at app start** — removes first-open flicker and the null-state skeleton, and unifies `handleExportObsidian` onto the store. The store reads `rest_key_ref != null` from the loaded settings to derive `restKeyConfigured` (avoids a second `has_rest_key()` IPC on load). `handleExportObsidian` reads `get(settings)` instead of its inline `getSettings()` call (one source of truth).

> - [ux] RISK: The spec mentions 'Cmd+, / Ctrl+,' … does not specify whether this shortcut should work when a modal is already open …

**[pre-resolved] Recommendation:** Rely on native `showModal()` inertness — when another modal is open, the background `keydown` listener doesn't fire, so `⌘,` is naturally suppressed. No special handling. Folded in.

> - [ux] RISK: The 'Choose...' vault directory picker uses dialog:allow-open. This capability is not currently in capabilities/default.json … If the capability is forgotten, the vault picker silently fails …

**Resolved:** `dialog:default` already grants `allow-open` (TRAP 2). No capability change needed. WS-C wraps the `open()` call in try/catch and shows a toast on any Tauri error (defensive, in case of platform quirks). Folded into WS-C.

> - [ux] RISK: The Svelte 5 migration is underway … The spec does not call out which syntax SettingsPanel should use …

**Resolved:** Svelte 4 options-API.

> - [architecture] New REST-key command bodies must call settings_file_path (ipc.rs:889-911) or the key ref and vault list desync.

**Resolved:** Bodies live in `ipc.rs`, call `settings_file_path()` directly, and go through `settings_from_ipc()` conversion (string→PathBuf) — never bypass the IPC layer (TRAP 7). Folded in.

> - [architecture] WS-A and WS-D share this feature; WS-D must deliver the probe before WS-A writes command shells, and the tests/mod.rs registration straddles WS-B/WS-D, or they collide on merge.

**[pre-resolved] Recommendation:** Sequencing — **WS-D lands first** (probe + `pub` helper signatures + Rust tests). WS-A then wires `ipc.rs` shells against those signatures. `tests/mod.rs` already registers `settings_tests` and `obsidian_tests` (no new module needed — new tests append to existing files), so no `mod.rs` edit is required, avoiding the WS-B/WS-D collision. Folded in.

> - [architecture] Save-then-Test UX confuses users who Test before saving; needs an explicit decision.

**See D6.**

> - [architecture] No launch smoke gate; manual cargo tauri dev boot plus svelte-check required, not just unit tests.

**Resolved:** `cargo tauri dev` launch smoke + `svelte-check` are mandatory final gates (see workstream verification).

> - [review-history] RISK 1 — Keychain prompts on first use … The frontend must handle SecretsError from set_rest_key gracefully — the spec shows a toast pattern but does not specify what text to show on keychain denial.

**[pre-resolved] Recommendation:** On `set_rest_key` rejection, show toast "Couldn't save the key to your system keychain." ObsidianSection stays in entry state. Folded into WS-C.

> - [review-history] RISK 2 — test_obsidian_connection probe timeout in tests: … the Rust test for it (spec §11) must mock the network call (via mockito, which is already a dev-dependency in Cargo.toml) …

**Resolved:** WS-D probe tests use mockito (matching existing `obsidian_tests.rs`). Folded in.

> - [review-history] RISK 3 — Vault picker returns a file path not a directory on some platforms … A separate invocation with { directory: true } is needed … particularly on Windows where dialog behavior sometimes differs.

**Resolved:** WS-C uses `open({ directory: true, multiple: false })` and handles a `null`/array result; verified via the Windows CI matrix + manual smoke. Folded in.

> - [review-history] RISK 4 — settings store initialization race: … If called on first panel open … the store will be null while ObsidianSection renders. … The spec does not specify the null-state UI.

**Resolved by D5** (eager-load eliminates the null state during normal panel open). If lazy-load is chosen, ObsidianSection must render a skeleton — folded as a conditional task note.

> - [review-history] RISK 5 — ⌘, shortcut conflicts with macOS system Preferences shortcut … CodeMirror may intercept ⌘, … the shortcut will silently fail when the editor has focus.

**[RESOLVED — D7]** Register `⌘,` in the App.svelte global `keydown` handler (consistent with existing shortcuts) AND verify during the `cargo tauri dev` smoke that it fires with the editor focused. Escalation accepted: if CodeMirror swallows it, add a CodeMirror keymap entry (in EditorPane, WS-C) that calls `openSettings` and returns `true`. Ship the global handler first; add the keymap entry only if the smoke test shows it swallowed.

### Additional UX items surfaced (recommend folding in, human may defer)

- **Remove (clear_rest_key) is a guarded destructive action** [ux]. **[RESOLVED — D8]** Inline two-step confirm ("Remove key? [Confirm] [Cancel]") in ObsidianSection — matches the app's destructive-action guard convention. WS-C.
- **KeyboardShortcutsModal lacks a Settings (`⌘,`) row** [ux]. Recommendation: add a row to the "General" group. KeyboardShortcutsModal.svelte is WS-C-eligible (not in the frozen list) — assign to WS-C. Folded in as a WS-C task.
- **"Export to Obsidian" with no vault** currently toasts "No Obsidian vault configured yet." [ux]. Recommendation: extend that toast with an action ("Open Settings") wired to open the panel. App.svelte = WS-A. Folded into WS-A as a small task.
- **Toolbar density at 1080px** [ux]. **[RESOLVED — D9]** Place the gear immediately left of the `?` shortcuts button in the right cluster; icon-only (no label) so it does not change the responsive collapse. WS-C.

---

## 3. File map

### Create
| File | Workstream | Purpose |
|---|---|---|
| `src/lib/SettingsPanel.svelte` | WS-C | Dialog shell (showModal, `⌘,` close-on-cancel, scrim, scrollable body, Done) + section list |
| `src/lib/settings/ObsidianSection.svelte` | WS-C | Vault picker, subfolder, REST key (masked/entry), Test connection |
| `src/lib/settings/AppearanceSection.svelte` | WS-C | Embeds `ThemeToggle` |
| `src/lib/stores/settings.ts` | WS-C | `settings` writable + `loadSettings` + `patchSettings` (optimistic + rollback) |
| `src/tests/settings_panel.test.ts` | WS-C | Masked-vs-entry, patchSettings-on-change, empty-vault, chip states, theme-not-patched |

### Modify
| File | Workstream | Change |
|---|---|---|
| `src-tauri/src/obsidian.rs` | WS-D | New read-only `test_obsidian_connection` probe fn + `ConnStatus` enum; any `pub` helper the ipc shell needs |
| `src-tauri/src/secrets.rs` | WS-D | (test-only) mock-keychain init helper for tests (D4); no behavior change to prod path |
| `src-tauri/src/tests/obsidian_tests.rs` | WS-D | mockito tests: 200→ok, 401→unauthorized, refused/timeout→unreachable |
| `src-tauri/src/tests/settings_tests.rs` | WS-D | set/clear/has_rest_key persistence + rest_key_ref tests (guarded/mocked) |
| `src-tauri/src/ipc.rs` | WS-A | Add `ConnStatus` import/use + 4 async commands (spawn_blocking bodies) calling `settings_file_path`/`settings_from_ipc`/`secrets`/`obsidian` |
| `src/lib/types/ipc.ts` | WS-A | Mirror: `setRestKey`/`clearRestKey`/`hasRestKey`/`testObsidianConnection` wrappers + `ConnStatus` type |
| `src-tauri/src/lib.rs` | WS-A | Register the 4 commands in `generate_handler![]` |
| `src-tauri/capabilities/default.json` | WS-A | Update description comment to mention vault picker (NO new permission) |
| `src/App.svelte` | WS-A | Mount `SettingsPanel`; `settingsOpen` state; `Settings…` palette command; `⌘,` handler; eager `loadSettings()`; gear on welcome-top (D1); export-no-vault toast action (D); switch `handleExportObsidian` to store (D5) |
| `src/tests/ipc_contract.test.ts` | WS-A | Assert the 4 new wrappers exist |
| `CLAUDE.md` | WS-A | Update FROZEN command list (add export_html/pdf/read_file_bytes + 4 new) |
| `src/lib/Toolbar.svelte` | WS-C | Gear icon button → `dispatch('openSettings')` |
| `src/lib/KeyboardShortcutsModal.svelte` | WS-C | Add `⌘,` "Settings" row to General group |
| `tasks/lessons.md` | WS-A (post-merge) | Append any new lesson discovered during launch smoke |

**Zero file overlap:** `ipc.rs` is single-owned by WS-A (bodies + shells); WS-D owns only `obsidian.rs`, `secrets.rs`, and the two existing Rust test files. No file appears in two workstreams.

---

## 4. Workstreams (zero file overlap)

**Dependency / sequencing:** WS-D delivers the probe + `ConnStatus` + helper signatures FIRST (or
publishes agreed signatures up front). WS-A then wires `ipc.rs` shells against them. WS-C can build
the store + components in parallel against the typed `ipc.ts` contract (it depends only on WS-A's
`ipc.ts` mirror — coordinate the mirror signatures up front so WS-C is not blocked). Recommended
isolation: parallel worktrees per WS-A/WS-C/WS-D.

### WS-A — Foundation / IPC surface
Owns: `src-tauri/src/ipc.rs`, `src/lib/types/ipc.ts`, `src-tauri/src/lib.rs`,
`src-tauri/capabilities/default.json`, `src/App.svelte`, `src/tests/ipc_contract.test.ts`, `CLAUDE.md`.

### WS-C — Frontend (panel, store, sections, toolbar)
Owns: `src/lib/SettingsPanel.svelte`, `src/lib/settings/ObsidianSection.svelte`,
`src/lib/settings/AppearanceSection.svelte`, `src/lib/stores/settings.ts`,
`src/tests/settings_panel.test.ts`, `src/lib/Toolbar.svelte`, `src/lib/KeyboardShortcutsModal.svelte`.

### WS-D — Settings / Obsidian engine
Owns: `src-tauri/src/obsidian.rs`, `src-tauri/src/secrets.rs`,
`src-tauri/src/tests/obsidian_tests.rs`, `src-tauri/src/tests/settings_tests.rs`.

---

## 5. Tasks

### WS-D (lands first)

**D-1 · ConnStatus enum + read-only probe in `obsidian.rs`**
- File: `src-tauri/src/obsidian.rs`.
- Add `#[derive(Serialize)] #[serde(rename_all="snake_case")] pub enum ConnStatus { Ok, Unauthorized, Unreachable }`.
- Add `pub fn probe_obsidian(api_key: &str, port: u16) -> ConnStatus` — a **read-only authenticated
  `GET /vault/`** (vault-root listing; D3) using the existing `OnceLock` client + `PROBE_TIMEOUT_SECS`.
  Map: 2xx→`Ok`, 401→`Unauthorized`, connection-refused/timeout→`Unreachable`. Do NOT call `rest_put`.
- Add `pub fn test_obsidian_connection(settings_path: &Path, key: Option<String>) -> ConnStatus`
  (sync helper; WS-A wraps in `spawn_blocking`): resolve the key — use the passed `key` (typed,
  unsaved; D6) if `Some`, else load settings → `get_rest_key("obsidian-rest")`. No key available →
  `Unreachable`. Then call `probe_obsidian(key, REST_DEFAULT_HTTP_PORT)`. The raw `key` is used only
  for the probe and never persisted/logged.
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → compiles clean.

**D-2 · Probe tests (mockito)**
- File: `src-tauri/src/tests/obsidian_tests.rs`.
- Add tests mirroring the existing mockito harness, asserting `GET /vault/` is the probed path:
  server returns 200 → `ConnStatus::Ok`; 401 → `Unauthorized`; server down / no mock → `Unreachable`.
  Cover both key sources: explicit `Some(key)` and `None`-falls-back-to-saved (mock keychain).
- Verify: `cargo test obsidian --manifest-path src-tauri/Cargo.toml` → new tests pass, existing pass.

**D-3 · Test-only mock keychain helper (D4)**
- File: `src-tauri/src/secrets.rs`.
- Behind `#[cfg(test)]`, add `pub fn init_mock_keychain()` that installs `keyring`'s mock credential
  builder (or, if not viable, document the `#[ignore]` fallback). No change to the prod keychain path.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml` → builds; helper callable from tests.

**D-4 · set/clear/has rest-key Rust tests**
- File: `src-tauri/src/tests/settings_tests.rs`.
- Using a `TempDir` settings path (existing pattern) + the mock keychain: assert storing sets
  `rest_key_ref = "obsidian-rest"` and writes the key; clearing nulls both; `has` reflects state.
  These test the helper logic; if the command bodies live wholly in `ipc.rs` (WS-A), test the
  underlying `secrets` + `set_settings` composition here and leave the thin command to WS-A.
- Verify: `cargo test settings --manifest-path src-tauri/Cargo.toml` → pass.

### WS-A (after WS-D signatures fixed)

**A-1 · `ipc.ts` mirror — wrappers + ConnStatus type**
- File: `src/lib/types/ipc.ts`.
- Add `export type ConnStatus = 'ok' | 'unauthorized' | 'unreachable';` and wrappers
  `setRestKey(key): Promise<Settings>`, `clearRestKey(): Promise<Settings>`,
  `hasRestKey(): Promise<boolean>`, `testObsidianConnection(key?: string): Promise<ConnStatus>`
  (D6 — optional in-memory key) matching the existing wrapper style (`invoke<...>('command_name', args)`).
- Verify: `npx tsc --noEmit` → no errors.

**A-2 · `ipc.rs` — four async commands**
- File: `src-tauri/src/ipc.rs`.
- Add four `#[tauri::command] async fn`s with `spawn_blocking` bodies:
  - `set_rest_key(key: String) -> IpcResult<Settings>`: load via `settings_file_path()` →
    `secrets::store_rest_key("obsidian-rest", &key)` → set `rest_key_ref` → `set_settings` (through
    `settings_from_ipc`) → return updated `Settings`.
  - `clear_rest_key() -> IpcResult<Settings>`: `secrets::delete_rest_key` → null `rest_key_ref` →
    save → return updated `Settings`.
  - `has_rest_key() -> IpcResult<bool>`.
  - `test_obsidian_connection(key: Option<String>) -> IpcResult<ConnStatus>` (D6) — `spawn_blocking`
    delegating to `obsidian::test_obsidian_connection(settings_file_path(), key)`.
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → compiles; `cargo test --manifest-path src-tauri/Cargo.toml` → green.

**A-3 · Register commands in `lib.rs`**
- File: `src-tauri/src/lib.rs`.
- Add all four to `tauri::generate_handler![]` (TRAP 1 — single registration point).
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → compiles (missing registration = link error / runtime "command not found").

**A-4 · Capabilities comment fix**
- File: `src-tauri/capabilities/default.json`.
- Update the `description` to mention the vault directory picker. Do NOT add `dialog:allow-open`.
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → still valid (JSON parses at build).

**A-5 · App.svelte wiring**
- File: `src/App.svelte`.
- Import + mount `SettingsPanel` with `settingsOpen` state; add `Settings…` to `buildCommands()`
  before the activeTab guard; add `⌘,`/`Ctrl+,` to the global keydown handler before the no-tabs
  guard; call `loadSettings()` on init (eager, D5); add the gear to `.welcome-top` (D1); wire
  Toolbar `on:openSettings`; switch `handleExportObsidian` to read the `settings` store; extend the
  no-vault toast with an "Open Settings" action.
- Verify: `npx tsc --noEmit` && `npx svelte-check` → no errors.

**A-6 · ipc_contract test**
- File: `src/tests/ipc_contract.test.ts`.
- Assert the four new wrappers are present/callable against the IPC mock.
- Verify: `npm test` → passes.

**A-7 · CLAUDE.md FROZEN list**
- File: `CLAUDE.md`.
- Update the FROZEN command list to include `export_html`, `export_pdf`, `read_file_bytes`, and the
  four new commands.
- Verify: manual diff review (doc only).

### WS-C (parallel, against the agreed `ipc.ts` signatures)

**C-1 · `settings` store**
- File: `src/lib/stores/settings.ts`.
- `writable<Settings | null>`; `loadSettings()` (`settings.set(await getSettings())`);
  `patchSettings(partial)` optimistic with **prior-value snapshot + revert + toast on failure**.
  Expose a derived `restKeyConfigured` from `rest_key_ref != null` (avoids a second IPC; D5).
- Verify: `npx tsc --noEmit` → clean.

**C-2 · SettingsPanel shell**
- File: `src/lib/SettingsPanel.svelte` (Svelte 4 options-API).
- Native `<dialog class="modal">` + `showModal()`; `on:cancel` → preventDefault + close;
  scrollable body (`max-height: min(70vh,640px); overflow-y:auto`, D2), pinned header/footer; Done
  button; renders `<ObsidianSection/>` then `<AppearanceSection/>`. `export let open`; dispatch `close`.
- Verify: `npx svelte-check` → clean.

**C-3 · ObsidianSection**
- File: `src/lib/settings/ObsidianSection.svelte`.
- Vault: read-only path from `$settings.vaults[0]` + "Choose…" (`open({directory:true,multiple:false})`,
  try/catch → toast) → `patchSettings({vaults:[picked]})`; "Clear". Subfolder input →
  `patchSettings({default_export_subfolder})` on blur. REST key: masked "•••• saved" + Replace/Remove
  when `restKeyConfigured`, else password input + Save; Save → `setRestKey` (handle SecretsError toast);
  Remove → inline confirm (D8) → `clearRestKey`. Test connection (D6, in-memory probe): pass the
  typed password text when the entry field is non-empty, else `undefined` (saved key) →
  `testObsidianConnection(key?)` → chip (✓/⚠/✗) reusing the Toolbar spinner during flight. Test is
  enabled whenever a key is available (typed OR saved).
- Verify: `npx svelte-check` → clean.

**C-4 · AppearanceSection**
- File: `src/lib/settings/AppearanceSection.svelte`.
- Embed `<ThemeToggle/>`. MUST NOT call `patchSettings`/touch `settings.theme` (TRAP 3).
- Verify: `npx svelte-check` → clean.

**C-5 · Toolbar gear**
- File: `src/lib/Toolbar.svelte`.
- Add gear icon-button (icon-btn class, 17×17 SVG) left of `?` (D9) → `dispatch('openSettings')`;
  add `openSettings` to the typed event surface.
- Verify: `npx svelte-check` → clean.

**C-6 · KeyboardShortcutsModal row**
- File: `src/lib/KeyboardShortcutsModal.svelte`.
- Add `⌘,` "Settings" row to the General group.
- Verify: `npx svelte-check` → clean.

**C-7 · Frontend tests**
- File: `src/tests/settings_panel.test.ts`.
- Masked-vs-entry state from `restKeyConfigured`; `patchSettings` called on vault/subfolder change;
  empty-vault state; Test-connection chip states (mock each ConnStatus); assert `patchSettings({vaults})`
  does NOT mutate theme/localStorage.
- Verify: `npm test` → passes.

### Integration gate (all workstreams merged)
- `cargo build --manifest-path src-tauri/Cargo.toml` && `cargo test --manifest-path src-tauri/Cargo.toml` → green on macOS + Windows CI.
- `npm install && npm test && npx tsc --noEmit && npx svelte-check && npm run build` → all clean.
- **`cargo tauri dev`** (MANDATORY launch smoke, TRAP 6 / lessons): window opens; open panel via gear,
  palette, and `⌘,` (test `⌘,` with editor focused — D7); pick a vault; save a REST key (accept the
  macOS keychain prompt); run Test connection (expect `unreachable` with no Obsidian running, or `ok`
  if running); confirm theme toggle still updates `<html data-theme>`.

---

## 6. Out of scope (v1)

- Multiple vaults (single vault stored as a 1-element `Vec`).
- `export_on_save` toggle (field exists, unwired — no dead control).
- REST port override · HTTPS / cert-pinning · per-vault export targeting.
- Sidebar-nav settings layout (flat vertical stack for two sections; growth path documented, not built).
- Bumping `schema_version` (no breaking schema change — new fields go in `Settings::default()`).
- Any change to the prod keychain path in `secrets.rs` (only a test-only mock helper is added).
- Adding `dialog:allow-open` permission (already granted by `dialog:default`).
- Wiring `settings.theme` to the live UI (remains orphaned; localStorage via `theme.ts` is canonical).
