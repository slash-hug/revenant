# Revenant — Settings / Configuration Panel (#37)

**Status:** Approved design — ready for `feature-research` → `feature-implement`
**Date:** 2026-06-14
**Issue:** [#37](https://github.com/slash-hug/revenant/issues/37) — feat: Settings / configuration panel
**Tier:** Tier-2 (new component + frozen-IPC-contract change + secrets wiring + capabilities + tests)

---

## 1. Problem

The app persists a settings envelope (`get_settings` / `set_settings`, `src-tauri/src/settings.rs`)
with **no UI to edit it** — only the theme has a control (`ThemeToggle`, on the welcome screen).
Concretely:

- **Obsidian export is unusable** — there is no way to add a vault, so `export_obsidian`
  always hits `NoVaultConfigured`.
- **The REST API key cannot be set at all** — `secrets.rs` has the keychain primitives
  (`store_rest_key` / `get_rest_key` / `delete_rest_key`) but **no IPC command exposes them**.
- Other persisted fields (`default_export_subfolder`) can only be changed by hand-editing the
  on-disk settings JSON.

This blocks live-testing the Obsidian export busy-state shipped in #29.

## 2. Goal

A discoverable Settings panel that edits the existing settings envelope and writes the Obsidian
REST key to the OS keychain — built so that **adding new settings over the app's lifecycle is a
drop-in, not a refactor**.

## 3. Resolved decisions

| Decision | Choice | Rationale |
|---|---|---|
| Vault config (v1) | **Single vault** | Export only ever uses `vaults.first()`; stored as a 1-element `Vec` to keep the schema. YAGNI on multi-vault. |
| Test connection | **Include** | A live probe directly addresses the "Obsidian was unusable" pain; one new IPC command. |
| `export_on_save` toggle | **Omit (v1)** | The field exists but is unwired; no dead controls. Add when auto-export is real. |
| Save model | **Live-apply per field** | Each control persists on change/blur; the REST key has its own Save/Test (write-only); the dialog just closes with "Done". No dirty-state machine. |
| Entry points | **Toolbar gear + palette "Settings…" + `⌘,` / `Ctrl+,`** | Conventional; gear sits in the toolbar right cluster beside the ⌘K trigger. |
| Theme in panel | **Embed existing `ThemeToggle`** | Discoverability; localStorage stays the source of truth — the orphaned `settings.theme` field is left untouched. |

## 4. Architecture — built for expansion

The central requirement: new settings added throughout the app lifecycle must be **drop-in**.
Three structural commitments deliver that.

### 4.1 Section components, not inline markup

`SettingsPanel.svelte` owns only the dialog shell (open/close, `⌘,`, "Done", scrim) and composes
an **ordered list of self-contained section components**:

```
SettingsPanel.svelte          ← shell + section list
 ├─ ObsidianSection.svelte     ← vault, subfolder, REST key, test connection
 └─ AppearanceSection.svelte   ← ThemeToggle
```

Adding a settings area = author a new `*Section.svelte` and add it to the list. The panel shell
never changes. Each section is independently testable (clear purpose, props in, store out).

### 4.2 A `settings` store as the single client-side source of truth

A small Svelte store (`src/lib/stores/settings.ts`) mirrors the Rust `Settings` transport type and
centralises persistence:

```ts
// shape mirrors ipc.Settings
export const settings = writable<Settings | null>(null);

// load once on app start (or first panel open)
export async function loadSettings(): Promise<void> { settings.set(await getSettings()); }

// live-apply: patch + persist in ONE place
export async function patchSettings(partial: Partial<Settings>): Promise<void> {
  const next = { ...get(settings)!, ...partial };
  settings.set(next);          // optimistic
  await setSettings(next);     // persist (existing IPC)
}
```

Adding a setting becomes: add the field to the Rust struct + the `ipc` mirror, then bind a control
to `$settings.field` and call `patchSettings({ field })`. **No per-field load-modify-save
boilerplate** — every section reuses the same helper. The REST key is the one exception (write-only;
see §6), so it gets its own dedicated commands rather than flowing through `patchSettings`.

### 4.3 Growth path to sidebar-nav is free

With two sections, a **flat vertical stack** is correct (a sidebar for two items is overkill).
When sections multiply, `SettingsPanel`'s shell swaps the stack for a left-nav layout (section
titles list on the left, active section on the right) rendering **the same section components**.
The section components do not change — only the panel shell's layout does. The v1 flat layout is
therefore not a dead end.

