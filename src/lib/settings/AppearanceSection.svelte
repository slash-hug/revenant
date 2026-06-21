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
  import { settings, patchSettings } from '../stores/settings';

  function handleZoomInput(e: Event) {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!Number.isNaN(value)) setZoom(value);
  }

  function handleOpeningAnimation(e: Event) {
    patchSettings({ opening_animation: (e.target as HTMLInputElement).checked });
  }

  function handleFirstLaunchOnly(e: Event) {
    patchSettings({
      opening_animation_first_launch_only: (e.target as HTMLInputElement).checked,
    });
  }

  $: openingAnimation = $settings?.opening_animation ?? true;
  $: firstLaunchOnly = $settings?.opening_animation_first_launch_only ?? false;
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
    helper="Scale the preview reading column. Use the zoom bar at the bottom of the preview, or Ctrl+Plus/Minus / Ctrl+0."
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

  <SettingRow
    label="Opening animation"
    helper="Play the ink-bloom effect when entering a document from the welcome screen. Turn off to open straight to the markdown with no delay."
  >
    <label class="checkbox-row">
      <input
        type="checkbox"
        checked={openingAnimation}
        on:change={handleOpeningAnimation}
        aria-label="Enable opening animation"
      />
      <span class="checkbox-text">{openingAnimation ? 'On' : 'Off'}</span>
    </label>
  </SettingRow>

  <SettingRow
    label="Only on first launch"
    helper="Play the opening animation just once per session — reopening from the welcome screen later won't replay it."
  >
    <label class="checkbox-row" class:disabled={!openingAnimation}>
      <input
        type="checkbox"
        checked={firstLaunchOnly}
        disabled={!openingAnimation}
        on:change={handleFirstLaunchOnly}
        aria-label="Play opening animation only on first launch"
      />
      <span class="checkbox-text">{firstLaunchOnly ? 'On' : 'Off'}</span>
    </label>
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

  .checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .checkbox-row.disabled {
    cursor: default;
    opacity: 0.5;
  }

  .checkbox-row input[type='checkbox'] {
    accent-color: var(--accent);
    cursor: pointer;
    flex: none;
  }

  .checkbox-row.disabled input[type='checkbox'] {
    cursor: default;
  }

  .checkbox-text {
    font-size: var(--fs-sm);
    color: var(--text-muted);
    min-width: 2.5ch;
  }
</style>
