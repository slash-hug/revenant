<script lang="ts">
  /**
   * ConflictModal.svelte — blocking conflict-resolution dialog (C12).
   * Two options: Reload (take disk) / Keep mine. Esc / dismiss = Keep mine
   * (safe default — no data loss). Wired to file_changed + save HASH_MISMATCH.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { basename } from './util/path';

  export let open: boolean = false;
  export let filePath: string = '';

  const dispatch = createEventDispatcher<{ reload: void; keepMine: void }>();

  function handleReload() { dispatch('reload'); }
  function handleKeepMine() { dispatch('keepMine'); }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); handleKeepMine(); }
  }

  onMount(() => window.addEventListener('keydown', handleKeydown));
  onDestroy(() => window.removeEventListener('keydown', handleKeydown));

  $: fileName = basename(filePath);
</script>

{#if open}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-interactive-supports-focus -->
  <div class="modal-scrim" on:keydown={handleKeydown}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      aria-describedby="conflict-desc"
    >
      <h3 id="conflict-title">File changed externally</h3>
      <p id="conflict-desc">
        <strong>{fileName}</strong> was modified outside Revenant while you had unsaved changes.
        Keep your edits, or reload the version on disk?
      </p>

      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" on:click={handleReload}>
          Reload from disk
        </button>
        <!-- svelte-ignore a11y-autofocus -->
        <button type="button" class="btn btn-primary" on:click={handleKeepMine} autofocus>
          Keep my edits
        </button>
      </div>

      <p class="modal-hint">Press <kbd>Esc</kbd> to keep your edits — the safe default.</p>
    </div>
  </div>
{/if}

<style>
  .modal-scrim {
    position: fixed;
    inset: 0;
    z-index: var(--z-scrim);
    background: color-mix(in srgb, var(--bg) 35%, rgba(0, 0, 0, .45));
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: scrim-in var(--dur-base) var(--ease-out);
  }
  @keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }

  .modal {
    width: 440px;
    max-width: 92vw;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 22px 24px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    animation: modal-in var(--dur-slow) var(--ease-out);
  }
  @keyframes modal-in {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal-scrim, .modal { animation: none; }
  }

  .modal h3 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
    color: var(--text);
  }
  .modal p {
    margin: 0;
    font-size: var(--fs-base);
    line-height: var(--lh-snug);
    color: var(--text-muted);
  }
  .modal strong { color: var(--text); font-weight: var(--fw-semibold); }

  .modal-actions {
    display: flex;
    gap: var(--sp-2);
    justify-content: flex-end;
    margin-top: var(--sp-2);
  }

  .modal-hint {
    font-size: var(--fs-xs) !important;
    color: var(--text-faint) !important;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 1px 5px;
  }

  .btn {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    line-height: 1;
    cursor: pointer;
    padding: 8px 14px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
  }
  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: var(--fw-semibold);
    box-shadow: var(--accent-shadow);
  }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
    box-shadow: var(--shadow-sm);
  }
  .btn-secondary:hover { border-color: var(--border-strong); }
</style>
