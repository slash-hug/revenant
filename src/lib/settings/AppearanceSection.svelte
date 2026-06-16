<script lang="ts">
  /**
   * AppearanceSection.svelte — Appearance settings section.
   *
   * Embeds <ThemeToggle> which is self-managed via the `theme.ts` store
   * (localStorage → `<html data-theme>`). This component MUST NOT call
   * `patchSettings` or touch `settings.theme` — the `settings.theme` field is
   * orphaned; `theme.ts` is the canonical source of truth (TRAP 3).
   *
   * Preview zoom: the slider drives `previewZoom` store → CSS transform on
   * `.prose` in PreviewPane. Changes persist via debounced patchSettings.
   *
   * Svelte 4 options-API to match the component library.
   */

  import ThemeToggle from '../ThemeToggle.svelte';
  import SettingGroup from './SettingGroup.svelte';
  import SettingRow from './SettingRow.svelte';
  import {
    previewZoom,
    setZoom,
    ZOOM_MIN,
    ZOOM_MAX,
    ZOOM_STEP,
  } from '../stores/previewZoom';

  function handleZoomInput(e: Event) {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!Number.isNaN(value)) setZoom(value);
  }
</script>

<SettingGroup label="Appearance">
  <SettingRow
    label="Theme"
    helper="Choose between light (Paper) and dark (Graphite) mode."
  >
    <ThemeToggle />
  </SettingRow>

  <SettingRow
    label="Preview zoom"
    helper="Scale the preview reading column. Use Ctrl+scroll or Ctrl+Plus/Minus to adjust from the preview."
  >
    <div class="zoom-control">
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={$previewZoom}
        on:input={handleZoomInput}
        aria-label="Preview zoom level"
        class="zoom-slider"
      />
      <span class="zoom-value">{$previewZoom}%</span>
    </div>
  </SettingRow>
</SettingGroup>

<style>
  .zoom-control {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .zoom-slider {
    width: 120px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .zoom-value {
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    min-width: 3.5ch;
    text-align: right;
  }
</style>
