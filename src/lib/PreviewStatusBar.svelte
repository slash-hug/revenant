<script lang="ts">
  /**
   * PreviewStatusBar.svelte — persistent zoom control bar at the bottom of the
   * preview pane.
   *
   * Bound to the previewZoom store. Provides −/slider/+ controls and a reset
   * button showing the current zoom percentage.
   *
   * Mounted as a fixed-height flex sibling of .pv-scroll in PreviewPane so it
   * stays visible while the preview scrolls.
   */
  import {
    previewZoom,
    setZoom,
    adjustZoom,
    resetZoom,
    ZOOM_MIN,
    ZOOM_MAX,
    ZOOM_STEP,
    ZOOM_DEFAULT,
  } from './stores/previewZoom';

  function handleSliderInput(e: Event) {
    const value = parseInt((e.target as HTMLInputElement).value, 10);
    if (!Number.isNaN(value)) setZoom(value);
  }
</script>

<div class="psb" role="toolbar" aria-label="Preview zoom controls">
  <button
    class="psb-btn"
    title="Zoom out (Ctrl+−)"
    onclick={() => adjustZoom(-ZOOM_STEP)}
    aria-label="Zoom out"
    disabled={$previewZoom <= ZOOM_MIN}
  >
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 8h10"/>
    </svg>
  </button>

  <input
    class="psb-slider"
    type="range"
    min={ZOOM_MIN}
    max={ZOOM_MAX}
    step={ZOOM_STEP}
    value={$previewZoom}
    oninput={handleSliderInput}
    aria-label="Preview zoom level"
    aria-valuemin={ZOOM_MIN}
    aria-valuemax={ZOOM_MAX}
    aria-valuenow={$previewZoom}
    aria-valuetext="{$previewZoom}%"
  />

  <button
    class="psb-btn"
    title="Zoom in (Ctrl+=)"
    onclick={() => adjustZoom(ZOOM_STEP)}
    aria-label="Zoom in"
    disabled={$previewZoom >= ZOOM_MAX}
  >
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M8 3v10M3 8h10"/>
    </svg>
  </button>

  <button
    class="psb-reset"
    title="Reset zoom to 100% (Ctrl+0)"
    onclick={resetZoom}
    aria-label="Reset zoom to {ZOOM_DEFAULT}%"
  >
    {$previewZoom}%
  </button>
</div>

<style>
  .psb {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-top: 1px solid var(--border, rgba(255,255,255,0.08));
    background: var(--surface, #1a1a2e);
    flex-shrink: 0;
    height: 30px;
    box-sizing: border-box;
  }

  .psb-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--r-xs, 3px);
    color: var(--text-muted, #999);
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }

  .psb-btn:hover:not(:disabled) {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }

  .psb-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .psb-slider {
    flex: 1;
    min-width: 60px;
    max-width: 120px;
    accent-color: var(--accent, #7c6cf0);
    cursor: pointer;
    height: 4px;
  }

  .psb-reset {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted, #999);
    background: transparent;
    border: none;
    border-radius: var(--r-xs, 3px);
    cursor: pointer;
    padding: 1px 4px;
    min-width: 3.5ch;
    text-align: right;
    transition: color 0.15s, background 0.15s;
  }

  .psb-reset:hover {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }
</style>
