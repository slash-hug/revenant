# Settings page — complete UX refactor (full-page redesign)

**Issue:** #39 (epic) · **Date:** 2026-06-16 · **Approach:** Tier-2 (brainstorm → feature-research → feature-implement)
**Source audit:** 2026-06-16 multi-lens re-audit (impeccable 37/40, UI craft 36/40, Code B+, A11y A−)

---

## Summary

The settings surface — a 600px master-detail `<dialog>` from the #37 redesign — was assembled quickly and the re-audit surfaced a cluster of issues rooted in it: a data-corruption concurrency race, status chips bypassing the token system, flat information hierarchy, and an a11y tabpanel-id defect. Rather than patch piecemeal, we **move settings to a full-window page** now (it will only accrete more categories over time) and fix the underlying architecture in the same pass.

Key decisions (from brainstorming):

1. **Full-window takeover** — settings replaces the entire app surface, not a modal and not embedded in the existing chrome.
2. **Grouped-card content** — each category's settings cluster under small uppercase group headers inside card surfaces (macOS System Settings style).
3. **Single-writer concurrency model** — `rest_key_ref` is owned solely by the key handlers; `set_settings` preserves it. No IPC-contract change.
4. **Shared chip primitive on semantic tokens** — one `.chip` family in `global.css`; delete all hardcoded hex and the four phantom tokens.

---

## 1. App shell & navigation

`App.svelte` replaces today's modal `settingsOpen` flag with a **settings view-state**. When active, `<SettingsPage>` renders in place of the toolbar / tab bar / editor-preview region. The document and tab state remain alive in memory — leaving settings restores exactly what was there (including the welcome screen for first-run).

- **Entry:** `⌘,` / `Ctrl+,`, or any palette "Settings: …" command. Reachable from the welcome screen (first-run setup).
- **Exit:** a persistent **"‹ Back to document"** control in the settings top bar, plus `Esc`.
- **No `⌘W` binding** for settings — `⌘W` remains "close tab".
- **Transition:** subtle fade/slide on enter and leave, gated on `@media (prefers-reduced-motion: reduce)` (matches existing `--dur-*` / `--ease-*` token usage).

There is **no "Done" button** — the P2 "Done looks tertiary" finding dissolves because the primary exit is "Back to document", and settings persist optimistically as the user changes them.

## 2. Layout & component structure

Top bar (back affordance) → body split into a fixed **left rail** (category nav) + a **scrollable detail pane** (max content width ~660px for readable line length).

- **`SettingsPanel.svelte` (the `<dialog>`) → `SettingsPage.svelte`** — full-window shell. Owns the top bar, left rail, and detail pane.
- **Two new shared primitives** (keep cards DRY and consistent across categories):
  - **`SettingGroup`** — card wrapper (`--surface`, `--border`, `--r-lg`) with an optional uppercase eyebrow header (`--fs-xs`, `--text-faint`, letter-spaced).
  - **`SettingRow`** — `label` + `helper` description + a control `slot`, with hairline dividers between rows inside a group.
- **Section components** (`AppearanceSection`, `ObsidianSection`, `AboutSection`) re-expressed as `SettingGroup` → `SettingRow` clusters. Suggested grouping:
  - **General:** group "Appearance" → Theme row.
  - **Integrations:** group "Vault" → Vault folder, Export subfolder; group "Connection" → REST API key, Test connection.
  - **About:** group "Application" → Version, Updates.
- Sections retain the existing **Svelte-4 options-API** style to match the rest of the component library (ExportDialog, ConflictModal, etc.); `App.svelte` keeps its Svelte-5 runes.

## 3. Visual system

### Chip primitive
Extract a single chip family into `src/lib/styles/global.css`:

```css
.chip { font-size: var(--fs-xs); font-weight: var(--fw-medium);
        padding: 3px 9px; border-radius: 999px; border: 1px solid transparent; }
.chip-ok   { background: var(--success-soft); color: var(--success-text); border-color: var(--success); }
.chip-warn { background: var(--warn-soft);    color: var(--warn-text);    border-color: var(--warn); }
.chip-err  { background: var(--danger-soft);  color: var(--danger-text);  border-color: var(--danger); }
.chip-info { background: var(--accent-soft);  color: var(--accent-text);  border-color: var(--accent); }
```

- **No new tokens required** — chip borders reuse the base semantic token (`--success`/`--warn`/`--danger`/`--accent`); bg uses `*-soft`, text uses `*-text`. All four triplets already exist for both light and dark themes, so dark-mode contrast is correct by construction.
- **Delete** every hardcoded chip hex in `ObsidianSection.svelte` and `AboutSection.svelte`, including their `:global([data-theme="dark"])` chip overrides.
- **Delete** the four phantom tokens referenced by `danger-btn`/`danger-link`: `--error`, `--error-soft`, `--error-border`, `--accent-border`. Remap: `danger-btn`/`danger-link` → `--danger` (text/border) and `--danger-soft` (hover bg).

