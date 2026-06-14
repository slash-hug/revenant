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
   *        via a dynamic <style> tag — never adds a class to sanitized content.
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
      const blockEl = resolveBlock(ann);
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
   *
   * anchored: match data-source-line === line_start + 1 (D8 off-by-one).
   * block_level: text-search quoted_text across rendered blocks (D7).
   *
   * Returns null if not found (detached annotations are filtered upstream).
   */
  function resolveBlock(ann: Annotation): Element | null {
    if (!previewEl) return null;

    if (ann.status === 'anchored') {
      // D8: data-source-line is 1-based; line_start is 0-based.
      const targetLine = ann.line_start + 1;
      const blocks = Array.from(
        previewEl.querySelectorAll<HTMLElement>('[data-source-line]'),
      );
      // Find exact match first.
      const exact = blocks.find(
        (el) => parseInt(el.dataset.sourceLine ?? '0', 10) === targetLine,
      );
      if (exact) return exact;

      // Nearest fallback (same logic as syncScrollToLine).
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      for (const el of blocks) {
        const dist = Math.abs(parseInt(el.dataset.sourceLine ?? '0', 10) - targetLine);
        if (dist < bestDist) {
          bestDist = dist;
          best = el;
        }
      }
      return best;
    }

    if (ann.status === 'block_level') {
      // D7: resolve by text-search of quoted_text across rendered blocks.
      if (!ann.quoted_text) return null;
      const blocks = Array.from(
        previewEl.querySelectorAll<HTMLElement>('[data-block-id]'),
      );
      for (const el of blocks) {
        if ((el.textContent ?? '').includes(ann.quoted_text)) {
          return el;
        }
      }
      return null;
    }

    return null;
  }

  // ── Active block id for tint (D6) ────────────────────────────────────────

  $: activeBlockId = (() => {
    const activeId = $annotationFocus.activeId;
    if (!activeId) return null;
    const entry = seals.find((s) => s.annotation.id === activeId);
    return entry ? (entry.blockEl as HTMLElement).dataset.blockId ?? null : null;
  })();

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
    seals = [];
  });
</script>

<!-- Dynamic style for block-level full-block tint (D6).
     We inject a single rule targeting [data-block-id] — never add a class to
     sanitized content. The attribute is already present in DOMPurify-safe output. -->
{#if activeBlockId}
  <style>
    :global([data-block-id]) {
      /* reset any prior tint */
    }
  </style>
  <!-- svelte-ignore css-unused-selector -->
  {@html `<style>.preview-content [data-block-id="${activeBlockId}"] { background: color-mix(in srgb, var(--seal-ink, #4A453B) 8%, transparent); border-radius: 4px; }</style>`}
{/if}

<!-- Seal markers — absolutely positioned relative to .pv-scroll -->
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
