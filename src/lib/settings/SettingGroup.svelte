<script lang="ts">
  /**
   * SettingGroup.svelte — card-wrapper primitive for settings sections.
   *
   * Renders a card with:
   *   - Optional uppercase eyebrow label (prop: `label`)
   *   - Default slot for SettingRow children
   *
   * Svelte 4 options-API to match ExportDialog / ConflictModal pattern.
   */

  /** Optional eyebrow label displayed above the card content. */
  export let label: string = '';
</script>

<div class="group">
  {#if label}
    <p class="group-eyebrow" aria-hidden="true">{label}</p>
  {/if}
  <div class="group-card">
    <slot />
  </div>
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* Uppercase eyebrow — identifies the group */
  .group-eyebrow {
    margin: 0;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: .08em;
  }

  /* Card: surface background, border, rounded corners */
  .group-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
  }
</style>