### 4.4 Schema is already migration-ready

`settings.rs` carries `schema_version: 1` and a migrate-or-quarantine `load_settings`. New fields
land in `Settings::default()` so older on-disk files (including version-0) deserialize cleanly
through the existing path; `schema_version` only bumps on a *breaking* change. This is the
documented "how to add a setting" checklist (§9).

## 5. Layout (v1)

```
┌─ Settings ─────────────────────────────────────┐
│  Obsidian                                        │
│    Vault folder    [ /Users/…/Vault ]  [Choose…] │
│                    [ Clear ]                      │
│    Export subfolder  [ Reviews              ]     │
│    REST API key    ●●●● saved   [Replace] [Remove]│
│        └ (entry)   [ password input ]   [ Save ]  │
│    [ Test connection ]    ✓ Connected             │
│                                                   │
│  Appearance                                       │
│    Theme    ( Light | System | Dark )             │
│                                                   │
│                                        [  Done  ] │
└───────────────────────────────────────────────────┘
```

- **Vault folder** — read-only path display + "Choose…" (directory picker) + "Clear". Empty state:
  "No vault configured", Choose as the primary affordance.
- **Export subfolder** — text input; `patchSettings({ default_export_subfolder })` on blur. Empty = vault root.
- **REST API key** — write-only (see §6). Stored → masked "•••• saved" + Replace / Remove.
  Replace reveals a password `<input>` + "Save". The actual key is never displayed.
- **Test connection** — probes the saved key; inline result chip:
  ✓ Connected · ⚠ Key rejected (401) · ✗ Obsidian not running.
- **Theme** — embedded `ThemeToggle`.

Visual pattern matches `ExportDialog.svelte` exactly (native `<dialog class="modal">`, `on:cancel`
→ preventDefault + close, token styling, toast feedback, `prefers-reduced-motion` handling).

## 6. Data flow & new IPC (frozen-contract change)

Vault + subfolder live-apply through the **existing** `set_settings`, via `patchSettings`.
The REST key requires **four new commands** — `secrets.rs` already has the keychain primitives; they
are simply not exposed. The key only ever travels frontend → Rust → keychain; it is never returned
to the frontend nor written to settings JSON.

| Command | Behavior | Returns |
|---|---|---|
| `set_rest_key(key)` | load settings → `store_rest_key("obsidian-rest", key)` → set `rest_key_ref = "obsidian-rest"` → save settings | `()` |
| `clear_rest_key()` | `delete_rest_key("obsidian-rest")` → set `rest_key_ref = None` → save settings | `()` |
| `has_rest_key()` | whether a key is configured (drives masked-vs-entry UI) | `bool` |
| `test_obsidian_connection()` | new probe in `obsidian.rs`; uses the saved key | `ConnStatus` |

`ConnStatus` is a small serializable enum/struct: `ok` / `unauthorized` / `unreachable`
(maps from the existing `ObsidianError` variants — `Misconfigured` → `unauthorized`,
`NotRunning` → `unreachable`). Fixed keychain ref constant: `"obsidian-rest"` (one key in v1).

All four added to `ipc.rs` + the `ipc.ts` mirror + registered in `lib.rs` (WS-A owns these files;
the IPC surface is otherwise frozen). After `set_rest_key` / `clear_rest_key`, the frontend refreshes
its local settings copy (the commands mutate `rest_key_ref` server-side).

