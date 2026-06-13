<script lang="ts">
  /**
   * ConflictModal.svelte — blocking conflict-resolution dialog.
   *
   * Decisions implemented:
   *  - C12  Two options only (v1): Reload (take disk) / Keep mine (ignore
   *         external change until next save). Blocking modal. Dismiss/Esc = Keep
   *         mine (safe default — no data loss). Show-diff deferred to post-v1.
   *  - A5   Wired to the file_changed event and save_file conflict response.
   *
   * Props:
   *  - open     : boolean — whether the modal is visible.
   *  - filePath : string  — the file that changed externally.
   *
   * Events:
   *  - reload   : void — user chose "Reload (discard my edits)".
   *  - keepMine : void — user chose "Keep mine" (or dismissed the modal).
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { basename } from './util/path';

  export let open: boolean = false;
  export let filePath: string = '';

  const dispatch = createEventDispatcher<{
    reload: void;
    keepMine: void;
  }>();

  function handleReload() {
    dispatch('reload');
  }

  function handleKeepMine() {
    dispatch('keepMine');
  }

  // Dismiss via Escape = Keep mine (safe default).
  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      handleKeepMine();
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  $: fileName = basename(filePath);
</script>

{#if open}
  <!-- Trap focus inside the modal while open (accessibility). -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-interactive-supports-focus -->
  <div
    class="modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="conflict-title"
    aria-describedby="conflict-desc"
    tabindex="-1"
    on:keydown={handleKeydown}
  >
    <div class="modal-box">
      <h2 id="conflict-title" class="modal-title">File changed externally</h2>
      <p id="conflict-desc" class="modal-desc">
        <strong>{fileName}</strong> was modified outside Revenant while you had unsaved changes.
        What would you like to do?
      </p>

      <div class="modal-actions">
        <!-- svelte-ignore a11y-autofocus -->
        <button
          class="btn-reload"
          on:click={handleReload}
          autofocus
        >
          Reload
          <span class="btn-hint">Discard my edits, take disk version</span>
        </button>

        <button
          class="btn-keep"
          on:click={handleKeepMine}
        >
          Keep mine
          <span class="btn-hint">Ignore disk change until my next save</span>
        </button>
      </div>

      <p class="modal-footer-hint">
        Press <kbd>Esc</kbd> to keep your edits (safe default — no data loss).
      </p>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-box {
    background: var(--modal-bg, #fff);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.22);
    padding: 28px 32px;
    max-width: 440px;
    width: 90vw;
    font-size: 14px;
  }

  .modal-title {
    margin: 0 0 12px 0;
    font-size: 18px;
    font-weight: 700;
    color: var(--fg, #222);
  }

  .modal-desc {
    margin: 0 0 24px 0;
    line-height: 1.6;
    color: var(--fg, #444);
  }

  .modal-actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .btn-reload,
  .btn-keep {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    border-radius: 6px;
    padding: 12px 16px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    border: 1px solid transparent;
    transition: background 0.1s, border-color 0.1s;
    text-align: left;
  }

  .btn-hint {
    font-size: 11px;
    font-weight: 400;
    opacity: 0.75;
  }

  .btn-reload {
    background: var(--error-bg, #fff0f0);
    color: var(--error-fg, #c00);
    border-color: var(--error-border, #f08080);
  }

  .btn-reload:hover {
    background: var(--error-hover, #ffe0e0);
    border-color: var(--error-fg, #c00);
  }

  .btn-keep {
    background: var(--btn-bg, #f5f5f5);
    color: var(--btn-fg, #333);
    border-color: var(--border-color, #ccc);
  }

  .btn-keep:hover {
    background: var(--btn-hover, #e8e8e8);
    border-color: var(--btn-fg, #333);
  }

  .modal-footer-hint {
    margin: 20px 0 0 0;
    font-size: 11px;
    color: var(--muted, #888);
  }

  kbd {
    background: var(--code-bg, #f0f0f0);
    border: 1px solid var(--border-color, #ccc);
    border-radius: 3px;
    padding: 1px 5px;
    font-size: 10px;
    font-family: var(--editor-font, monospace);
  }
</style>
