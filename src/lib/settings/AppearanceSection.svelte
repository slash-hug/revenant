<script lang="ts">
  /**
   * AppearanceSection.svelte — Appearance settings section (C-4).
   *
   * Embeds <ThemeToggle> which is self-managed via the `theme.ts` store
   * (localStorage → `<html data-theme>`). This component MUST NOT call
   * `patchSettings` or touch `settings.theme` — the `settings.theme` field is
   * orphaned; `theme.ts` is the canonical source of truth (TRAP 3).
   *
   * Svelte 4 options-API to match the component library.
   */

  import ThemeToggle from '../ThemeToggle.svelte';
</script>

<section class="appearance-section" aria-label="Appearance settings">
  <h4 class="section-title">Appearance</h4>

  <div class="field-row">
    <span class="field-label">Theme</span>
    <ThemeToggle />
  </div>
</section>

<style>
  .appearance-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section-title {
    margin: 0 0 4px;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .field-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .field-label {
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--text);
    min-width: 60px;
  }
</style>
