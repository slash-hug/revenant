<script lang="ts">
  /**
   * AnnotationSeals.svelte — Absolutely-positioned seal overlay for the preview pane.
   *
   * Rendered as a Svelte component (NOT {@html}), so DOMPurify is bypassed by
   * construction. The seals live outside the sanitized content DOM entirely.
   *
   * Decisions implemented:
   *  - D3: Mounted as first child of .pv-scroll (position: relative ancestor).
   *  - D6: Block-level full-block tint driven by [data-block-id] attribute selector
   *        via a dynamic inline style rule — never adds a class to sanitized content.
   *  - D7: block_level annotations resolve target block by quoted_text text-search;
   *        seal stacking keyed off the resolved DOM block, not stored line.
   *  - D8: Anchored annotations matched via data-source-line === line_start + 1.
   *  - TRAP 2: Recompute triggered after async hydration (called from PreviewPane).
   *  - TRAP 3: ink-bloom @keyframes pulse has an explicit prefers-reduced-motion block.
   */
  import { onDestroy } from 'svelte';
  import { annotationsStore } from './stores/annotations';
  import type { Annotation } from './types/ipc';
  import {
    annotationFocus,
    focusAnnotation,
    hoverAnnotation,
  } from './stores/annotationFocus';
  import { resolveBlock } from './annotationResolve';

  /**
   * The scroll container element (.pv-scroll) — passed from PreviewPane.
   * Seals are positioned relative to this container.
   */
  export let scrollContainer: HTMLElement | null = null;

  /**
   * The preview content element (.preview-content / previewEl) — used to
   * query block elements for seal resolution.
   */
  export let previewEl: HTMLElement | null = null;

  const SEAL_HEIGHT = 22; // px — height of each seal circle
  const SEAL_STACK_GAP = 2; // px — gap between stacked seals on the same block
  const SEAL_LEFT_OFFSET = -32; // px — seal left edge relative to .pv-scroll left

  // ── Seal resolution ─────────────────────────────────────────────────────────

  interface SealEntry {
    annotation: Annotation;
    top: number; // px offset from .pv-scroll top
    blockEl: Element;
  }

  let seals: SealEntry[] = [];

  /**
   * Recompute seal positions.
   * Called from PreviewPane: (a) at end of hydrateDynamicBlocks, (b) on ResizeObserver.
   */
  export function recompute() {
    if (!scrollContainer || !previewEl) {
      seals = [];
      return;
    }

    const state = $annotationsStore;
    // Suppress while loading to avoid stale flicker.
    if (state.loading) {
      seals = [];
      return;
    }

    // Only anchored and block_level (same filter as drawer activeAnnotations).
    const active = state.annotations.filter(
      (a) => a.status === 'anchored' || a.status === 'block_level',
    );

    const scrollContainerRect = scrollContainer.getBoundingClientRect();
    const scrollTop = scrollContainer.scrollTop;

    // Track resolved blocks and how many seals each block already has (for stacking).
    const blockSealCount = new Map<Element, number>();
    const newSeals: SealEntry[] = [];

    for (const ann of active) {
      const blockEl = resolveBlockForSeal(ann);
      if (!blockEl) {
        if (import.meta.env.DEV) {
          console.warn(
            `[AnnotationSeals] Could not resolve block for annotation ${ann.id} (status: ${ann.status}, line_start: ${ann.line_start}, quoted: "${ann.quoted_text?.slice(0, 40)}")`,
          );
        }
        continue;
      }

      // offsetTop of block relative to the scroll container.
      const blockRect = blockEl.getBoundingClientRect();
      const relativeTop =
        blockRect.top - scrollContainerRect.top + scrollTop;

      // Stack multiple seals on the same block.
      const stackIdx = blockSealCount.get(blockEl) ?? 0;
      blockSealCount.set(blockEl, stackIdx + 1);

      newSeals.push({
        annotation: ann,
        top: relativeTop + stackIdx * (SEAL_HEIGHT + SEAL_STACK_GAP),
        blockEl,
      });
    }

    seals = newSeals;
  }

  /**
   * Resolve the DOM block element for an annotation.
   * Delegates to the shared resolveBlock helper (annotationResolve.ts) so
   * AnnotationSeals and PreviewPane cannot drift from each other.
   */
  function resolveBlockForSeal(ann: Annotation): Element | null {
    if (!previewEl) return null;
    return resolveBlock(ann, previewEl);
  }

  // ── Active block tint (D6) ──────────────────────────────────────────────
  //
  // Instead of injecting a string-interpolated style block (which would
  // bypass Svelte escaping and become an XSS/CSS-injection vector if
  // data-block-id ever carries document content), we apply the tint as an
  // inline CSS custom property directly on the resolved block element.
  // Svelte handles the reactive remove/re-apply; no user-controlled string
  // ever touches a CSS rule.

  let prevTintEl: HTMLElement | null = null;

  $: {
    // Remove tint from the previous block.
    if (prevTintEl) {
      prevTintEl.style.removeProperty('--block-tint');
      prevTintEl.style.removeProperty('border-radius');
      prevTintEl = null;
    }

    const activeId = $annotationFocus.activeId;
    if (activeId) {
      const entry = seals.find((s) => s.annotation.id === activeId);
      if (entry) {
        const el = entry.blockEl as HTMLElement;
        el.style.setProperty('--block-tint', 'color-mix(in srgb, var(--seal-ink, #4A453B) 8%, transparent)');
        el.style.setProperty('background', 'var(--block-tint)');
        el.style.setProperty('border-radius', '4px');
        prevTintEl = el;
      }
    }
  }

  // ── Seal click/hover handlers ────────────────────────────────────────────

  function handleSealClick(e: MouseEvent, ann: Annotation) {
    e.stopPropagation();
    // Pass the seal element's viewport rect to the focus store so AnnotationPopover
    // can use it for coordinate-driven placement (D4 — portal-mounted at App root).
    const domRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    focusAnnotation(ann.id, {
      x: domRect.right,
      y: domRect.top,
      width: domRect.width,
      height: domRect.height,
      bottom: domRect.bottom,
    });
  }

  function handleSealMouseEnter(ann: Annotation) {
    hoverAnnotation(ann.id);
  }

  function handleSealMouseLeave() {
    hoverAnnotation(null);
  }

  onDestroy(() => {
    // Clean up any lingering tint on unmount.
    if (prevTintEl) {
      prevTintEl.style.removeProperty('--block-tint');
      prevTintEl.style.removeProperty('background');
      prevTintEl.style.removeProperty('border-radius');
      prevTintEl = null;
    }
    seals = [];
  });
