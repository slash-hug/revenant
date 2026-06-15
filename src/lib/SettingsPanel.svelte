<script lang="ts">
  /**
   * SettingsPanel.svelte — native <dialog> settings panel shell (C-2).
   *
   * Follows the Svelte 4 options-API pattern used by ExportDialog,
   * ConflictModal, UnsavedChangesModal, and KeyboardShortcutsModal.
   *
   * Layout:
   *   - Pinned header: "Settings" title + close ×
   *   - Scrollable body (max-height: min(70vh, 640px); overflow-y: auto) — D2
   *   - Pinned footer: "Done" button
   *
   * Children: <ObsidianSection> then <AppearanceSection>.
   *
   * Props:
   *   - open: boolean  — driven from App.svelte
   * Events:
   *   - close — App.svelte sets open=false on receipt
   */

  import { createEventDispatcher, tick } from 'svelte';
  import ObsidianSection from './settings/ObsidianSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import AboutSection from './settings/AboutSection.svelte';

  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  let dialog: HTMLDialogElement | undefined;

  // Master-detail categories. Adding a settings area is a one-line entry here
  // (the #37 extensibility contract, now realized as a sidebar category rather
  // than a stacked section). The detail-pane title is the category `label`, so
  // the section components themselves carry no top-level heading.
  const categories = [
    { id: 'general', label: 'General', component: AppearanceSection },
    { id: 'integrations', label: 'Integrations', component: ObsidianSection },
    { id: 'about', label: 'About', component: AboutSection },
  ];
  let activeId = 'general';
  $: active = categories.find((c) => c.id === activeId) ?? categories[0];

  // Reactive: open/close the native dialog in sync with the `open` prop.
  $: if (dialog) {
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }

  // Each fresh open lands on the first category.
  $: if (open) activeId = 'general';

  function select(id: string) {
    activeId = id;
  }

  // APG vertical tablist keyboard model (mirrors TabManager #30): Enter/Space
  // activates; ↑/↓ move + activate; Home/End jump. Roving tabindex — only the
  // active tab sits in the Tab order.
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

  // on:cancel fires when the user presses Esc — prevent the default browser
  // close (which bypasses our state) and route through our close handler so
  // App.svelte's `open` stays in sync.
  function handleCancel(e: Event) {
    e.preventDefault();
    close();
  }
</script>

<dialog
  bind:this={dialog}
  class="sp"
  aria-labelledby="sp-title"
  on:cancel={handleCancel}
>
  <!-- Pinned header -->
  <div class="sp-head">
    <h3 id="sp-title">Settings</h3>
    <button type="button" class="sp-x" on:click={close} aria-label="Close settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
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
          aria-controls="sp-panel"
          tabindex={cat.id === activeId ? 0 : -1}
          on:click={() => select(cat.id)}
          on:keydown={(e) => navKeydown(e, cat.id)}
        >{cat.label}</button>
      {/each}
    </div>

    <div
      class="sp-detail"
      id="sp-panel"
      role="tabpanel"
      aria-labelledby={`sp-tab-${activeId}`}
      tabindex="0"
    >
      <h4 class="sp-detail-title">{active.label}</h4>
      <svelte:component this={active.component} />
    </div>
  </div>

  <!-- Pinned footer -->
  <div class="sp-foot">
    <button type="button" class="btn-done" on:click={close}>Done</button>
  </div>
</dialog>

<style>
  .sp {
    margin: auto;
    width: 600px;
    max-width: 94vw;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 0;
    /* Prevent the dialog from growing taller than the viewport */
    max-height: 90vh;
    overflow: hidden;
  }
  /* Display is gated on [open] ONLY — a base `display: flex` would override the
     UA `dialog:not([open]) { display: none }`, leaving the panel visible on the
     splash screen and impossible to dismiss (it never opened modally, so
     dialog.open stays false and dialog.close() is never reached). Match the
     ConflictModal / KeyboardShortcutsModal pattern. */
  .sp[open] {
    display: flex;
    flex-direction: column;
    animation: sp-in var(--dur-slow) var(--ease-out);
  }
  .sp::backdrop {
    background: color-mix(in srgb, var(--bg) 35%, rgba(0, 0, 0, .45));
    backdrop-filter: blur(2px);
  }
  @keyframes sp-in {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) { .sp[open] { animation: none; } }

  /* Pinned header */
  .sp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 22px 14px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .sp-head h3 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
  }
  .sp-x {
    display: inline-flex;
    padding: 5px;
    border-radius: var(--r-md);
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .sp-x svg { width: 16px; height: 16px; }
  .sp-x:hover { color: var(--text); background: var(--surface-2); }

  /* Master-detail body: fixed sidebar + scrollable detail pane.
     Height budget (D2) lives here; children manage their own overflow. */
  .sp-body {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    max-height: min(70vh, 640px);
    overflow: hidden;
  }

  /* Sidebar — vertical category tablist */
  .sp-nav {
    flex: none;
    width: 168px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 14px 10px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
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

  /* Detail pane — scrolls within the height budget */
  .sp-detail {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .sp-detail:focus-visible { outline: none; }
  .sp-detail-title {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
    color: var(--text);
  }

  /* Pinned footer */
  .sp-foot {
    display: flex;
    justify-content: flex-end;
    padding: 14px 22px;
    border-top: 1px solid var(--border);
    flex: none;
  }

  .btn-done {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    padding: 8px 20px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .btn-done:hover {
    background: var(--surface);
    border-color: var(--border-strong);
  }
</style>