**Test-connection flow:** Test operates on the *saved* key. To test a freshly typed key the user
saves first, then tests. (Keeps the command parameter-free and avoids passing the raw key back and
forth more than necessary.)

## 7. Security

- The raw REST key is written only to the OS keychain via `secrets.rs`; settings JSON holds only
  `rest_key_ref` (CLAUDE.md "Secrets"). The existing runtime assertion in `save_settings`
  (rejects serialized `"password"`/`"api_key"`/`"secret"`) remains the backstop.
- `has_rest_key` / `test_obsidian_connection` never return the key material.
- Directory picker is scoped by adding **only** `dialog:allow-open` — no blanket fs ACL
  (CLAUDE.md "Blanket fs ACL"). All actual file I/O stays in the Rust core.

## 8. Capabilities

Add `dialog:allow-open` to `src-tauri/capabilities/default.json` (currently `core:default`,
`dialog:default`, `dialog:allow-save`) for the open-directory vault picker.

## 9. "How to add a setting" — the extensibility contract

1. Add the field to `settings.rs` `Settings` + `Settings::default()` (default keeps old files loading).
2. Mirror it in `ipc.rs` `Settings` + `ipc.ts` `Settings` (the frozen-contract data type, not a new command).
3. Bind a control in the relevant `*Section.svelte` to `$settings.field`; persist via `patchSettings({ field })`.
4. New settings *area* → new `*Section.svelte` added to `SettingsPanel`'s section list.
5. Bump `schema_version` only on a breaking change; otherwise the migrate path handles it.

Secrets are the exception: never route a secret through `patchSettings`/settings JSON — give it
dedicated keychain-backed commands like the REST key.

## 10. Out of scope (v1)

Multiple vaults · `export_on_save` toggle · REST port override · HTTPS / cert-pinning ·
per-vault export targeting. All deferred; the architecture above absorbs them without a rewrite.

## 11. Testing

- **Rust** (`obsidian.rs`, WS-D): `test_obsidian_connection` status mapping —
  reachable+200 → `ok`, 401 → `unauthorized`, connection-refused/timeout → `unreachable`.
- **Rust** (secrets/ipc): `set_rest_key` persists `rest_key_ref` and stores to keychain;
  `clear_rest_key` clears both; `has_rest_key` reflects state. (Keychain-touching tests guarded /
  mocked per existing `secrets` test conventions.)
- **IPC contract** (`ipc_contract.test.ts`, WS-A): the four new commands present in the mirror.
- **Frontend** (`settings_panel.test.ts` / section tests, WS-C): masked-vs-entry REST key state,
  `patchSettings` called on vault/subfolder change, empty-vault state, Test-connection chip states.

## 12. Rough file set (feature-research/implement will split into zero-overlap workstreams)

- **New:** `src/lib/SettingsPanel.svelte`, `src/lib/settings/ObsidianSection.svelte`,
  `src/lib/settings/AppearanceSection.svelte`, `src/lib/stores/settings.ts`,
  `src/tests/settings_panel.test.ts`.
- **WS-A (foundation/IPC):** `src-tauri/src/ipc.rs`, `src/lib/types/ipc.ts`, `src-tauri/src/lib.rs`,
  `src-tauri/capabilities/default.json`, `src/App.svelte` (mount panel + palette command + `⌘,`),
  `src/tests/ipc_contract.test.ts`.
- **WS-C (frontend):** `src/lib/Toolbar.svelte` (gear), the new components/store above.
- **WS-D (settings/obsidian):** `src-tauri/src/obsidian.rs` (connection probe),
  `src-tauri/src/ipc.rs` REST-key command bodies call into `secrets.rs` (no `secrets.rs` change
  expected beyond possibly a re-export).

> Note: `ipc.rs`, `ipc.ts`, `lib.rs`, `App.svelte`, `capabilities/**` are WS-A-owned per
> CLAUDE.md "Workstream file ownership"; the REST-key command *bodies* delegate to `secrets.rs` /
> `obsidian.rs` (WS-D) so ownership stays clean.