</script>

<!-- Seal markers — absolutely positioned relative to .pv-scroll -->
<!-- Block tint (D6) is applied via a direct inline style on the resolved block
     element in the reactive block above, so no sanitized-HTML style injection is
     needed and DOMPurify is never involved. -->
<div class="seals-layer" aria-hidden="true">
  {#each seals as entry (entry.annotation.id)}
    {@const isActive = $annotationFocus.activeId === entry.annotation.id}
    {@const isHover = $annotationFocus.hoverId === entry.annotation.id}
    <button
      class="seal"
      class:seal--active={isActive}
      class:seal--hover={isHover}
      type="button"
      tabindex="-1"
      title={entry.annotation.quoted_text
        ? `"${entry.annotation.quoted_text.slice(0, 60)}${entry.annotation.quoted_text.length > 60 ? '…' : ''}"`
        : entry.annotation.body.slice(0, 80)}
      style="top: {entry.top}px; left: {SEAL_LEFT_OFFSET}px;"
      on:click={(e) => handleSealClick(e, entry.annotation)}
      on:mouseenter={() => handleSealMouseEnter(entry.annotation)}
      on:mouseleave={handleSealMouseLeave}
    >
      <!-- Droplet-in-a-ring seal icon -->
      <svg class="seal-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <!-- Outer ring -->
        <circle cx="10" cy="10" r="8.5" stroke="currentColor" stroke-width="1.5" />
        <!-- Inner droplet -->
        <path
          d="M10 5.5 C10 5.5 7 9 7 11.2 A3 3 0 0 0 13 11.2 C13 9 10 5.5 10 5.5Z"
          fill="currentColor"
          opacity="0.85"
        />
      </svg>
    </button>
  {/each}
</div>

<style>
  .seals-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 2;
  }

  .seal {
    position: absolute;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    pointer-events: all;
    border-radius: 50%;
    color: var(--seal-ink, #4A453B);
    opacity: 0.55;
    transition:
      opacity var(--dur-fast, 120ms),
      color var(--dur-fast, 120ms),
      transform var(--dur-fast, 120ms);
  }

  .seal:hover,
  .seal--hover {
    opacity: 0.85;
    transform: scale(1.1);
  }

  .seal--active {
    opacity: 1;
    color: var(--accent, #3D6DA0);
    animation: seal-bloom 600ms var(--ease-out, cubic-bezier(.22,.78,.28,1)) forwards;
  }

  .seal-svg {
    width: 18px;
    height: 18px;
    flex: none;
  }

  /* Ink-bloom pulse (TRAP 3: standalone @keyframes not suppressed by --dur-* tokens,
     so we need an explicit prefers-reduced-motion block here as well as in tokens.css). */
  @keyframes seal-bloom {
    0%   { transform: scale(0.85); opacity: 0.6; }
    40%  { transform: scale(1.2);  opacity: 1; }
    70%  { transform: scale(0.95); opacity: 1; }
    100% { transform: scale(1.0);  opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .seal--active { animation: none; }
    .seal { transition: none; }
  }
</style>
