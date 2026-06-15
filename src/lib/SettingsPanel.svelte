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

  import { createEventDispatcher } from 'svelte';
  import ObsidianSection from './settings/ObsidianSection.svelte';
  import AppearanceSection from './settings/AppearanceSection.svelte';

  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  let dialog: HTMLDialogElement | undefined;

  // Reactive: open/close the native dialog in sync with the `open` prop.
  $: if (dialog) {
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
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

  <!-- Scrollable body -->
  <div class="sp-body">
    <ObsidianSection />
    <AppearanceSection />
  </div>

  <!-- Pinned footer -->
  <div class="sp-foot">
    <button type="button" class="btn-done" on:click={close}>Done</button>
  </div>
</dialog>

<style>
  .sp {
    margin: auto;
    width: 520px;
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

  /* Scrollable body — D2 */
  .sp-body {
    flex: 1 1 auto;
    overflow-y: auto;
    max-height: min(70vh, 640px);
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 24px;
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
