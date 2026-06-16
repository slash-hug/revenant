<script lang="ts">
  /**
   * SettingRow.svelte — label + helper text + control-slot row primitive.
   *
   * Renders a single setting row with:
   *   - `label` prop (field name, --fs-base / --fw-semibold)
   *   - `helper` prop (secondary description, --fs-sm / --text-muted)
   *   - default slot for the control (input, toggle, select, etc.)
   *   - hairline bottom border (1px var(--border)) between rows
   *     (controlled by the parent via :last-child selector)
   *
   * Svelte 4 options-API to match ExportDialog / ConflictModal pattern.
   */

  /** Primary field label shown at --fs-base / --fw-semibold. */
  export let label: string;

  /** Optional secondary helper text shown at --fs-sm / --text-muted. */
  export let helper: string = '';
</script>

<div class="row">
  <div class="row-text">
    <span class="row-label">{label}</span>
    {#if helper}
      <span class="row-helper">{helper}</span>
    {/if}
  </div>
  <div class="row-control">
    <slot />
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }

  /* Remove the divider from the last row in a group card */
  .row:last-child {
    border-bottom: none;
  }

  /* Text block: label + helper stacked */
  .row-text {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .row-label {
    font-size: var(--fs-base);
    font-weight: var(--fw-semibold);
    color: var(--text);
    line-height: var(--lh-snug);
  }

  .row-helper {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    line-height: var(--lh-snug);
  }

  /* Control slot — right-aligned, flex shrinks to content */
  .row-control {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
