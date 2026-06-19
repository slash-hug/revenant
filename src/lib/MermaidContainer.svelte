<script lang="ts">
  /**
   * MermaidContainer.svelte — interactive wrapper for rendered Mermaid diagrams.
   *
   * Wraps a sanitized SVG in a pan/zoom viewport with GitHub-style overlay
   * controls that appear on hover. Uses CSS transforms for pan/zoom, which
   * composes cleanly with the global preview zoom on .prose.
   *
   * Mounted imperatively by PreviewPane after Mermaid hydration via
   * `new MermaidContainer({ target, props })`.
   */
  import {
    type DiagramTransform,
    IDENTITY,
    zoomAtPoint,
    pan,
    fitToView,
    PAN_STEP,
    clampScale,
    ZOOM_FACTOR,
  } from './diagramTransform';
  import { copyDiagramAsPng } from './diagramCopy';
  import { openDiagramWindow } from './types/ipc';

  interface Props {
    svg: string;
    source: string;
    blockId: string;
  }

  let { svg, source, blockId }: Props = $props();

  let transform: DiagramTransform = $state({ ...IDENTITY });
  let expanded = $state(false);
  let hovering = $state(false);
  let copyFeedback = $state(false);

  let viewportEl: HTMLDivElement | undefined = $state(undefined);
  let canvasEl: HTMLDivElement | undefined = $state(undefined);
  let viewportHeight: string = $state('300px');

  // Auto-fit diagram to viewport on mount (once elements are bound and SVG is rendered)
  let hasFittedOnMount = false;
  let fitRaf = 0;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (viewportEl && canvasEl && !hasFittedOnMount) {
      // Wait a frame for the SVG to render and have dimensions
      fitRaf = requestAnimationFrame(() => {
        computeViewportHeight();
        fit();
        hasFittedOnMount = true;
      });
    }
  });

  // Clear any pending timer/rAF on teardown — PreviewPane unmounts these
  // containers frequently, so a pending callback could fire after destroy.
  $effect(() => () => {
    cancelAnimationFrame(fitRaf);
    clearTimeout(copyTimer);
  });

  /** Set viewport height based on SVG aspect ratio at available width, capped at 70vh. */
  function computeViewportHeight() {
    if (!viewportEl || !canvasEl) return;
    const svgEl = canvasEl.querySelector('svg');
    if (!svgEl) return;
    const svgW = svgEl.width?.baseVal?.value || svgEl.getBoundingClientRect().width || 400;
    const svgH = svgEl.height?.baseVal?.value || svgEl.getBoundingClientRect().height || 300;
    const vpW = viewportEl.getBoundingClientRect().width;
    // Scale to fit width, then compute resulting height
    const fitScale = Math.min(2.0, vpW / svgW);
    const idealH = svgH * fitScale;
    // Clamp between 150px and 70vh
    const maxH = window.innerHeight * 0.7;
    const h = Math.max(150, Math.min(idealH + 32, maxH));
    viewportHeight = `${h}px`;
  }

  // ── Dragging state ──────────────────────────────────────────────────────
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = transform.panX;
    dragStartPanY = transform.panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    transform = { ...transform, panX: dragStartPanX + dx, panY: dragStartPanY + dy };
  }

  function onPointerUp() {
    dragging = false;
  }

  // ── Scroll: pan or zoom ─────────────────────────────────────────────────
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = viewportEl?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      transform = zoomAtPoint(transform, e.deltaY < 0 ? 1 : -1, cx, cy);
    } else {
      transform = pan(transform, -e.deltaX, -e.deltaY);
    }
  }

  // ── Button handlers ─────────────────────────────────────────────────────
  function panUp()    { transform = pan(transform, 0, PAN_STEP); }
  function panDown()  { transform = pan(transform, 0, -PAN_STEP); }
  function panLeft()  { transform = pan(transform, PAN_STEP, 0); }
  function panRight() { transform = pan(transform, -PAN_STEP, 0); }

  function zoomIn() {
    const vp = viewportEl?.getBoundingClientRect();
    if (!vp) return;
    transform = zoomAtPoint(transform, 1, vp.width / 2, vp.height / 2);
  }

  function zoomOut() {
    const vp = viewportEl?.getBoundingClientRect();
    if (!vp) return;
    transform = zoomAtPoint(transform, -1, vp.width / 2, vp.height / 2);
  }

  function fit() {
    if (!viewportEl || !canvasEl) return;
    const svg = canvasEl.querySelector('svg');
    if (!svg) { transform = { ...IDENTITY }; return; }
    const vp = viewportEl.getBoundingClientRect();
    const svgW = svg.width?.baseVal?.value || svg.getBoundingClientRect().width || 400;
    const svgH = svg.height?.baseVal?.value || svg.getBoundingClientRect().height || 300;
    transform = fitToView(svgW, svgH, vp.width, vp.height);
  }

  function toggleExpand() {
    expanded = !expanded;
  }

  async function copyPng() {
    if (!canvasEl) return;
    const ok = await copyDiagramAsPng(canvasEl);
    if (ok) {
      copyFeedback = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyFeedback = false; }, 1500);
    }
  }

  async function popout() {
    try {
      const nearestHeading = viewportEl
        ?.closest('.prose')
        ?.querySelector('h1, h2, h3')
        ?.textContent ?? '';
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      await openDiagramWindow(svg, nearestHeading || 'Untitled', theme);
    } catch (err) {
      console.warn('Failed to open diagram window:', err);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="mermaid-container"
  class:expanded
  onmouseenter={() => hovering = true}
  onmouseleave={() => hovering = false}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="mc-viewport"
    bind:this={viewportEl}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
    style="cursor: {dragging ? 'grabbing' : 'grab'}; height: {viewportHeight};"
  >
    <div
      class="mc-canvas"
      bind:this={canvasEl}
      style="transform: translate({transform.panX}px, {transform.panY}px) scale({transform.scale}); transform-origin: 0 0;"
    >
      {@html svg}
    </div>
  </div>

  <!-- Top-right toolbar -->
  <div class="mc-toolbar mc-toolbar-top" class:visible={hovering}>
    <button class="mc-btn" title={expanded ? 'Collapse' : 'Expand full-width'} onclick={toggleExpand}>
      {#if expanded}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 1L1 1 1 5M11 1l4 0 0 4M5 15l-4 0 0-4M11 15l4 0 0-4"/></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1H1v3M12 1h3v3M4 15H1v-3M12 15h3v-3"/></svg>
      {/if}
    </button>
    <button class="mc-btn" class:mc-btn-ok={copyFeedback} title="Copy as PNG" onclick={copyPng}>
      {#if copyFeedback}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l3 3 7-7"/></svg>
      {:else}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="10" height="10" rx="2"/><path d="M2 12V2h10"/></svg>
      {/if}
    </button>
    <button class="mc-btn" title="Open in new window" onclick={popout}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3" width="14" height="11" rx="2"/><path d="M1 6h14"/></svg>
    </button>
  </div>

  <!-- Bottom-right toolbar: pan + zoom -->
  <div class="mc-toolbar mc-toolbar-bottom" class:visible={hovering}>
    <div class="mc-nav-grid">
      <button class="mc-btn mc-nav-up" title="Pan up" onclick={panUp}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3l5 6H3z"/></svg>
      </button>
      <button class="mc-btn mc-nav-zin" title="Zoom in" onclick={zoomIn}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4M7 5v4"/></svg>
      </button>
      <button class="mc-btn mc-nav-left" title="Pan left" onclick={panLeft}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8l6-5v10z"/></svg>
      </button>
      <button class="mc-btn mc-nav-fit" title="Fit to view" onclick={fit}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2l4 4M14 2l-4 4M2 14l4-4M14 14l-4-4"/><rect x="5" y="5" width="6" height="6" rx="1"/></svg>
      </button>
      <button class="mc-btn mc-nav-right" title="Pan right" onclick={panRight}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13 8l-6-5v10z"/></svg>
      </button>
      <button class="mc-btn mc-nav-down" title="Pan down" onclick={panDown}>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M8 13l5-6H3z"/></svg>
      </button>
      <button class="mc-btn mc-nav-zout" title="Zoom out" onclick={zoomOut}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/><path d="M5 7h4"/></svg>
      </button>
    </div>
  </div>

  <!-- Bottom-left hint -->
  <div class="mc-hint" class:visible={hovering}>
    Scroll to pan · Ctrl+scroll to zoom
  </div>
</div>

<style>
  .mermaid-container {
    position: relative;
    border: 1px solid transparent;
    border-radius: var(--r-md, 8px);
    transition: border-color 0.2s;
    margin: 16px 0;
  }
  .mermaid-container:hover {
    border-color: var(--border, rgba(255,255,255,0.1));
  }
  .mermaid-container.expanded {
    width: calc(100% + 2 * var(--prose-padding, 32px));
    margin-left: calc(-1 * var(--prose-padding, 32px));
  }

  .mc-viewport {
    overflow: hidden;
    border-radius: var(--r-md, 8px);
  }
  .mc-canvas {
    will-change: transform;
  }

  /* Toolbar fade */
  .mc-toolbar, .mc-hint {
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
  }
  .mc-toolbar.visible, .mc-hint.visible {
    opacity: 1;
    pointer-events: auto;
  }

  .mc-toolbar-top {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
  }

  .mc-toolbar-bottom {
    position: absolute;
    bottom: 8px;
    right: 8px;
  }

  .mc-nav-grid {
    display: grid;
    grid-template-columns: 28px 28px 28px;
    grid-template-rows: 28px 28px 28px;
    gap: 3px;
    /* Named grid areas for the d-pad + zoom layout */
    grid-template-areas:
      ".    up   zin"
      "left fit  right"
      ".    down zout";
  }
  .mc-nav-up    { grid-area: up; }
  .mc-nav-zin   { grid-area: zin; }
  .mc-nav-left  { grid-area: left; }
  .mc-nav-fit   { grid-area: fit; }
  .mc-nav-right { grid-area: right; }
  .mc-nav-down  { grid-area: down; }
  .mc-nav-zout  { grid-area: zout; }

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
  .mc-btn:hover {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }
  .mc-btn-ok {
    color: #4ade80;
  }

  .mc-hint {
    position: absolute;
    bottom: 8px;
    left: 8px;
    font-size: 11px;
    color: var(--text-faint, rgba(255,255,255,0.35));
    font-family: system-ui, sans-serif;
    user-select: none;
  }
</style>
