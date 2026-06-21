<script lang="ts">
  /**
   * MermaidContainer.svelte — static presenter for rendered Mermaid diagrams.
   *
   * Renders a pre-sanitized SVG at its intrinsic size, fit to the column width
   * (never upscaled). A hover/focus control strip provides in-place zoom, fit,
   * copy-PNG, and expand-to-lightbox actions.
   *
   * Mounted imperatively by PreviewPane after Mermaid hydration via
   * `mount(MermaidContainer, { target, props })`.
   */
  import { copyDiagramAsPng } from './diagramCopy';
  import { toast } from './stores/toast';

  interface Props {
    svg: string;
    source: string;
    blockId: string;
    onExpand?: (d: { svg: string; source: string; blockId: string }) => void;
  }

  let { svg, source, blockId, onExpand }: Props = $props();

  // ── Hover / focus state for the control strip ────────────────────────────
  let hovering = $state(false);
  let focused = $state(false);
  let copyFeedback = $state(false);

  // ── In-place zoom (inline only; bound to [1.0, 2.0]; never upscales baseline) ──
  /** Inline zoom scale: 1.0 = fit-to-width, 2.0 = max in-place magnification. */
  let inlineScale = $state(1.0);
  const INLINE_ZOOM_MIN = 1.0;
  const INLINE_ZOOM_MAX = 2.0;
  const INLINE_ZOOM_STEP = 0.25;

  // ── SVG intrinsic dimensions for fit-to-width calc ──────────────────────
  let containerEl: HTMLDivElement | undefined = $state(undefined);

  /**
   * Parse SVG intrinsic width from the pre-sanitized svg string.
   * Handles Mermaid v11 which may emit width='100%' — falls back to viewBox.
   * Returns 0 when dimensions cannot be determined (CSS max-width:100% handles it).
   */
  function getSvgIntrinsicWidth(markup: string): number {
    const wMatch = markup.match(/\bwidth="([^"]+)"/);
    const w = wMatch ? wMatch[1] : null;
    if (w && w !== '100%' && w !== 'auto') {
      const n = parseFloat(w);
      if (n > 0) return n;
    }
    // Fall back to viewBox third value (width).
    const vbMatch = markup.match(/\bviewBox="([^"]+)"/);
    if (vbMatch) {
      const parts = vbMatch[1].split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0) return parts[2];
    }
    return 0;
  }

  // ── Timer cleanup ────────────────────────────────────────────────────────
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => {
    clearTimeout(copyTimer);
  });

  // ── Control strip handlers ───────────────────────────────────────────────
  function zoomIn() {
    inlineScale = Math.min(INLINE_ZOOM_MAX, inlineScale + INLINE_ZOOM_STEP);
  }

  function zoomOut() {
    inlineScale = Math.max(INLINE_ZOOM_MIN, inlineScale - INLINE_ZOOM_STEP);
  }

  function fitToWidth() {
    inlineScale = 1.0;
  }

  async function copyPng() {
    if (!containerEl) return;
    const ok = await copyDiagramAsPng(containerEl);
    if (ok) {
      copyFeedback = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyFeedback = false; }, 1500);
    } else {
      toast.show('Could not copy diagram as PNG.');
    }
  }

  function expand() {
    onExpand?.({ svg, source, blockId });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="mermaid-container"
  onmouseenter={() => hovering = true}
  onmouseleave={() => hovering = false}
  onfocusin={() => focused = true}
  onfocusout={() => focused = false}
>
  <!-- SVG presenter: intrinsic size, fit-to-width, no upscale -->
  <div
    class="mc-presenter"
    bind:this={containerEl}
    style="transform: scale({inlineScale}); transform-origin: top left; width: calc(100% / {inlineScale});"
  >
    {@html svg}
  </div>

  <!-- Hover/focus control strip -->
  <div class="mc-strip" class:visible={hovering || focused} role="toolbar" aria-label="Diagram controls">
    <button
      class="mc-btn"
      title="Zoom out"
      onclick={zoomOut}
      tabindex="0"
      aria-label="Zoom out"
      disabled={inlineScale <= INLINE_ZOOM_MIN}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5"/>
        <path d="M10.5 10.5 14 14"/>
        <path d="M5 7h4"/>
      </svg>
    </button>
    <button
      class="mc-btn"
      title="Zoom in"
      onclick={zoomIn}
      tabindex="0"
      aria-label="Zoom in"
      disabled={inlineScale >= INLINE_ZOOM_MAX}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5"/>
        <path d="M10.5 10.5 14 14"/>
        <path d="M5 7h4M7 5v4"/>
      </svg>
    </button>
    <button
      class="mc-btn"
      title="Fit to width"
      onclick={fitToWidth}
      tabindex="0"
      aria-label="Fit diagram to column width"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M2 2l4 4M14 2l-4 4M2 14l4-4M14 14l-4-4"/>
        <rect x="5" y="5" width="6" height="6" rx="1"/>
      </svg>
    </button>
    <button
      class="mc-btn"
      class:mc-btn-ok={copyFeedback}
      title="Copy as PNG"
      onclick={copyPng}
      tabindex="0"
      aria-label="Copy diagram as PNG"
    >
      {#if copyFeedback}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M3 8l3 3 7-7"/>
        </svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="4" y="4" width="10" height="10" rx="2"/>
          <path d="M2 12V2h10"/>
        </svg>
      {/if}
    </button>
    {#if onExpand}
      <button
        class="mc-btn"
        title="Expand in lightbox"
        onclick={expand}
        tabindex="0"
        aria-label="Expand diagram in lightbox"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M4 1H1v3M12 1h3v3M4 15H1v-3M12 15h3v-3"/>
        </svg>
      </button>
    {/if}
  </div>
</div>

<style>
  .mermaid-container {
    position: relative;
    border: 1px solid transparent;
    border-radius: var(--r-md, 8px);
    transition: border-color 0.2s;
    margin: 16px 0;
    overflow: hidden;
  }
  .mermaid-container:hover {
    border-color: var(--border, rgba(255,255,255,0.1));
  }

  /* SVG presenter: intrinsic size via CSS, no fixed height, no overflow clipping */
  .mc-presenter {
    display: block;
    /* SVG inside will use max-width:100%;height:auto from markdown.css */
  }

  /* Control strip — fades in on hover/focus */
  .mc-strip {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  .mc-strip.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .mc-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: color-mix(in srgb, var(--surface-2, #2a2a3c) 90%, transparent);
    border: 1px solid var(--border, rgba(255,255,255,0.12));
    border-radius: 6px;
    color: var(--text-muted, #999);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
    transition: color 0.15s, background 0.15s;
  }
  .mc-btn:hover:not(:disabled) {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }
  .mc-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .mc-btn-ok {
    color: #4ade80;
  }
</style>
