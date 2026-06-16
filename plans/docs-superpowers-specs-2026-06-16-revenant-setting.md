# Implementation Plan — Settings full-page refactor (#39)

**Source spec:** `docs/superpowers/specs/2026-06-16-revenant-settings-fullpage-refactor-design.md` (approved)
**Generated:** 2026-06-16 · Tier-2 feature-implement input

---

## 0. Decisions resolved (human ruling — 2026-06-16)

All five **DECISION NEEDED** items are **resolved by accepting the recommended resolution** stated at each marker below. Implementation proceeds on these rulings — they are no longer open:

1. **`rest_key_ref` single-writer split** — ✅ Confirmed. Key handlers (`set_rest_key`/`clear_rest_key`) keep calling the verbatim `crate::settings::set_settings`/`save_settings` writer; a **new** `set_settings_preserving_ref` module fn is used **only** by the ipc.rs `set_settings` command.
2. **`SettingsPage` element type** — ✅ Plain `<div role="region" aria-label="Settings">` with a manual focus model. **Not** a `<dialog showModal()>`.
3. **Esc handling location** — ✅ Guarded `Escape && settingsView !== null` branch in `App.svelte`'s `handleGlobalKeydown`, placed before the `metaKey||ctrlKey` early-return.
4. **Focus restoration on exit** — ✅ If `$tabList.length === 0`, focus the welcome "Open file…" button; otherwise restore via a `focusRestoreEl` ref captured on settings entry (introduced by WS-A).
5. **`open_file_request` while settings open** — ✅ Auto-exit settings (`settingsView = null`), then process the open.

Lower-confidence resolutions (settings-load null-state guard, `.chip-info` stronger `--accent` border with contrast verification, keychain-rollback double-failure documented with no retry + Windows write→delete race verified on real hardware via `#[ignore]`) are also accepted as recommended.

---

## 1. Header

### Goal
Promote the settings surface from a 600px master-detail `<dialog>` (`SettingsPanel.svelte`) to a full-window page (`SettingsPage.svelte`), and fix the four underlying issues the re-audit surfaced in the same pass:
1. **Data-corruption race** — `set_settings` writes the frontend payload verbatim, so an in-flight optimistic `patchSettings` carrying a stale `rest_key_ref: null` can clobber a just-saved REST key.
2. **Chips bypass the token system** — `ObsidianSection`/`AboutSection` hardcode hex + `:global([data-theme=dark])` overrides and reference four undefined CSS custom properties.
3. **Flat information hierarchy** — field labels render at the same `--fs-sm` scale as nav labels; no grouping primitive.
4. **A11y tabpanel-id defect** — all three tabs share `aria-controls="sp-panel"`.

### Approach
Full-window takeover. `App.svelte` replaces the boolean `settingsOpen` rune with a view-state union; when active, `<SettingsPage>` renders in place of the toolbar/tab/editor region while tab + document state stays alive in the stores (verified: `tabs` store, not local). Two new shared primitives (`SettingGroup`, `SettingRow`) re-express the three sections as grouped cards. A single `.chip` family moves to `global.css` on existing semantic tokens. The concurrency fix is a server-side single-writer discipline in Rust with no IPC-contract change.

### Architecture decisions (with the research finding that drove each)

| Decision | Driven by |
|---|---|
| **The read-modify-write lands as a NEW pure fn in `settings.rs` (e.g. `set_settings_preserving_ref`), called by the ipc.rs `set_settings` command** — NOT inline in the IPC handler. | [architecture] + [codebase]: `settings_tests.rs` imports settings-module fns directly (line 14-17) and tests the module without Tauri. A module fn is unit-testable; an inline handler body is not. The spec's "settings.rs if helper needed" is promoted to **required**. |
| **The key handlers (`set_rest_key`/`clear_rest_key`) keep calling the verbatim writer (`crate::settings::set_settings` → `save_settings`), which DOES write `rest_key_ref`.** Only the ipc.rs `set_settings` command routes through the new preserve-ref fn. | [architecture] + verified in code (ipc.rs 851-883): the key handlers call the *module* `set_settings`, not the IPC *command*. Single-writer discipline holds: key handlers are the only writers of `rest_key_ref`; the general settings path can never touch it. |
| **The merge fn routes through `save_settings`** (not a raw `serde_json::to_string` + `fs::write`). | [architecture]: `save_settings` carries the release-mode secret-leak assert (settings.rs 150-156). Replicating the write would bypass the guard. |
| **`set_settings` IPC command continues to return `()` (void), not the merged `Settings`.** | [ux]: `set_rest_key` returns `Settings` (CLAUDE.md lesson) to avoid stale-store races; `set_settings` must NOT, to avoid confusion. The frozen `ipc.ts` `setSettings` returns `Promise<void>`. |
| **`SettingsPage` is a plain `<div>` full-window region with a manual focus model + an explicit `keydown` Esc handler — NOT a `<dialog showModal()>`.** | [ux] DECISION NEEDED (see Conflict block) — recommended resolution. A modal `<dialog>` would compete with `App.svelte`'s global keydown handler and re-introduce a backdrop/cancel surface the spec explicitly removed. A `<div>` with a deterministic focus target matches "full-window takeover". |
| **Esc handling lives in `App.svelte`'s `handleGlobalKeydown`, guarded on the settings view-state being active**, before the existing `e.metaKey || e.ctrlKey` early-bail. | [codebase] + [review-history]: the current handler bails unless meta/ctrl (line 543); bare Esc is not caught. A new guarded branch is the minimal change and keeps Esc out of the section components. |
| **All App.svelte edits (view-state, palette deep-links, Esc, keyboard shortcut, focus-restore ref, all five call-sites) are owned by ONE workstream (WS-A).** | [ux] + [review-history]: `App.svelte` is WS-A-owned; the view-state, palette, and Esc all touch it. To avoid a file-ownership collision, no other workstream edits `App.svelte`. |
| **The chip `.chip-info` border becomes `var(--accent)` (a deliberately stronger steel-blue than the old `#bfdbfe` fallback).** | [codebase] + [ux] + [architecture]: the old `--accent-border` is a phantom token rendering a light-blue hardcoded fallback; remapping to the real `--accent` is the intended visual improvement. Implementor verifies contrast. |
| **The "phantom tokens" work is removing `var(--error*/--accent-border, #hex)` *references* in `ObsidianSection`/`AboutSection`, NOT deleting definitions from `tokens.css` (there are none).** | [ux] + [architecture] + [review-history]: grep confirms none of `--error`, `--error-soft`, `--error-border`, `--accent-border` are defined anywhere. The acceptance criterion "zero references to `--error*`/`--accent-border` remain" is correct; the "delete from tokens.css" framing is not. |

