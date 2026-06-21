<script lang="ts">
  /**
   * MermaidLightbox.svelte — full-screen diagram viewer rendered top-layer
   * via native dialog.showModal().
   *
   * Props:
   *   svg      — pre-sanitized SVG string (from renderMermaid -> DOMPurify pipeline).
   *              Injected once via {@html svg}. Never re-sanitized, never re-run
   *              through Mermaid, never harvested from the DOM.
   *   source   — original Mermaid source (for reference / future copy).
   *   blockId  — ID of the originating block.
   *   open     — controls dialog open/close.
   *   onClose  — called when the dialog should close.
   *
   * Interaction: full pan/zoom/drag/cursor-anchored-zoom using diagramTransform.ts.
   * Uses native dialog top-layer so it escapes the CSS-scaled .prose ancestor.
   */
  import {
    type DiagramTransform,
    IDENTITY,
    zoomAtPoint,
    pan,
    fitToView,
    PAN_STEP,
  } from './diagramTransform';
  import { copyDiagramAsPng } from './diagramCopy';
  import { toast } from './stores/toast';

  interface Props {
    svg: string;
    source: string;
    blockId: string;
    open: boolean;
    onClose: () => void;
  }

  let { svg, source, blockId, open, onClose }: Props = $props();

  let dialog: HTMLDialogElement | undefined = $state(undefined);
  let viewportEl: HTMLDivElement | undefined = $state(undefined);
  let canvasEl: HTMLDivElement | undefined = $state(undefined);

  let transform: DiagramTransform = $state({ ...IDENTITY });

  // Dragging state
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;

  let copyFeedback = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let fitRaf: number = 0;

  // Open / close the native dialog when `open` prop changes
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Fit diagram to viewport after opening
      fitRaf = requestAnimationFrame(() => {
        fit();
      });
    } else if (!open && dialog.open) {
      dialog.close();
      transform = { ...IDENTITY };
    }
  });

  // Teardown timers/rAFs on destroy
  $effect(() => () => {
    cancelAnimationFrame(fitRaf);
    clearTimeout(copyTimer);
  });

  // ── Pan/zoom handlers ────────────────────────────────────────────────────

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

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = viewportEl?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    transform = zoomAtPoint(transform, e.deltaY < 0 ? 1 : -1, cx, cy);
  }

  // ── Button handlers ──────────────────────────────────────────────────────

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
    const svgEl = canvasEl.querySelector('svg');
    if (!svgEl) { transform = { ...IDENTITY }; return; }
    const vp = viewportEl.getBoundingClientRect();
    const svgW = svgEl.width?.baseVal?.value || svgEl.getBoundingClientRect().width || 400;
    const svgH = svgEl.height?.baseVal?.value || svgEl.getBoundingClientRect().height || 300;
    transform = fitToView(svgW, svgH, vp.width, vp.height);
  }

  async function copyPng() {
    if (!canvasEl) return;
    const ok = await copyDiagramAsPng(canvasEl);
    if (ok) {
      copyFeedback = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copyFeedback = false; }, 1500);
    } else {
      toast.show('Could not copy diagram as PNG.');
    }
  }

  // ── Dialog cancel (Esc key) and backdrop click ───────────────────────────

  function handleCancel(e: Event) {
    e.preventDefault();
    onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    // The backdrop click fires on the dialog element itself
    if (e.target === dialog) {
      onClose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<dialog
  bind:this={dialog}
  class="lb-dialog"
  aria-label="Diagram lightbox"
  oncancel={handleCancel}
  onclick={handleBackdropClick}
>
  <div class="lb-toolbar">
    <button class="lb-btn" title="Zoom out" onclick={zoomOut} aria-label="Zoom out">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5"/>
        <path d="M10.5 10.5 14 14"/>
        <path d="M5 7h4"/>
      </svg>
    </button>
    <button class="lb-btn" title="Zoom in" onclick={zoomIn} aria-label="Zoom in">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5"/>
        <path d="M10.5 10.5 14 14"/>
        <path d="M5 7h4M7 5v4"/>
      </svg>
    </button>
    <button class="lb-btn" title="Fit to view" onclick={fit} aria-label="Fit diagram to view">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M2 2l4 4M14 2l-4 4M2 14l4-4M14 14l-4-4"/>
        <rect x="5" y="5" width="6" height="6" rx="1"/>
      </svg>
    </button>
    <button
      class="lb-btn"
      class:lb-btn-ok={copyFeedback}
      title="Copy as PNG"
      onclick={copyPng}
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
    <div class="lb-spacer"></div>
    <button class="lb-btn lb-close" title="Close (Esc)" onclick={onClose} aria-label="Close lightbox">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18"/>
      </svg>
    </button>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="lb-viewport"
    bind:this={viewportEl}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
    style="cursor: {dragging ? 'grabbing' : 'grab'};"
  >
    <div
      class="lb-canvas"
      bind:this={canvasEl}
      style="transform: translate({transform.panX}px, {transform.panY}px) scale({transform.scale}); transform-origin: 0 0;"
    >
      {@html svg}
    </div>
  </div>
</dialog>

<style>
  .lb-dialog {
    margin: auto;
    width: 92vw;
    height: 88vh;
    max-width: 92vw;
    max-height: 88vh;
    background: var(--surface, #1a1a2e);
    color: var(--text, #eee);
    border: 1px solid var(--border, rgba(255,255,255,0.12));
    border-radius: var(--r-xl, 12px);
    box-shadow: var(--shadow-lg, 0 24px 48px rgba(0,0,0,0.5));
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .lb-dialog[open] {
    display: flex;
    animation: lb-in var(--dur-slow, 180ms) var(--ease-out, ease-out);
  }

  .lb-dialog::backdrop {
    background: color-mix(in srgb, var(--bg, #0e0e1a) 35%, rgba(0,0,0,.55));
    backdrop-filter: blur(3px);
  }

  @keyframes lb-in {
    from { opacity: 0; transform: scale(.96); }
    to   { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .lb-dialog[open] { animation: none; }
  }

  .lb-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
    flex-shrink: 0;
  }

  .lb-spacer { flex: 1; }

  .lb-viewport {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  .lb-canvas {
    position: absolute;
    top: 0;
    left: 0;
    will-change: transform;
  }

  .lb-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border, rgba(255,255,255,0.12));
    border-radius: 6px;
    color: var(--text-muted, #999);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, background 0.15s;
  }

  .lb-btn:hover {
    color: var(--text, #eee);
    background: var(--surface-2, #2a2a3c);
  }

  .lb-btn-ok {
    color: #4ade80;
  }

  .lb-close {
    width: 32px;
    height: 32px;
  }
</style>
