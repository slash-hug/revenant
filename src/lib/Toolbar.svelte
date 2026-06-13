<script lang="ts">
  /**
   * Toolbar.svelte — top action bar.
   *
   * Decisions implemented:
   *  - View-mode toggle: source / preview / split.
   *  - "Generate review" button (agent-agnostic label — TRAP 2: never "Claude").
   *  - Export-to-Obsidian button.
   *
   * Events:
   *  - viewMode    : { mode: ViewMode }
   *  - generateReview  : void
   *  - exportObsidian  : void
   */
  import { createEventDispatcher } from 'svelte';

  type ViewMode = 'source' | 'preview' | 'split';

  export let viewMode: ViewMode = 'split';

  const dispatch = createEventDispatcher<{
    viewMode: { mode: ViewMode };
    generateReview: void;
    exportObsidian: void;
  }>();

  function setMode(mode: ViewMode) {
    if (viewMode === mode) return;
    viewMode = mode;
    dispatch('viewMode', { mode });
  }
</script>

<header class="toolbar" role="toolbar" aria-label="Document actions">
  <!-- View-mode toggles -->
  <div class="btn-group" role="group" aria-label="View mode">
    <button
      class="btn-mode"
      class:active={viewMode === 'source'}
      on:click={() => setMode('source')}
      aria-pressed={viewMode === 'source'}
      title="Source editor only"
    >Source</button>
    <button
      class="btn-mode"
      class:active={viewMode === 'split'}
      on:click={() => setMode('split')}
      aria-pressed={viewMode === 'split'}
      title="Side-by-side editor and preview"
    >Split</button>
    <button
      class="btn-mode"
      class:active={viewMode === 'preview'}
      on:click={() => setMode('preview')}
      aria-pressed={viewMode === 'preview'}
      title="Preview only"
    >Preview</button>
  </div>

  <div class="toolbar-spacer" aria-hidden="true"></div>

  <!-- Review + export actions -->
  <div class="toolbar-actions">
    <!-- Agent-agnostic label: "Generate review" (TRAP 2 — never hardcode "Claude") -->
    <button
      class="btn-action btn-review"
      on:click={() => dispatch('generateReview')}
      title="Generate a .review.md file from your annotations"
    >
      Generate review
    </button>

    <button
      class="btn-action btn-obsidian"
      on:click={() => dispatch('exportObsidian')}
      title="Export review to your Obsidian vault"
    >
      Export to Obsidian
    </button>
  </div>
</header>

<style>
  .toolbar {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--toolbar-bg, #f0f0f0);
    border-bottom: 1px solid var(--border-color, #ddd);
    min-height: 42px;
    flex-shrink: 0;
  }

  .btn-group {
    display: flex;
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    overflow: hidden;
  }

  .btn-mode {
    border: none;
    background: transparent;
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
    color: var(--btn-fg, #444);
    border-right: 1px solid var(--border-color, #ccc);
    transition: background 0.1s;
  }

  .btn-mode:last-child {
    border-right: none;
  }

  .btn-mode:hover {
    background: var(--btn-hover, #e0e0e0);
  }

  .btn-mode.active {
    background: var(--accent, #0066cc);
    color: #fff;
    font-weight: 600;
  }

  .toolbar-spacer {
    flex: 1;
  }

  .toolbar-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn-action {
    border: 1px solid var(--border-color, #ccc);
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: var(--btn-bg, #fff);
    color: var(--btn-fg, #333);
    transition: background 0.1s, border-color 0.1s;
    white-space: nowrap;
  }

  .btn-action:hover {
    background: var(--btn-hover, #e8e8e8);
    border-color: var(--btn-fg, #333);
  }

  .btn-review {
    background: var(--accent, #0066cc);
    color: #fff;
    border-color: var(--accent, #0066cc);
  }

  .btn-review:hover {
    background: var(--accent-dark, #0052a3);
    border-color: var(--accent-dark, #0052a3);
  }

  .btn-obsidian {
    background: var(--obsidian-bg, #7c3aed);
    color: #fff;
    border-color: var(--obsidian-bg, #7c3aed);
  }

  .btn-obsidian:hover {
    background: var(--obsidian-dark, #6d28d9);
    border-color: var(--obsidian-dark, #6d28d9);
  }
</style>