---

## 2. Conflicts & decisions needed (FOR THE HUMAN TO RULE ON BEFORE IMPLEMENTATION)

> The following are reproduced **verbatim** from the research lenses, grouped, each with a recommended resolution. Items marked **DECISION NEEDED** must be ruled on before WS-A/WS-C begin.

### Spec conflicts found

- **[codebase]** The spec states 'Sections retain the existing Svelte-4 options-API style' — all three section components already use Svelte 4 options-API (createEventDispatcher, onMount, $: reactive declarations) so this constraint is satisfied with no changes.
  - *Resolution:* No action. Confirmed satisfied.

- **[codebase]** The spec says 'No IPC-contract change — `set_settings(settings)` keeps its signature; only its on-disk behavior changes.' The current `set_settings` in ipc.rs (line 821) takes `settings: Settings` and calls `settings_from_ipc` which passes `rest_key_ref` straight through. The read-modify-write change is purely in the command body and does not touch the frozen contract. Verified safe.
  - *Resolution:* No action. Frozen contract respected. (Note: the read-modify-write moves into a settings.rs fn per the architecture decision above; the ipc.rs command body still calls it — contract unchanged.)

- **[codebase]** The spec references 'App.svelte keeps its Svelte-5 runes' — confirmed, App.svelte already uses `$state`, `$effect`, `$derived.by`. The new `settingsView` variable replaces `settingsOpen` with the same Svelte 5 pattern.
  - *Resolution:* No action. Proceed with `$state` view-state.

- **[codebase]** The spec says 'No `⌘W` binding for settings' — confirmed, `⌘W` is not handled in App.svelte's `handleGlobalKeydown`. No conflict.
  - *Resolution:* No action.

- **[codebase]** The spec mentions `WS-A module ownership: lib.rs only, all #[command] registration here` — `set_settings` is registered in lib.rs (per CLAUDE.md); the ipc.rs read-modify-write change is to the command body only, not the registration. Safe.
  - *Resolution:* No action. `lib.rs` untouched.

- **[codebase]** The spec's 'Esc closes SettingsPage' — the current dialog handles Esc via `on:cancel`. The new full-page component has no native Esc handling; a `keydown` listener must be added (either in SettingsPage or App.svelte's global keydown handler) to detect `Escape` and exit settings view. This implementation detail is not spelled out in the spec but is clearly required by the acceptance criteria.
  - *Resolution (recommended):* Add the Esc branch to `App.svelte handleGlobalKeydown`, guarded on `settingsView !== null`, placed before the `metaKey||ctrlKey` early-return. Keeps Esc logic out of the WS-C section components. **See DECISION NEEDED on element type below.**

- **[codebase]** The spec says 'No Done button' — SettingsPanel.svelte currently has a `<div class="sp-foot">` with a `.btn-done` button (lines 143-145). This entire footer region is deleted in SettingsPage; no Done button. No conflict.
  - *Resolution:* No action. Footer deleted in the rename/rewrite.

- **[ux]** The spec says 'App.svelte keeps its Svelte-5 runes' and 'sections retain the Svelte-4 options-API style' but the view-state change (replacing settingsOpen: boolean with a category-aware union) touches App.svelte's $state declaration (line 94). The spec does not explicitly flag this as a runes-file change, which may cause WS-C to treat the App.svelte edit as outside its scope. The workstream table assigns App.svelte to WS-A (Foundation) — this must be surfaced as a cross-workstream dependency.
  - *Resolution:* Resolved by workstream design: **ALL App.svelte edits are WS-A**. WS-C never touches App.svelte. The `SettingsPage` ↔ App.svelte wiring contract (props/events) is frozen in WS-A Task A1 so WS-C can build against it.

- **[ux]** The spec says 'No IPC-contract change' and the FROZEN contract is respected, but section 4 says set_settings (Rust) becomes a read-modify-write. The frontend patchSettings store already sends the full Settings object including rest_key_ref (settings.ts line 57: const next = {...prior, ...partial}). The Rust change is transparent to the TS contract, but the existing test at settings_panel.test.ts line 121 asserts 'set_settings returns void' — this will remain true, but the test's mock (mockInvoke.mockResolvedValueOnce(undefined)) documents the wrong return shape if set_settings is ever changed to return the preserved Settings. The spec should clarify set_settings continues to return void (not the updated Settings) to avoid confusion with set_rest_key's Settings return.
  - *Resolution:* **`set_settings` continues to return `()` / `Promise<void>`.** Documented in the architecture table. WS-D Rust fn returns `Result<(), SettingsError>`; ipc.rs command returns `IpcResult<()>`. No `settings_panel.test.ts` mock change required for return shape.

