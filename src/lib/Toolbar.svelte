<script lang="ts">
  /**
   * Toolbar.svelte — top action bar.
   *  - Brand mark + segmented view-mode toggle (source / preview / split)
   *  - "Generate review" (primary)
   *  - Obsidian → compact icon button (per D5)
   *  - "Export ▾" dropdown: "Export document (PDF/HTML)…" | "Export to Obsidian"
   *  - Theme toggle
   * Decisions:
   *  - Agent-agnostic label — never "Claude" (TRAP 2).
   *  - D5: Obsidian → icon-btn, new "Export ▾" dropdown holds export targets.
   *  - D4: dropdown is a native <dialog> positioned to the button via
   *         getBoundingClientRect. Esc and outside-click dismiss it.
   *  - Collapses Export button text to icon at ≤1080px.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import ThemeToggle from './ThemeToggle.svelte';

  type ViewMode = 'source' | 'preview' | 'split';

  export let viewMode: ViewMode = 'split';
  export let drawerOpen: boolean = true;

  const dispatch = createEventDispatcher<{
    viewMode: { mode: ViewMode };
    generateReview: void;
    exportObsidian: void;
    exportDocument: void;
    toggleDrawer: void;
    openPalette: void;
    openShortcuts: void;
  }>();

  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
  const paletteHint = isMac ? '⌘K' : 'Ctrl K';

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

  // ---------------------------------------------------------------------------
  // Export dropdown (D4/D5) — native <dialog> anchored to the button rect.
  // ---------------------------------------------------------------------------

  let exportDropDialog: HTMLDialogElement | undefined;
  let exportBtnEl: HTMLButtonElement | undefined;
  let dropOpen = false;

  function openExportDrop() {
    if (!exportDropDialog || !exportBtnEl) return;
    const rect = exportBtnEl.getBoundingClientRect();
    // Position the menu below-right of the button.
    exportDropDialog.style.left = `${rect.left}px`;
    exportDropDialog.style.top = `${rect.bottom + 6}px`;
    exportDropDialog.show(); // non-modal so clicks outside bubble normally
    dropOpen = true;
  }

  function closeExportDrop() {
    if (!exportDropDialog) return;
    exportDropDialog.close();
    dropOpen = false;
    // Return focus to the trigger button so keyboard flow is preserved.
    exportBtnEl?.focus();
  }

  function handleExportDocument() {
    closeExportDrop();
    dispatch('exportDocument');
  }

  function handleExportObsidian() {
    closeExportDrop();
    dispatch('exportObsidian');
  }

  // Outside-click dismiss — mirrors PreviewPane affordance-dismiss pattern
  // (PreviewPane L576–588).
  function handleOutsideClick(e: MouseEvent) {
    if (!dropOpen) return;
    const target = e.target as Element | null;
    // Allow clicks on the trigger button itself (it will close via toggle).
    if (target?.closest?.('.export-drop-menu') || target?.closest?.('.export-btn')) return;
    closeExportDrop();
  }

  // Esc — close via keydown because non-modal dialog cancel doesn't fire.
  function handleEscKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && dropOpen) {
      e.stopPropagation();
      closeExportDrop();
    }
  }

  onMount(() => {
    window.addEventListener('mousedown', handleOutsideClick, true);
    window.addEventListener('keydown', handleEscKeydown, true);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick, true);
      window.removeEventListener('keydown', handleEscKeydown, true);
    };
  });

  function toggleExportDrop() {
    if (dropOpen) closeExportDrop();
    else openExportDrop();
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
      {#each modes as m, i (m.id)}
        <button
          type="button"
          class:active={viewMode === m.id}
          aria-pressed={viewMode === m.id}
          title={`${m.label} (⌘${i + 1})`}
          on:click={() => setMode(m.id)}
        >{m.label}</button>
      {/each}
    </div>
  </div>

  <div class="right">
    <button
      type="button"
      class="cmdk-trigger"
      on:click={() => dispatch('openPalette')}
      title={`Command palette (${paletteHint})`}
      aria-label="Open command palette"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
      </svg>
      <kbd>{paletteHint}</kbd>
    </button>

    <button
      type="button"
      class="btn btn-primary"
      on:click={() => dispatch('generateReview')}
      title="Generate a .review.md file from your annotations (⌘⇧R)"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" /><path d="m9 14 2 2 4-4" />
      </svg>
      Generate review
    </button>

    <!-- Export dropdown trigger (D5 option c) -->
    <div class="export-wrap">
      <button
        type="button"
        class="btn btn-secondary export-btn"
        class:active={dropOpen}
        aria-expanded={dropOpen}
        aria-haspopup="menu"
        bind:this={exportBtnEl}
        on:click={toggleExportDrop}
        title="Export options"
      >
        <!-- Upload/export icon -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 16V4M8 8l4-4 4 4" />
          <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
        <span class="export-label">Export</span>
        <svg class="chevron" class:flipped={dropOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <!-- Native non-modal <dialog> dropdown menu (D4) -->
      <dialog
        bind:this={exportDropDialog}
        class="export-drop-menu"
        role="menu"
        aria-label="Export options"
      >
        <button
          type="button"
          class="drop-item"
          role="menuitem"
          on:click={handleExportDocument}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
          </svg>
          Export document (PDF/HTML)…
        </button>
        <div class="drop-divider" aria-hidden="true"></div>
        <button
          type="button"
          class="drop-item"
          role="menuitem"
          on:click={handleExportObsidian}
        >
          <!-- Obsidian diamond icon -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3 4 9v6l8 6 8-6V9l-8-6Z" /><path d="M12 3v18" />
          </svg>
          Export to Obsidian
        </button>
      </dialog>
    </div>

    <button
      type="button"
      class="icon-btn"
      class:active={drawerOpen}
      aria-pressed={drawerOpen}
      on:click={() => dispatch('toggleDrawer')}
      title={`${drawerOpen ? 'Hide' : 'Show'} annotation panel (⌘\\)`}
      aria-label="Toggle annotation panel"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="15" y1="4" x2="15" y2="20" />
      </svg>
    </button>

    <button
      type="button"
      class="icon-btn"
      on:click={() => dispatch('openShortcuts')}
      title="Keyboard shortcuts"
      aria-label="Keyboard shortcuts"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M9.4 9.3a2.6 2.6 0 1 1 3.5 2.4c-.6.3-.9.7-.9 1.5" />
        <path d="M12 16.6h.01" />
      </svg>
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
  .btn-secondary.active { border-color: var(--border-strong); background: var(--surface-2); }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
  }
  .icon-btn svg { width: 17px; height: 17px; }
  .icon-btn:hover { color: var(--text); background: var(--surface-2); }
  .icon-btn.active { color: var(--accent-text); background: var(--accent-soft); }

  .tb-divider {
    width: 1px;
    height: 22px;
    background: var(--border);
    margin: 0 var(--sp-1);
  }

  /* Command-palette trigger */
  .cmdk-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
    padding: 6px 9px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-muted);
    transition: color var(--dur-fast), background var(--dur-fast), border-color var(--dur-fast);
  }
  .cmdk-trigger:hover { color: var(--text); border-color: var(--border-strong); }
  .cmdk-trigger svg { width: 15px; height: 15px; }
  .cmdk-trigger kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1;
    color: var(--text-faint);
  }

  /* Export dropdown wrapper */
  .export-wrap {
    position: relative;
  }

  .export-btn .chevron {
    width: 13px;
    height: 13px;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .export-btn .chevron.flipped { transform: rotate(180deg); }

  /* Native <dialog> dropdown menu (D4: positioned via inline style from JS) */
  .export-drop-menu {
    /* dialog reset */
    margin: 0;
    padding: 4px;
    position: fixed; /* overridden by JS-set left/top */
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-pop);
    min-width: 220px;
    z-index: var(--z-dropdown, 500);
    animation: drop-in var(--dur-fast) var(--ease-out);
  }
  .export-drop-menu[open] { display: flex; flex-direction: column; gap: 2px; }
  @keyframes drop-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .export-drop-menu { animation: none; } }

  .drop-item {
    font: inherit;
    font-size: var(--fs-sm);
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: var(--r-md);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast);
    white-space: nowrap;
  }
  .drop-item svg { width: 15px; height: 15px; color: var(--text-muted); flex: none; }
  .drop-item:hover { background: var(--surface-2); }
  .drop-item:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .drop-divider {
    height: 1px;
    background: var(--border);
    margin: 2px 0;
  }

  /* Responsive: at ≤1080px, hide "Export" text label — show icon only */
  @media (max-width: 1080px) {
    .export-label { display: none; }
    .cmdk-trigger kbd { display: none; }
    .brand-word { display: none; }
  }
</style>