### Information hierarchy
| Element | Token |
|---|---|
| Category title (detail pane heading) | `--fs-lg`, `--fw-semibold` |
| Group eyebrow header | `--fs-xs`, uppercase, letter-spaced, `--text-faint` |
| Field label | `--fs-base`, `--fw-semibold` |
| Helper description | `--fs-sm`, `--text-muted` |
| Left-rail category labels | `--fs-sm` (unchanged — stays distinct from field labels) |

This resolves the P2 "field labels render at the same scale as nav labels" finding: field labels rise to `--fs-base` and gain a helper line, while nav labels stay `--fs-sm`.

## 4. Concurrency model (P1 — reliability)

**Single-writer discipline.** `rest_key_ref` is owned exclusively by the key handlers (`set_rest_key` / `clear_rest_key`).

- **`set_settings` (Rust)** becomes a read-modify-write: load on-disk settings, apply all incoming fields **except `rest_key_ref`**, and write back — `rest_key_ref` is always preserved from disk regardless of what the frontend sends. An in-flight optimistic `patchSettings` carrying a stale `rest_key_ref` can no longer wipe a just-saved key. `schema_version: 1` continues to be written.
- **No IPC-contract change** — `set_settings(settings)` keeps its signature; only its on-disk behavior changes. (The FROZEN contract is respected.)
- **Keychain rollback** — in `set_rest_key`, if `set_settings`/the settings write fails *after* `store_rest_key` succeeds, delete the just-stored keychain entry so the keychain and settings can't drift into an orphaned state.
- The version-guard alternative (mirroring `save_file`'s `expected_hash`) was considered and rejected: it would change the frozen contract and push reload/retry conflict UX onto a surface that is effectively single-writer.

## 5. Accessibility (P2)

- Left rail keeps the **APG vertical-tablist** keyboard model already implemented: roving `tabindex`, Enter/Space activate, ↑/↓ move + activate, Home/End jump.
- **Per-panel ids** — each `role="tab"` sets `aria-controls="sp-panel-{id}"` and the matching `role="tabpanel"` carries `id="sp-panel-{id}"` (replaces the single shared `aria-controls="sp-panel"`).
- Focus moves into the active panel on category change / page entry; "Back to document" returns focus sensibly to the document region.

## 6. Command palette deep-links

Replace the single `Settings…` command with **per-category deep-links**: `Settings: General`, `Settings: Integrations`, `Settings: About`, each opening `SettingsPage` on that category. `⌘,` opens **General**. (Implemented in `App.svelte`'s command registry, ~line 478–482.)

## 7. Out of scope (YAGNI)

- Settings **search** (only three categories; revisit when the surface grows materially).
- Settings import/export.
- New setting fields or new categories.
- Any change to `theme.ts` ownership — `AppearanceSection` still must not call `patchSettings` or touch `settings.theme` (TRAP 3 holds).

## 8. Testing

**Rust (`src-tauri`):**
- `set_settings` preserves on-disk `rest_key_ref` when the incoming payload's `rest_key_ref` differs (the lost-update regression test).
- `set_rest_key` rolls back the keychain entry when the settings write fails after the keychain write.

**Frontend (Vitest):**
- `.chip-*` classes resolve to token-driven styles (no literal hex); phantom tokens are gone.
- Each tab's `aria-controls` matches a unique panel `id`.
- Left-rail navigation (click + keyboard) switches categories; "Back to document" returns to the prior view.
- Palette exposes the three `Settings: …` deep-link commands and each lands on the right category.
- Update / replace `settings_panel.test.ts` and `settings_panel_shell.test.ts` for the full-page shell.

## 9. Files touched (anticipated)

- **Frontend:** `App.svelte` (view-state + palette commands), `SettingsPanel.svelte` → `SettingsPage.svelte`, new `settings/SettingGroup.svelte` + `settings/SettingRow.svelte`, `settings/AppearanceSection.svelte`, `settings/ObsidianSection.svelte`, `settings/AboutSection.svelte`, `styles/global.css` (chip primitive), `styles/tokens.css` (remove phantom tokens), `src/tests/settings_panel*.test.ts` (+ new tests).
- **Rust:** `src-tauri/src/ipc.rs` (`set_settings` read-modify-write, `set_rest_key` rollback), `src-tauri/src/settings.rs` if helper needed, `src-tauri/src/tests/settings_tests.rs`.

---

## Acceptance criteria

- Settings opens as a full-window page (not a modal); `⌘,`, palette deep-links, and welcome-screen entry all work; `Esc` and "Back to document" exit and restore prior view.
- Each category renders grouped cards with field label + helper description; hierarchy tokens applied as tabled above.
- All status chips use the shared `.chip` primitive; zero hardcoded chip hex and zero references to `--error*` / `--accent-border` remain in the repo.
- Saving a subfolder/vault edit while a REST key is saved never wipes `rest_key_ref` (regression test green).
- Each tab controls a unique panel id; keyboard nav matches APG.
- `cargo test`, `npm test`, `npx tsc --noEmit`, and `npm run build` all pass.
