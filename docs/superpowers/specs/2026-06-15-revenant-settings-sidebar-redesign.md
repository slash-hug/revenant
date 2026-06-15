# Revenant — Settings panel: sidebar / master-detail redesign

**Status:** Approved design — implement directly (medium scope, pattern pre-decided)
**Date:** 2026-06-15
**Builds on:** #37 settings panel (§4.3 explicitly anticipated this growth path) + the version/updates About section.

---

## 1. Problem / Goal

The settings panel is a single flat vertical stack of three sections (Obsidian, Appearance,
About). With three sections it reads as undifferentiated and doesn't match the look of
comparable desktop apps. Goal: the **industry-standard master-detail layout** — a category
list on the left, the selected category's content on the right — grouped into **General /
Integrations / About**.

This is exactly the growth path the #37 design called out: *"when sections multiply, the
shell swaps the flat stack for a left-nav layout rendering the same section components."*

## 2. Resolved decisions (locked via design Q&A)

| Decision | Choice |
|---|---|
| Layout | **Left sidebar (category list) + right detail pane** (master-detail) |
| Categories | **General** (Appearance/theme) · **Integrations** (Obsidian) · **About** (version + updates) |
| Heading model | The **detail-pane title = category label**; each section component drops its now-redundant top-level `<h4>` heading (the pane title replaces it). |
| Nav a11y | Vertical **APG tablist** — `role="tablist"`/`tab`/`tabpanel`, roving tabindex, ↑/↓/Home/End + Enter/Space/click, matching the tab keyboard model shipped in #30. |
| Default category | First (**General**) on open. |

## 3. Design

### 3.1 SettingsPanel shell (the main change)

`.sp-body` changes from a vertical stack to a **flex row**: a left `.sp-nav` (fixed ~150px)
and a right `.sp-detail` (flex:1, scrollable — keeps the `max-height: min(70vh,640px)`
budget from #37). The pinned header ("Settings" + ×) and footer ("Done") are unchanged.
Panel width grows **520px → ~600px** to comfortably hold sidebar + content.

A small in-component **category registry** drives both panes:

```ts
const CATEGORIES = [
  { id: 'general',      label: 'General',      component: AppearanceSection },
  { id: 'integrations', label: 'Integrations', component: ObsidianSection },
  { id: 'about',        label: 'About',        component: AboutSection },
] as const;
let activeCategory = 'general';
```

- **Sidebar** (`.sp-nav`, `role="tablist" aria-orientation="vertical"`): one button per
  category (`role="tab"`, `aria-selected`, roving tabindex — only the active tab is in the
  Tab order). Click or Enter/Space selects; ↑/↓ move + select; Home/End jump to ends
  (re-uses the exact pattern from `TabManager` #30).
- **Detail pane** (`.sp-detail`, `role="tabpanel"` labelled by the active tab): a pane title
  `<h4>` = the active category's `label`, then `<svelte:component this={activeComponent} />`.

Adding a future category remains a one-line registry entry — the #37 extensibility contract
is preserved (now realized as a sidebar entry instead of a stacked section).

### 3.2 Section components (minor)

`AppearanceSection`, `ObsidianSection`, `AboutSection` each **drop their top-level
`<h4 class="section-title">…</h4>`** (the detail-pane title now names the category). Their
field rows / sub-structure are otherwise unchanged. (ObsidianSection's internal sub-labels,
if any, stay.)

### 3.3 Visual

```
┌ Settings ──────────────────────────────────┐
│ ┌──────────────┐  General                   │
│ │ General    ▸ │    Theme   (L)(S)(D)        │
│ │ Integrations │                             │
│ │ About        │                             │
│ └──────────────┘                             │
│                                    [ Done ]  │
└──────────────────────────────────────────────┘
```

Sidebar item styling: subtle, list-like; active item gets an accent-tinted background +
medium weight (re-use existing token classes; no new color tokens). Respects
`prefers-reduced-motion`.

### 3.4 Responsive

At the 94vw small-screen cap, the ~600px panel + 150px sidebar still fits comfortably on the
target desktop window. No mobile breakpoint is in scope (desktop app). If the window is
extremely narrow, the detail pane scrolls; the sidebar stays fixed-width.

## 4. Out of scope

Search within settings · collapsible nav groups · per-category deep-linking · animating the
pane transition (a simple crossfade at most, reduced-motion-safe).

## 5. Testing

- `settings_panel_shell.test.ts`: the existing `.sp` display-gating source-invariant
  (regression from #37) must still hold — verify the base `.sp` rule still declares no
  `display`. Add a source assertion that the three category labels and `role="tablist"`
  are present.
- Live WebView verification (component mounting isn't wired in this repo's vitest — SSR
  resolution): clean relaunch; confirm sidebar nav (click + ↑/↓/Home/End), each category
  renders its section, theme/Obsidian/About all still function, Esc/Done/× still close, and
  the splash-screen-not-visible invariant still holds.

## 6. Files touched

- `src/lib/SettingsPanel.svelte` (sidebar + detail pane + category registry + tablist a11y +
  width).
- `src/lib/settings/AppearanceSection.svelte`, `ObsidianSection.svelte`, `AboutSection.svelte`
  (remove redundant top-level `<h4>`).
- `src/tests/settings_panel_shell.test.ts` (assertions above).

## 7. Routing

Medium scope, single primary component, **pattern pre-decided** (no new architectural
decision — #37 already specified the sidebar growth path). Implement directly with
`svelte-check`/`tsc`/`vitest` gates + a clean-relaunch live verification — not the
multi-agent feature-research/implement pipeline (which would be disproportionate here).