- **[ux]** The spec lists 'Delete the four phantom tokens' including --error, --error-soft, --error-border, --accent-border from tokens.css, but tokens.css (lines 1-207) does NOT define any of these four tokens — they appear only as CSS custom property references with inline fallbacks inside ObsidianSection.svelte (e.g. var(--error, #dc2626)) and AboutSection.svelte (var(--accent-border, #bfdbfe)). There is nothing to delete from tokens.css. The actual work is removing the var(--error, …) fallback references in the component files. The spec's framing of 'delete from tokens.css' is inaccurate and will confuse implementors.
  - *Resolution:* **Do NOT edit `tokens.css` for phantom tokens** (nothing to delete). The work is replacing the `var(--error*/--accent-border, #hex)` references in `ObsidianSection.svelte` and `AboutSection.svelte` with `--danger`/`--danger-soft` (danger-btn/link) and the shared chip family. Acceptance criterion "zero references to `--error*`/`--accent-border` remain" stands as the verification.

- **[architecture]** Spec §3 calls --error/--error-soft/--error-border/--accent-border 'the four phantom tokens' and says to 'delete' them — but they are not defined anywhere to delete; they only exist as var() fallback references inside the chip/danger hex that is already being removed. Reword the acceptance criterion 'zero references to --error*/--accent-border remain' (it is correct as written) but drop any 'remove token definitions from tokens.css' implication — there are none. The work is: replace the var(--error,...)/var(--accent-border,...) references in ObsidianSection.svelte and AboutSection.svelte.
  - *Resolution:* Same as above. `tokens.css` is NOT in the file map for this reason.

- **[architecture]** Spec §9/§4 says the set_settings change is in ipc.rs (with 'settings.rs if helper needed'). For unit-testability the read-modify-write MUST be a settings.rs module fn (settings_tests.rs tests the module directly, not the Tauri command). Treat settings.rs as a required edit, not optional. The ipc.rs handler currently calls crate::settings::set_settings(&path, store_settings) (line 825) — that call site changes to the new merge fn.
  - *Resolution:* **Accepted.** New fn `set_settings_preserving_ref(path, incoming) -> Result<(), SettingsError>` in settings.rs (WS-D). ipc.rs `set_settings` command (WS-A) changes its call site from `crate::settings::set_settings` to `crate::settings::set_settings_preserving_ref`. Cross-workstream contract: WS-D delivers the fn signature first (Task D1) so WS-A can wire it (Task A5).

- **[architecture]** Spec §4 describes set_settings as a pure read-modify-write preserving rest_key_ref, but does not address that set_rest_key/clear_rest_key ALSO do their own read-modify-write then call settings::set_settings to WRITE rest_key_ref. If set_settings now always preserves the on-disk rest_key_ref, then set_rest_key/clear_rest_key can no longer use the same set_settings path to CHANGE rest_key_ref (it would be ignored). They must write rest_key_ref via a separate path (a distinct module fn that DOES set the ref, or save_settings directly). This is the single most important under-specified interaction and needs an explicit decision before implementation.
  - **DECISION NEEDED — recommended resolution (high confidence):** Keep the existing verbatim writer `crate::settings::set_settings` (→ `save_settings`) for the key handlers — it already writes the full struct including `rest_key_ref`. Introduce the NEW `set_settings_preserving_ref` used ONLY by the ipc.rs `set_settings` command. Single-writer discipline: key handlers are the only callers that write `rest_key_ref`; the general path never can. The key handlers already call the *module* fn (verified ipc.rs 860, 878), not the IPC command, so this split is already structurally in place — no change to the key handlers' write path is needed.

- **[review-history]** Spec §4 states 'set_settings (Rust) becomes a read-modify-write...'. In reality the ipc.rs `set_settings` command currently takes a `Settings` struct and passes it straight through `settings_from_ipc` to disk. The ipc.rs/lib.rs workstream ownership (WS-A) means this change must happen in ipc.rs, not settings.rs — the spec's file listing correctly says 'src-tauri/src/ipc.rs' but implementers should be aware that settings.rs's `set_settings` helper is a thin pass-through that must NOT be changed (it is correct); only the ipc.rs command wrapper changes.
  - *Resolution / clarification:* The ipc.rs command body **does** change (its call site swaps to the new fn — WS-A). The existing `crate::settings::set_settings` pass-through is **NOT changed** (the key handlers depend on its verbatim behavior). A **NEW** fn `set_settings_preserving_ref` is **added** to settings.rs (WS-D). This reconciles the two lenses: ipc.rs changes (call site), settings.rs gains a new fn, the old settings.rs fn is untouched.

- **[review-history]** Spec §8 testing says 'Update / replace settings_panel.test.ts and settings_panel_shell.test.ts for the full-page shell.' The shell test reads the component source file by absolute path at test load time — renaming SettingsPanel.svelte to SettingsPage.svelte will cause the test to throw ENOENT synchronously, breaking the entire test suite before the new assertions are even written. The rename and test update must happen atomically in the same commit.
  - *Resolution:* **Atomic within WS-C.** The rename (`SettingsPanel.svelte` → `SettingsPage.svelte`) and the `settings_panel_shell.test.ts` path/assertion rewrite are the SAME task (WS-C Task C1) and the SAME commit. WS-C tasks are sequenced so the test suite never observes a missing file.

- **[review-history]** Spec §2 says 'Sections retain the existing Svelte-4 options-API style.' App.svelte is Svelte-5 runes and communicates with SettingsPanel via `open` prop + `on:close` event. The new SettingsPage will be Svelte-4 (options-API) like the other modals, mounted from App.svelte with Svelte-5 runes. The transition from `on:close` to whatever binding pattern App.svelte uses must be consistent with how other Svelte-4 components (ConflictModal, KeyboardShortcutsModal) are wired in Svelte-5 App.svelte — they use `on:close` today, which Svelte-5 tolerates for Svelte-4 child components.
  - *Resolution:* `SettingsPage` is Svelte-4 options-API, dispatches `on:close` (matching ConflictModal/KeyboardShortcutsModal). App.svelte wires `<SettingsPage category={...} on:close={() => settingsView = null} on:navigate={...} />`. The component contract is frozen in WS-A Task A1 and consumed by WS-C.

### Open risks

- **[codebase] ESCAPE KEY HANDLING for SettingsPage:** The current dialog uses the browser's native `cancel` event for Esc. A full-page component needs an explicit `keydown` listener. The spec says 'Esc exits' but does not specify whether the listener lives in SettingsPage itself or in App.svelte's existing `handleGlobalKeydown`. A decision is needed: if added to `handleGlobalKeydown`, it must be guarded so it only fires when settings is the active view and does not interfere with the palette/modal Esc handling.
  - *Resolution (recommended):* Add to `handleGlobalKeydown`, guarded `if (settingsView !== null && e.key === 'Escape')` → `settingsView = null`, placed BEFORE the `metaKey||ctrlKey` early-bail. Verify it does not fire when a palette/modal is also open (guard ordering: modal/palette Esc handled first, or settings guard checks no modal is open).

- **[codebase] TRANSITION CONFLICT:** App.svelte conditionally renders workspace vs. welcome with `{#if $tabList.length === 0}`. SettingsPage must render in place of the entire workspace block. The cleanest insertion point is a third branch (`{:else if settingsView !== null}`), but the exact conditional structure for a three-way branch (welcome / settings / workspace) needs care to avoid the Suminagashi bloom animation or tab state being reset.
  - *Resolution:* Make settings the OUTERMOST branch: `{#if settingsView !== null}<SettingsPage/>{:else if $tabList.length === 0}welcome{:else}workspace{/if}`. This guarantees settings overlays both welcome and workspace, and because tab/document state is in stores it is preserved. Verify the welcome bloom animation is keyed so it does not replay on settings exit.

- **[codebase] PATCHSETTINGS CONCURRENCY WINDOW:** `patchSettings` still sends the full merged Settings object (including store `rest_key_ref`) at call time. Between frontend read and Rust execution, a `set_rest_key` could update on-disk `rest_key_ref`. The Rust guard is the correct fix, but the frontend cannot be tightened further without an IPC contract change.
  - *Resolution:* Accept. The server-side preserve-ref fn IS the fix. No frontend change. Documented as resolved-by-design.

- **[codebase] ROLLBACK ATOMICITY:** `set_rest_key` rollback (delete keychain entry if settings write fails) is correct in principle, but `delete_rest_key` itself can fail. If both `set_settings` and cleanup `delete_rest_key` fail, keychain and settings remain orphaned. The spec does not prescribe behavior for this double-failure.
  - *Resolution:* Do NOT add a retry loop. On double-failure, return the ORIGINAL settings-write error (the rollback failure is logged/swallowed via `let _ = delete_rest_key(...)`). Document the orphan edge case in a code comment and in `tasks/lessons.md`.

- **[codebase] ABOUTSECTION CHIP-INFO TOKEN:** `.chip-info` border moves from `var(--accent-border, #bfdbfe)` (light blue) to `var(--accent)` (#3D6DA0 steel blue) — visually stronger. Deliberate improvement; verify contrast.
  - *Resolution:* Accepted as a deliberate improvement (per architecture decision). Verify visually after build.

- **[codebase] SETTINGS_PANEL_SHELL.TEST.TS SOURCE-READ PATTERN:** The shell test reads `src/lib/SettingsPanel.svelte` and asserts CSS invariants; deleting the file fails the test immediately. Path must change to `src/lib/SettingsPage.svelte` and assertions rewritten (no `<dialog>`, no `[open]`-gated display rule).
  - *Resolution:* WS-C Task C1 (atomic rename + test rewrite). New invariant: assert the `SettingsPage` root has no unconditional `display`/visibility rule that bleeds into the app, and is only rendered behind the `settingsView` guard (the latter verified in App.svelte integration test).

- **[codebase] WORKSTREAM BOUNDARY:** App.svelte is WS-A-owned. The view-state change, palette deep-links, and Esc handler are all in App.svelte. If feature-implement runs parallel workstreams, WS-A cannot be touched by WS-C/WS-D. All App.svelte edits must be in a single workstream.
  - *Resolution:* **All App.svelte edits are WS-A only.** Reflected in the workstream table — zero file overlap.

- **[ux] FOCUS RESTORATION TO WELCOME SCREEN:** When on the welcome screen (no tabs) and exiting SettingsPage, there is no document region/editor to receive focus. The spec says 'returns focus sensibly to the document region' but that region does not exist. Decision needed: focus → 'Open file…' button, drop zone, or Back-to-document control.
  - **DECISION NEEDED — recommended:** On exit, if `$tabList.length === 0`, focus the welcome 'Open file…' button (App.svelte ~line 616); otherwise focus the previously-active pane via a `focusRestoreEl` ref captured on settings entry. WS-A introduces the `focusRestoreEl` ref.

- **[ux] FULL-WINDOW PAGE VS. NATIVE DIALOG FOR FOCUS TRAP:** Spec describes 'full-window takeover' but does not specify `<dialog>` vs `<div>`. Every other modal uses native `<dialog>` for free focus-trap + Esc. A `<div>` needs a manual focus trap or Tab escapes the surface. A `<dialog showModal()>` Esc competes with App.svelte's global keydown (line 543). Decision needed before WS-C begins.
  - **DECISION NEEDED — recommended:** Use a plain `<div role="region" aria-label="Settings">`. Rationale: it is a full-window takeover, not a transient overlay; the toolbar/tab/editor are not rendered behind it (outermost `{#if}` branch), so there is nothing to Tab into. A lightweight focus management (focus the active panel on entry/category change; restore on exit) satisfies the a11y requirement without a `<dialog>` Esc collision. **If the human prefers a `<dialog showModal()>`, the Esc branch in App.svelte must be removed and `on:cancel` used instead — flag for WS-A/WS-C coordination.**

- **[ux] SETTINGS LOAD RACE ON FAST ⌘, PRESS:** If a user opens settings before eager `loadSettings()` resolves, SettingsPage renders with `settings=null`; controls show empty/misconfigured state. The empty-vault guard in patchSettings can pass with `vaults:[]` before load completes. The spec defines no loading skeleton or disabled-until-loaded behavior.
  - *Resolution (recommended):* Reuse the existing `aria-live="polite"` 'Loading…' pattern (AboutSection version field). Gate the vault picker / subfolder / REST-key controls behind `settings != null` (render a 'Loading…' placeholder row when null). WS-C scope. Low practical risk but cheap to guard.

- **[architecture] Decision needed: how do set_rest_key/clear_rest_key persist rest_key_ref once set_settings refuses to touch it?** Recommend keeping the low-level settings.rs save_settings/set_settings (writes verbatim) for the key handlers, and introducing a NEW set_settings_preserving_ref used only by the ipc.rs set_settings command. A human should confirm this split before coding.
  - **DECISION NEEDED — recommended (high confidence):** Confirm the split exactly as stated. Already structurally in place (key handlers call the module fn directly). This is the single most important decision; see the matching spec-conflict above.

- **[architecture] The runtime assert in settings.rs save_settings checks the serialized JSON does NOT contain "password"/"api_key"/"secret".** The new merge fn must route through save_settings (or replicate the assert) so the secret-leak guard is not bypassed. Do not write merged settings with raw serde_json + fs::write that skips the guard.
  - *Resolution:* **`set_settings_preserving_ref` ends with a `save_settings(path, &merged)` call.** Verification: a test asserting the secret-guard still fires through the new path (or simply that the merge fn delegates to `save_settings`).

- **[architecture] aboutChipState.ts returns chipClass as a combined string 'chip chip-ok'.** When `.chip` moves to global.css, ensure AboutSection no longer scopes a local `.chip` that would win specificity, and that Svelte scoping does not strip the now-unused local classes in a way that breaks the role="status" chips.
  - *Resolution:* Delete the local `.chip*` blocks entirely in both section components; the global `.chip` (unscoped in global.css) applies. No `:global()` needed for global.css rules. Verify rendered chips pick up global styles and no orphaned `:global` selectors remain (svelte-check catches the latter).

- **[architecture] Per CLAUDE.md, ConnStatus is a success-typed Serde enum re-exported in ipc.rs from obsidian.rs (line 841) and must NOT be routed through IpcError.** The chip refactor touches ObsidianSection test-connection UI; ensure the chip-state mapping (testing/ok/warn/err) is not accidentally rewired through an error path.
  - *Resolution:* Chip refactor is CSS-class-only. Do NOT touch the `ConnStatus` → chip-state mapping logic. Verification: `ipc_contract.test.ts` and the ConnStatus chip-transition assertions in `settings_panel.test.ts` (line ~237) stay green.

- **[architecture] Focus management (spec §5) is the highest-effort a11y item and is easy to regress.** The current modal uses `<dialog>` native focus trapping; a full-window page loses that and must implement focus return manually. Recommend an explicit focus-target ref on the editor/welcome region so 'Back to document' has a deterministic target. Verify against the A11y A- baseline.
  - *Resolution:* WS-A introduces `focusRestoreEl` ref (see FOCUS RESTORATION decision). WS-C focuses the active panel on entry/category change. Re-check against the A11y A- baseline after implementation.

- **[review-history] The keychain rollback in `set_rest_key` requires deleting a just-written keychain entry if `set_settings` fails.** On macOS deletion is reliable; on Windows Credential Manager, back-to-back write→delete in the same `spawn_blocking` may race. The mock keychain does not persist across `Entry::new()` calls, so the rollback path is currently untestable without the real OS keychain. Apply the `#[ignore]` integration test pattern with a human verify step on real hardware.
  - *Resolution:* Write the rollback unit test against the mock where possible (assert `delete_rest_key` is invoked on the failure path via a forced settings-write error). Mark the real-keychain Windows verification as an `#[ignore]` integration test + a manual verify step. Document in `tasks/lessons.md`.

- **[review-history] Full-window takeover means SettingsPage renders in place of toolbar/tab bar/editor, but $tabList/editor/watcher state stay alive.** If an `open_file_request` Tauri event arrives while settings is open (file dropped on Dock icon), App.svelte's listener fires regardless of view state. Whether it should switch back to document view or queue the open is unspecified.
  - **DECISION NEEDED — recommended:** On `open_file_request` while `settingsView !== null`, auto-exit settings (`settingsView = null`) THEN process the open, so the newly-opened file is visible. Low-effort (one guard in the existing listener). WS-A scope. Confirm this is the desired behavior vs. queueing.

- **[review-history] Per-category palette deep-links** add commands to `buildCommands` (App.svelte ~line 465, `$derived.by`). Each passes a `category` argument to the new settings view-state setter. Command registration lives in WS-A's owned file (App.svelte). If WS-A and WS-C both modify App.svelte, that is a file ownership collision the CLAUDE.md table does not resolve. A human decision on workstream file ownership is needed.
  - *Resolution:* **All App.svelte edits (including palette) are WS-A.** No collision — WS-C never edits App.svelte. Resolved by workstream design.

- **[review-history] The current Esc handling is `on:cancel` on the `<dialog>`.** With a full-page component there is no native `cancel`. Esc must be handled in `handleGlobalKeydown`, which currently bails unless `metaKey||ctrlKey` (line 543). A new guard branch for `e.key === 'Escape' && settingsView` must be added before that bail; failing to do so means Esc silently does nothing.
  - *Resolution:* Same as the ESCAPE KEY decision above. WS-A adds the guarded branch before the meta/ctrl early-return.

- **[review-history] The source-invariant CSS test in settings_panel_shell.test.ts (guards `.sp[open]` display bug) needs a replacement for SettingsPage.svelte.** The underlying concern — page-level CSS accidentally hiding/showing wrong content — still applies. A new source-invariant test should guard that SettingsPage's root has no unconditional visibility rule. The exact invariant is unspecified.
  - *Resolution (recommended invariant):* Assert `SettingsPage.svelte` source contains no `<dialog>` and no `[open]` selector; assert the root element has no `display:none`/unconditional `visibility` rule that could bleed. Pair with an App.svelte integration test asserting SettingsPage only renders when `settingsView !== null`. WS-C scope.

### Cross-workstream contracts (frozen before parallel work begins)

1. **`SettingsPage` component API** (WS-A defines, WS-C implements): props `category: 'general'|'integrations'|'about'`; events `on:close` (exit to document), `on:navigate` (category change, optional if internal). Frozen in WS-A Task A1.
2. **`set_settings_preserving_ref(path: &PathBuf, incoming: Settings) -> Result<(), SettingsError>`** (WS-D delivers, WS-A consumes). Frozen in WS-D Task D1.

---

## 3. File map

### Create
| Path | Workstream | Purpose |
|---|---|---|
| `src/lib/settings/SettingGroup.svelte` | WS-C | Card-wrapper primitive (Svelte-4 options-API) |
| `src/lib/settings/SettingRow.svelte` | WS-C | Label + helper + control-slot row primitive |
| `src/lib/SettingsPage.svelte` | WS-C | Full-window shell (renamed from SettingsPanel) |

### Modify
| Path | Workstream | Change |
|---|---|---|
| `src/App.svelte` | WS-A | view-state union, 3 palette deep-links, ⌘, shortcut, Esc guard, 5 call-sites, `focusRestoreEl`, outermost `{#if settingsView}` branch, `open_file_request` guard |
| `src-tauri/src/ipc.rs` | WS-A | `set_settings` call-site → `set_settings_preserving_ref`; `set_rest_key` keychain rollback on settings-write failure |
| `src-tauri/src/settings.rs` | WS-D | NEW `set_settings_preserving_ref` fn (read-modify-write, preserves on-disk `rest_key_ref`, routes through `save_settings`) |
| `src-tauri/src/tests/settings_tests.rs` | WS-D | lost-update regression test; keychain-rollback test (`#[ignore]` real-keychain variant where needed) |
| `src/lib/styles/global.css` | WS-C | add `.chip` + `.chip-{ok,warn,err,info}` family on semantic tokens |
| `src/lib/settings/ObsidianSection.svelte` | WS-C | re-express as SettingGroup/SettingRow; delete local chip hex + `:global` dark overrides; replace `var(--error*/...)` danger-btn/link refs with `--danger`/`--danger-soft`; field-label → `--fs-base`/`--fw-semibold` |
| `src/lib/settings/AboutSection.svelte` | WS-C | re-express as SettingGroup/SettingRow; delete local chip hex + dark overrides; replace `var(--accent-border, …)`; field-label → `--fs-base`/`--fw-semibold` |
| `src/lib/settings/AppearanceSection.svelte` | WS-C | re-express as SettingGroup/SettingRow; field-label → `--fs-base`/`--fw-semibold` |
| `src/tests/settings_panel_shell.test.ts` | WS-C | repoint to `SettingsPage.svelte`; rewrite invariants (no `<dialog>`/`[open]`) |
| `src/tests/settings_panel.test.ts` | WS-C | adapt chip-class assertions; keep ConnStatus chip-transition + `set_settings`-returns-void assertions |
| `tasks/lessons.md` | WS-A | document rollback double-failure edge case + Windows keychain race |

### Delete
| Path | Workstream | Note |
|---|---|---|
| `src/lib/SettingsPanel.svelte` | WS-C | renamed → `SettingsPage.svelte` (atomic with test repoint in C1) |

### Explicitly NOT touched
- `src/lib/styles/tokens.css` — no phantom-token definitions exist to delete (see conflicts).
- `src-tauri/src/lib.rs` — WS-A-owned; command registration unchanged (no new commands).
- `src/lib/types/ipc.ts`, `src-tauri/src/ipc.rs` IPC type/command surface — FROZEN, signatures unchanged.
- `src/lib/theme.ts` — TRAP 3 holds; AppearanceSection must not call `patchSettings` or touch `settings.theme`.
- `src/lib/Toolbar.svelte` `openSettings` dispatch — App.svelte's handler for it changes (WS-A), but Toolbar's dispatch is unchanged.

---

## 4. Workstreams (zero file overlap)

| WS | Owns (files) |
|---|---|
| **WS-A (App shell + Rust IPC + lessons)** | `src/App.svelte`, `src-tauri/src/ipc.rs`, `tasks/lessons.md` |
| **WS-C (Frontend components + tests)** | `src/lib/SettingsPage.svelte` (+ delete `SettingsPanel.svelte`), `src/lib/settings/SettingGroup.svelte`, `src/lib/settings/SettingRow.svelte`, `src/lib/settings/AppearanceSection.svelte`, `src/lib/settings/ObsidianSection.svelte`, `src/lib/settings/AboutSection.svelte`, `src/lib/styles/global.css`, `src/tests/settings_panel_shell.test.ts`, `src/tests/settings_panel.test.ts` |
| **WS-D (Rust settings module + Rust tests)** | `src-tauri/src/settings.rs`, `src-tauri/src/tests/settings_tests.rs` |

**Sequencing note:** WS-D Task D1 (deliver `set_settings_preserving_ref` signature) and WS-A Task A1 (freeze `SettingsPage` component API) are the two contract-defining tasks. They should land first so WS-A's ipc.rs wiring (A5) and WS-C's shell (C1) can build against stable contracts. WS-A's App.svelte integration (A2-A4) can proceed against the frozen component API in parallel with WS-C building the component.

---

## 5. Tasks

### WS-A — App shell + Rust IPC

**A1 — Freeze the `SettingsPage` component contract + replace view-state in App.svelte**
- File: `src/App.svelte`
- Replace `let settingsOpen = $state(false)` (line ~94) with `let settingsView: 'general' | 'integrations' | 'about' | null = $state(null)`.
- Add `let focusRestoreEl: HTMLElement | null = $state(null)` (or a non-reactive `let`).
- Define the consumed contract for `<SettingsPage category={settingsView} on:close={...} />` (WS-C builds to this).
- Update the welcome-gear button (line ~588) and any direct `settingsOpen = true` reference to set `settingsView = 'general'`.
- Verify: `npx tsc --noEmit` → no errors; `svelte-check --tsconfig ./tsconfig.json` → no new errors.

**A2 — Render branch + transition**
- File: `src/App.svelte`
- Make settings the outermost render branch: `{#if settingsView !== null}<SettingsPage category={settingsView} on:close={exitSettings}/>{:else if $tabList.length === 0}…welcome…{:else}…workspace…{/if}`.
- Add fade/slide transition gated on `--dur-*`/`--ease-*` + `@media (prefers-reduced-motion)` (tokens auto-zero per tokens.css line 202).
- Note: `SettingsPage.svelte` may not exist yet — stub the import or coordinate with WS-C C1. Use a `// @ts-expect-error pending C1` only if needed and remove once C1 lands.
- Verify: `npm run build` → succeeds once WS-C C1 has landed; until then `svelte-check` may flag the missing import (expected, tracked).

**A3 — Esc + keyboard shortcut + open_file_request guard**
- File: `src/App.svelte`
- In `handleGlobalKeydown`: before the `if (!(e.metaKey || e.ctrlKey)) return` early-bail (line ~543), add `if (settingsView !== null && e.key === 'Escape') { e.preventDefault(); exitSettings(); return; }`.
- Update the `','` shortcut (line ~552) to set `settingsView = 'general'`.
- Add `exitSettings()` helper: restores focus to `focusRestoreEl` (or welcome 'Open file…' button if `$tabList.length === 0`), then `settingsView = null`.
- In the `open_file_request` listener: if `settingsView !== null`, set `settingsView = null` before processing the open.
- Verify: `svelte-check` clean; manual reasoning that Esc does not fire when a palette/modal is also open (guard ordering).

**A4 — Palette deep-links + remaining call-sites**
- File: `src/App.svelte`
- In `buildCommands` (~line 465-483) replace the single `Settings…` command with three: `Settings: General` → `settingsView='general'`, `Settings: Integrations` → `'integrations'`, `Settings: About` → `'about'`.
- Update remaining `settingsOpen = true` call-sites (lines ~346, 482, 552, 587, 658) to the appropriate `settingsView` value (capture `focusRestoreEl` from `document.activeElement` on entry).
- Verify: `npx tsc --noEmit` clean; `npm test` palette command assertions pass once WS-C test updates land.

**A5 — ipc.rs `set_settings` call-site swap + `set_rest_key` rollback**
- File: `src-tauri/src/ipc.rs`
- Change `set_settings` command body (line ~824-825): replace `crate::settings::set_settings(&path, store_settings)` with `crate::settings::set_settings_preserving_ref(&path, store_settings)`. Keep return type `IpcResult<()>`.
- In `set_rest_key` (line ~851-865): wrap the `crate::settings::set_settings(&path, settings.clone())` call so that on `Err`, call `let _ = crate::secrets::delete_rest_key("obsidian-rest");` (swallow rollback error, return original settings-write error). Add a comment documenting the double-failure orphan edge case.
- Depends on: WS-D D1 (fn exists).
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → succeeds; `cargo test --manifest-path src-tauri/Cargo.toml` → green.

**A6 — Document edge cases in lessons.md**
- File: `tasks/lessons.md`
- Add entries: (1) keychain rollback double-failure returns the original error, no retry; (2) Windows Credential Manager write→delete race requires real-hardware verification (`#[ignore]` test); (3) `set_settings` is preserve-ref single-writer — never write `rest_key_ref` through the general settings path.
- Verify: `git diff --check` on `tasks/lessons.md` → no whitespace/NUL errors; `file tasks/lessons.md` → ASCII/UTF-8 text.

### WS-C — Frontend components + tests

**C1 — Atomic rename `SettingsPanel.svelte` → `SettingsPage.svelte` + repoint shell test**
- Files: create `src/lib/SettingsPage.svelte` (from SettingsPanel content), delete `src/lib/SettingsPanel.svelte`, rewrite `src/tests/settings_panel_shell.test.ts`.
- Convert the `<dialog open>` shell to a full-window `<div role="region" aria-label="Settings">` with top bar (`‹ Back to document` button dispatching `on:close`), left rail, scrollable detail pane (max ~660px). Remove the `<dialog>`, `open` prop, footer/Done button, `on:cancel`.
- Accept `category` prop; set initial `activeId` from `category` (make the existing `$: if (open) activeId = 'general'` reset conditional on the deep-link).
- Fix the aria defect: `aria-controls="sp-panel-{id}"` per tab + `id="sp-panel-{id}"` per panel.
- Rewrite the shell test to read `src/lib/SettingsPage.svelte`; assert no `<dialog>`/`[open]`, root has no unconditional `display:none`/visibility bleed, per-tab `aria-controls` matches a unique panel id.
- This is ONE commit (atomic) so the suite never sees a missing file.
- Verify: `npm test` → settings_panel_shell suite green; `svelte-check` clean; `file src/lib/SettingsPage.svelte` → text (no NUL); `git diff --check` clean.

**C2 — Chip primitive in global.css + delete local chip hex**
- Files: `src/lib/styles/global.css`, `src/lib/settings/ObsidianSection.svelte`, `src/lib/settings/AboutSection.svelte`.
- Add the `.chip` + `.chip-{ok,warn,err,info}` family (verbatim from spec §3) to `global.css`.
- Delete the local `.chip*` blocks and `:global([data-theme=dark])` chip overrides in both sections. Replace danger-btn/link `var(--error*, #hex)` with `--danger`/`--danger-soft`; replace `var(--accent-border, #bfdbfe)` with `--accent`.
- Do NOT touch the `ConnStatus` → chip-state mapping logic (CSS classes only).
- Verify: `npm run build` clean; grep `--error|--accent-border` across `src/` → zero matches (acceptance criterion); `svelte-check` → no orphaned `:global` selectors; chip-transition assertions in settings_panel.test.ts green.

**C3 — `SettingGroup` + `SettingRow` primitives**
- Files: create `src/lib/settings/SettingGroup.svelte`, `src/lib/settings/SettingRow.svelte` (Svelte-4 options-API, matching ExportDialog/ConflictModal).
- `SettingGroup`: card (`--surface`/`--border`/`--r-lg`) + optional uppercase eyebrow (`--fs-xs`/`--text-faint`/letter-spaced) + default slot.
- `SettingRow`: `label` prop (`--fs-base`/`--fw-semibold`), `helper` prop (`--fs-sm`/`--text-muted`), control `slot`, hairline `1px var(--border)` divider between rows.
- Verify: `svelte-check` clean (slot/prop arity — tsc alone won't catch); `file` + `git diff --check` on both new files → no NUL/whitespace.

**C4 — Re-express the three sections as SettingGroup/SettingRow + field-label hierarchy**
- Files: `src/lib/settings/AppearanceSection.svelte`, `ObsidianSection.svelte`, `AboutSection.svelte`.
- General: group "Appearance" → Theme. Integrations: group "Vault" → Vault folder, Export subfolder; group "Connection" → REST key, Test connection. About: group "Application" → Version, Updates.
- Field labels rise to `--fs-base`/`--fw-semibold` with a helper line.
- Add loading guard: gate vault picker / subfolder / REST-key controls behind `settings != null`, render 'Loading…' (`aria-live="polite"`) placeholder when null.
- Preserve `key ?? null` in the test-connection invoke (TRAP 6). AppearanceSection must NOT call `patchSettings`/touch `settings.theme` (TRAP 3).
- Verify: `npm run build` clean; `svelte-check` clean; `npm test` section assertions green; manual contrast check on `.chip-info` steel-blue border.

**C5 — Frontend test updates**
- Files: `src/tests/settings_panel.test.ts` (+ assertions per spec §8 in the appropriate test files).
- Assert: `.chip-*` resolve to token-driven styles (no literal hex); phantom tokens gone; left-rail nav (click + keyboard) switches categories; Back-to-document returns to prior view; palette exposes three `Settings: …` commands landing on the right category; `set_settings` still returns void.
- Verify: `npm test` → all green; `npx tsc --noEmit` clean.

### WS-D — Rust settings module + tests

**D1 — `set_settings_preserving_ref` fn (CONTRACT TASK — land first)**
- File: `src-tauri/src/settings.rs`
- Add `pub fn set_settings_preserving_ref(path: &PathBuf, incoming: Settings) -> Result<(), SettingsError>`: load on-disk via `get_settings(path)`; build merged = incoming but with `rest_key_ref = on_disk.rest_key_ref`; ensure `schema_version = 1`; call `save_settings(path, &merged)` (routes through the secret-leak assert).
- Do NOT modify the existing `set_settings` pass-through (key handlers depend on its verbatim behavior).
- Verify: `cargo build --manifest-path src-tauri/Cargo.toml` → succeeds.

**D2 — Lost-update regression test + secret-guard-through-merge test**
- File: `src-tauri/src/tests/settings_tests.rs`
- Test 1 (lost-update): save settings with `rest_key_ref = Some("obsidian-rest")`; call `set_settings_preserving_ref` with an incoming payload whose `rest_key_ref = None` but a different theme/vault; reload → assert `rest_key_ref` is still `Some("obsidian-rest")` AND the other fields updated.
- Test 2: assert the merge fn writes through `save_settings` (the existing `test_no_secret_in_serialized_json` precedent at line 58 covers the assert; add a focused test if the merge path needs its own coverage).
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml settings` → green.

**D3 — Keychain rollback test**
- File: `src-tauri/src/tests/settings_tests.rs`
- Using `init_mock_keychain`: simulate a settings-write failure after `store_rest_key` and assert the keychain entry is deleted (rollback invoked). Where the mock cannot model write→delete persistence, add an `#[ignore]` real-keychain integration test with a comment requiring Windows hardware verification.
- Verify: `cargo test --manifest-path src-tauri/Cargo.toml settings` → green (ignored test compiles but does not run).

---

## 6. Out of scope (YAGNI — verbatim from spec §7 + derived)

- Settings **search** (only three categories; revisit when the surface grows materially).
- Settings **import/export**.
- New setting **fields** or new **categories**.
- Any change to `theme.ts` ownership — `AppearanceSection` still must not call `patchSettings` or touch `settings.theme` (TRAP 3 holds).
- **IPC-contract changes** — `set_settings`/`set_rest_key`/`clear_rest_key` signatures FROZEN; no new commands; `lib.rs` registration unchanged.
- **`tokens.css` edits** — no phantom-token definitions exist to remove (the four are undefined references in component files, handled in C2).
- **A retry loop** for the keychain-rollback double-failure (return original error; document only).
- **Frontend-side concurrency tightening** of `patchSettings` (would require an IPC-contract change; the Rust preserve-ref fn is the fix).
- **Queueing** behavior for `open_file_request` during settings (recommended: auto-exit + open; not a queue).

---

## 7. Final verification gates (all must pass before merge)

```sh
cargo build --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
npm test
npx tsc --noEmit
npm run build
svelte-check --tsconfig ./tsconfig.json
```

Plus, per `tasks/lessons.md` (NUL-byte / green-gate corruption, commit b470b90):
```sh
git diff --check                       # whitespace/conflict markers on all touched files
file src/lib/SettingsPage.svelte src/lib/settings/SettingGroup.svelte src/lib/settings/SettingRow.svelte
grep -rE -- '--error|--accent-border' src/   # MUST return zero matches
```
