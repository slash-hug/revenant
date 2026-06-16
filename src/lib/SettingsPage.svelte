<script lang="ts">
  /**
   * SettingsPage.svelte — full-window settings page shell.
   *
   * Promoted from the 600px master-detail modal (SettingsPanel) to a
   * full-window page that replaces the editor/toolbar region when active.
   *
   * Follows the Svelte 4 options-API pattern used by ConflictModal /
   * KeyboardShortcutsModal / ExportDialog.
   *
   * Layout:
   *   - Top bar: "← Back to document" button (dispatches `on:close`) + "Settings" heading
   *   - Left rail: vertical category tablist
   *   - Scrollable detail pane (max 660px)
   *
   * Props:
   *   - category: 'general' | 'integrations' | 'about'  — deep-link initial tab
   * Events:
   *   - close — App.svelte sets settingsView = null on receipt
   */

  import { createEventDispatcher, onMount, tick } from 'svelte';
  import ObsidianSection from './settings/ObsidianSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import AboutSection from './settings/AboutSection.svelte';

  export let category: 'general' | 'integrations' | 'about' = 'general';

  const dispatch = createEventDispatcher<{ close: void }>();

  // Master-detail categories. The detail-pane title is the category `label`, so
  // section components themselves carry no top-level heading.
  const categories = [
    { id: 'general', label: 'General', component: AppearanceSection },
    { id: 'integrations', label: 'Integrations', component: ObsidianSection },
    { id: 'about', label: 'About', component: AboutSection },
  ];

  // Initialize activeId from the `category` deep-link prop.
  let activeId: string = category ?? 'general';
  $: active = categories.find((c) => c.id === activeId) ?? categories[0];

  // Sync with deep-link changes from App.svelte (palette navigation).
  $: if (category) activeId = category;

  /** Move focus to the active nav tab (or the detail panel as fallback).
   * Called on mount (entry focus) and on category change so keyboard/screen-reader
   * users always land somewhere meaningful — compensates for losing the native
   * showModal() auto-focus that SettingsPanel's native dialog used to provide. */
  function focusActive() {
    void tick().then(() => {
      const tab = document.querySelector<HTMLElement>(`.sp-nav [data-cat="${activeId}"]`);
      if (tab) {
        tab.focus();
      } else {
        // Fallback: focus the scrollable detail panel (tabindex="0").
        document.querySelector<HTMLElement>('.sp-detail')?.focus();
      }
    });
  }

  // Entry focus: move focus into the settings surface when it first mounts so
  // keyboard and screen-reader users are not stranded on the (now unmounted)
  // trigger element (gear button / ⌘, / palette command).
  onMount(focusActive);

  function select(id: string) {
    activeId = id;
    // Keep focus on the newly-activated nav tab after a category change so
    // roving-tabindex navigation remains coherent.
    focusActive();
  }

  // APG vertical tablist keyboard model: Enter/Space activates; ↑/↓ move +
  // activate; Home/End jump. Roving tabindex — only the active tab in Tab order.
  function navKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(id);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const idx = categories.findIndex((c) => c.id === id);
      let next: number;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = categories.length - 1;
      else next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + categories.length) % categories.length;
      const nextId = categories[next].id;
      select(nextId);
      void tick().then(() => {
        document.querySelector<HTMLElement>(`.sp-nav [data-cat="${nextId}"]`)?.focus();
      });
    }
  }

  function close() {
    dispatch('close');
  }
</script>

<div class="sp" role="region" aria-label="Settings">
  <!-- Top bar: Back to document + heading -->
  <div class="sp-topbar">
    <button type="button" class="sp-back" on:click={close} aria-label="Back to document">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 12H5M12 5l-7 7 7 7" />
      </svg>
      <span>Back to document</span>
    </button>
    <h2 class="sp-heading">Settings</h2>
  </div>

  <!-- Master-detail body: category sidebar + detail pane -->
  <div class="sp-body">
    <div class="sp-nav" role="tablist" aria-orientation="vertical" aria-label="Settings categories">
      {#each categories as cat (cat.id)}
        <button
          type="button"
          class="sp-nav-item"
          class:active={cat.id === activeId}
          role="tab"
          id={`sp-tab-${cat.id}`}
          data-cat={cat.id}
          aria-selected={cat.id === activeId}
          aria-controls={`sp-panel-${cat.id}`}
          tabindex={cat.id === activeId ? 0 : -1}
          on:click={() => select(cat.id)}
          on:keydown={(e) => navKeydown(e, cat.id)}
        >{cat.label}</button>
      {/each}
    </div>

    <div
      class="sp-detail"
      id={`sp-panel-${activeId}`}
      role="tabpanel"
      aria-labelledby={`sp-tab-${activeId}`}
      tabindex="0"
    >
      <h3 class="sp-detail-title">{active.label}</h3>
      <svelte:component this={active.component} />
    </div>
  </div>
</div>

<style>
  /* Full-window page shell — no native modal element, no backdrop.
     App.svelte renders this as the outermost branch ({#if settingsView}),
     so visibility is entirely controlled by the parent render tree.
     No unconditional display:none or visibility:hidden here. */
  .sp {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
  }

  /* Top bar */
  .sp-topbar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    flex: none;
    background: var(--toolbar);
  }

  .sp-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--text-muted);
    background: none;
    border: none;
    padding: 5px 8px;
    border-radius: var(--r-md);
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .sp-back svg { width: 14px; height: 14px; }
  .sp-back:hover { color: var(--text); background: var(--surface-2); }
  .sp-back:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .sp-heading {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
  }

  /* Master-detail body: fixed sidebar + scrollable detail pane */
  .sp-body {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  /* Sidebar — vertical category tablist */
  .sp-nav {
    flex: none;
    width: 180px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 16px 12px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    background: var(--surface);
  }

  .sp-nav-item {
    font: inherit;
    font-size: var(--fs-sm);
    text-align: left;
    color: var(--text-muted);
    background: transparent;
    border: none;
    border-radius: var(--r-md);
    padding: 7px 10px;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .sp-nav-item:hover { background: var(--surface-2); color: var(--text); }
  .sp-nav-item.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    font-weight: var(--fw-medium);
  }
  .sp-nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* Detail pane — scrolls within the height budget, max width for readability */
  .sp-detail {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 24px 32px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 660px;
  }
  .sp-detail:focus-visible { outline: none; }

  .sp-detail-title {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
    color: var(--text);
  }
</style>
