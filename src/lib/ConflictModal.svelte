<script lang="ts">
  /**
   * ConflictModal.svelte — blocking conflict-resolution dialog (C12).
   * Two options: Reload (take disk) / Keep mine. Esc / backdrop = Keep mine
   * (safe default — no data loss). Wired to file_changed + save HASH_MISMATCH.
   *
   * Uses the native <dialog> element via showModal(), which provides a real
   * focus trap, Esc handling, and an inert background for free.
   */
  import { createEventDispatcher } from 'svelte';
  import { basename } from './util/path';

  export let open: boolean = false;
  export let filePath: string = '';

  const dispatch = createEventDispatcher<{ reload: void; keepMine: void }>();

  let dialog: HTMLDialogElement | undefined;

  // Drive the native modal from the `open` prop.
  $: if (dialog) {
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }

  function handleReload() { dispatch('reload'); }
  function handleKeepMine() { dispatch('keepMine'); }

  // Esc (native `cancel`) → keep edits (safe default). Prevent the auto-close;
  // the parent clears `open`, which closes the dialog via the reactive block.
  function handleCancel(e: Event) { e.preventDefault(); handleKeepMine(); }

  $: fileName = basename(filePath);
</script>

<dialog
  bind:this={dialog}
  class="modal"
  aria-labelledby="conflict-title"
  aria-describedby="conflict-desc"
  on:cancel={handleCancel}
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
</dialog>

<style>
  .modal {
    margin: auto; /* center in the viewport */
    width: 440px;
    max-width: 92vw;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 22px 24px;
  }
  .modal[open] {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    animation: modal-in var(--dur-slow) var(--ease-out);
  }
  .modal::backdrop {
    background: color-mix(in srgb, var(--bg) 35%, rgba(0, 0, 0, .45));
    backdrop-filter: blur(2px);
    animation: scrim-in var(--dur-base) var(--ease-out);
  }
  @keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modal-in {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal[open], .modal::backdrop { animation: none; }
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
