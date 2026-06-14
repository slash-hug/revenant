<script lang="ts">
  /**
   * Toolbar.svelte — top action bar.
   *  - Brand mark + segmented view-mode toggle (source / preview / split)
   *  - "Generate review" (primary) + "Export to Obsidian" (secondary)
   *  - Theme toggle
   * Decisions: agent-agnostic label — never "Claude" (TRAP 2).
   */
  import { createEventDispatcher } from 'svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  type ViewMode = 'source' | 'preview' | 'split';

  export let viewMode: ViewMode = 'split';

  const dispatch = createEventDispatcher<{
    viewMode: { mode: ViewMode };
    generateReview: void;
    exportObsidian: void;
  }>();

  const modes: { id: ViewMode; label: string }[] = [
    { id: 'source', label: 'Source' },
    { id: 'split', label: 'Split' },
    { id: 'preview', label: 'Preview' },
  ];

  function setMode(mode: ViewMode) {
    if (viewMode === mode) return;
    viewMode = mode;
    dispatch('viewMode', { mode });
  }
</script>

<header class="ws-toolbar" role="toolbar" aria-label="Document actions">
  <div class="left">
    <span class="brand" aria-label="Revenant">
      <svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="var(--accent)" />
        <path d="M8.5 16.5V8.4a.9.9 0 0 1 .9-.9h2.9a2.6 2.6 0 0 1 0 5.2H9.4M12.6 12.7l3 3.8"
          stroke="var(--text-on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="brand-word">Revenant</span>
    </span>

    <div class="seg" role="group" aria-label="View mode">
      {#each modes as m (m.id)}
        <button
          type="button"
          class:active={viewMode === m.id}
          aria-pressed={viewMode === m.id}
          on:click={() => setMode(m.id)}
        >{m.label}</button>
      {/each}
    </div>
  </div>

  <div class="right">
    <button
      type="button"
      class="btn btn-primary"
      on:click={() => dispatch('generateReview')}
      title="Generate a .review.md file from your annotations"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" /><path d="m9 14 2 2 4-4" />
      </svg>
      Generate review
    </button>

    <button
      type="button"
      class="btn btn-secondary"
      on:click={() => dispatch('exportObsidian')}
      title="Export review to your Obsidian vault"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3 4 9v6l8 6 8-6V9l-8-6Z" /><path d="M12 3v18" />
      </svg>
      Export to Obsidian
    </button>

    <div class="tb-divider" aria-hidden="true"></div>
    <ThemeToggle />
  </div>
</header>

<style>
  .ws-toolbar {
    height: 54px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-4);
    padding: 0 var(--sp-3);
    background: var(--toolbar);
    border-bottom: 1px solid var(--border);
  }
  .left, .right { display: flex; align-items: center; gap: var(--sp-3); }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-md);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
    color: var(--text);
    padding-right: var(--sp-1);
  }
  .brand-mark { width: 22px; height: 22px; flex: none; }

  /* Segmented toggle */
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--r-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .seg button {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
    padding: 5px 13px;
    border-radius: var(--r-sm);
    border: none;
    background: transparent;
    color: var(--text-muted);
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .seg button:hover { color: var(--text); }
  .seg button.active {
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }

  /* Buttons */
  .btn {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
    padding: 8px 14px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    white-space: nowrap;
    transition: background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .btn svg { width: 14px; height: 14px; }
  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: var(--fw-semibold);
    box-shadow: var(--accent-shadow);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-primary:active { background: var(--accent-press); }
  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
    box-shadow: var(--shadow-sm);
  }
  .btn-secondary:hover { border-color: var(--border-strong); }

  .tb-divider {
    width: 1px;
    height: 22px;
    background: var(--border);
    margin: 0 var(--sp-1);
  }

  @media (max-width: 1080px) {
    .brand-word { display: none; }
  }
</style>
