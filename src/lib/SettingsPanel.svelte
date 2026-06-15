<script lang="ts">
  /**
   * SettingsPanel — WS-C implements the full version.
   *
   * This stub is created by WS-A so that App.svelte can import and mount
   * SettingsPanel without waiting for WS-C to land.  WS-C will replace this
   * file with the full dialog shell (showModal, sections, Done button, etc.).
   *
   * Props:
   *   open: boolean  — controlled open state
   * Events:
   *   close          — emitted when the panel should close
   */
  import { createEventDispatcher } from "svelte";

  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  $: if (open && typeof dialog !== "undefined" && dialog) {
    dialog.showModal();
  }

  let dialog: HTMLDialogElement;

  function close() {
    dialog?.close();
    dispatch("close");
  }
</script>

<!-- WS-C stub: minimal dialog so App.svelte mounts without error. -->
{#if open}
  <dialog
    bind:this={dialog}
    class="modal"
    on:cancel|preventDefault={close}
    aria-label="Settings"
  >
    <div class="modal-header">
      <span>Settings</span>
    </div>
    <div class="modal-body">
      <!-- WS-C will compose ObsidianSection and AppearanceSection here. -->
    </div>
    <div class="modal-footer">
      <button type="button" on:click={close}>Done</button>
    </div>
  </dialog>
{/if}

<style>
  .modal { max-width: 520px; width: 100%; border-radius: 8px; padding: 0; }
  .modal-header { padding: 16px 20px; font-weight: 600; }
  .modal-body { padding: 0 20px; max-height: min(70vh, 640px); overflow-y: auto; }
  .modal-footer { padding: 16px 20px; display: flex; justify-content: flex-end; }
</style>
