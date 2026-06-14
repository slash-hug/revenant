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
  import { buildRange } from './annotationHighlight';

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
  const SEAL_GUTTER = 30; // px — how far left of the text the seal sits (within the prose left padding)
  const SEAL_MIN_LEFT = 4; // px — never let the seal escape the left edge of .pv-scroll

  // ── Seal resolution ─────────────────────────────────────────────────────────

  interface SealEntry {
    annotation: Annotation;
    top: number; // px offset from .pv-scroll top
    left: number; // px offset from .pv-scroll left (in the prose gutter, beside the text)
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
    const scrollLeft = scrollContainer.scrollLeft;

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

      // Position relative to the scroll container, in the block's own gutter
      // (just left of the text), so the seal sits inside the prose left padding
      // and scrolls with the content — not pinned to the container edge.
      const blockRect = blockEl.getBoundingClientRect();
      const relativeTop = blockRect.top - scrollContainerRect.top + scrollTop;
      const blockLeft = blockRect.left - scrollContainerRect.left + scrollLeft;
      const left = Math.max(SEAL_MIN_LEFT, blockLeft - SEAL_GUTTER);

      // Stack multiple seals on the same block.
      const stackIdx = blockSealCount.get(blockEl) ?? 0;
      blockSealCount.set(blockEl, stackIdx + 1);

      newSeals.push({
        annotation: ann,
        top: relativeTop + stackIdx * (SEAL_HEIGHT + SEAL_STACK_GAP),
        left,
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
      prevTintEl.style.removeProperty('background');
      prevTintEl.style.removeProperty('border-radius');
      prevTintEl = null;
    }

    const activeId = $annotationFocus.activeId;
    if (activeId) {
      const entry = seals.find((s) => s.annotation.id === activeId);
      // Block-level annotations have no inline text span to wash, so THEY get the
      // soft full-block tint. Anchored annotations get the inline ink wash
      // (CSS Custom Highlight API) instead — never the block tint (D6).
      if (entry && entry.annotation.status === 'block_level') {
        const el = entry.blockEl as HTMLElement;
        el.style.setProperty('background', 'color-mix(in srgb, var(--seal-ink, #4A453B) 8%, transparent)');
        el.style.setProperty('border-radius', '4px');
        prevTintEl = el;
      }
    }
  }

  // ── Inline ink wash (bottom-weighted brush, behind the text) ─────────────────
  //
  // The CSS Custom Highlight API can't paint a gradient, so the brush stroke is
  // drawn as gradient rects positioned over the quoted span's client rects, in a
  // layer BEHIND the prose (see .wash-layer z-index + .prose z-index in
  // PreviewPane). Only the active (full) and hovered (faint) spans are painted —
  // clean prose at rest. Recomputed reactively whenever focus or seal layout
  // changes (same coordinate basis as the seals, so it scrolls with content).

  interface WashRect { left: number; top: number; width: number; height: number; active: boolean; }

  function rectsForAnnotation(id: string | null, active: boolean, sealList: SealEntry[]): WashRect[] {
    if (!id || !scrollContainer) return [];
    const entry = sealList.find((s) => s.annotation.id === id);
    // block-level annotations use the full-block tint, not an inline wash.
    if (!entry || entry.annotation.status === 'block_level' || !entry.annotation.quoted_text) return [];
    const range = buildRange(entry.blockEl, entry.annotation.quoted_text);
    if (!range) return [];
    const cRect = scrollContainer.getBoundingClientRect();
    const sTop = scrollContainer.scrollTop;
    const sLeft = scrollContainer.scrollLeft;
    return Array.from(range.getClientRects()).map((r) => ({
      left: r.left - cRect.left + sLeft,
      top: r.top - cRect.top + sTop,
      width: r.width,
      height: r.height,
      active,
    }));
  }

  // Recompute on focus change AND when seals re-layout (recompute() reassigns `seals`).
  function buildWashRects(
    focus: { activeId: string | null; hoverId: string | null },
    sealList: SealEntry[],
  ): WashRect[] {
    const hoverId = focus.hoverId && focus.hoverId !== focus.activeId ? focus.hoverId : null;
    return [
      ...rectsForAnnotation(hoverId, false, sealList),
      ...rectsForAnnotation(focus.activeId, true, sealList),
    ];
  }
  $: washRects = buildWashRects($annotationFocus, seals);

  // ── Seal click/hover handlers ────────────────────────────────────────────

  function handleSealClick(e: MouseEvent, ann: Annotation) {
    e.stopPropagation();
    // Just set focus — PreviewPane measures the real span/block rect and sets the
    // popover anchor (so the popover sits under the WORDS, not the gutter seal).
    focusAnnotation(ann.id);
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

<!-- Ink brush underline — one SVG stroke per line-fragment of the span, drawn just
     below the words in the layer behind the prose. A hand-inked, tapered stroke
     (not a box); active = full, hover = faint. -->
<div class="wash-layer" aria-hidden="true">
  {#each washRects as w (w.left + ':' + w.top + ':' + w.active)}
    <svg
      class="brush"
      class:brush--active={w.active}
      style="left: {w.left}px; top: {w.top + w.height - 5}px; width: {w.width}px;"
      viewBox="0 0 110 11"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M2 6 C 22 2, 46 2.4, 60 4 C 78 6, 92 5, 108 4.2 C 92 8.4, 60 9.2, 36 8 C 20 7.2, 8 7.6, 2 6 Z" />
    </svg>
  {/each}
</div>

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
      style="top: {entry.top}px; left: {entry.left}px;"
      on:click={(e) => handleSealClick(e, entry.annotation)}
      on:mouseenter={() => handleSealMouseEnter(entry.annotation)}
      on:mouseleave={handleSealMouseLeave}
    >
      <!-- Droplet-in-a-ring seal icon. At rest: ink ring + ink droplet on a
           transparent field. Active: the field fills with ink and the droplet
           inverts to the surface color (see CSS). -->
      <svg class="seal-svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle class="seal-fill" cx="10" cy="10" r="9" />
        <circle class="seal-ring" cx="10" cy="10" r="8.5" stroke-width="1.5" fill="none" />
        <path
          class="seal-drop"
          d="M10 5.5 C10 5.5 7 9 7 11.2 A3 3 0 0 0 13 11.2 C13 9 10 5.5 10 5.5Z"
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

  /* Wash sits BEHIND the prose text (PreviewPane gives .prose z-index: 1). */
  .wash-layer {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 0;
  }
  .brush {
    position: absolute;
    height: 10px;
    pointer-events: none;
    overflow: visible;
  }
  .brush path { fill: var(--ann-underline, #3C8893); opacity: 0.42; } /* hover */
  .brush--active path { opacity: 0.92; }                              /* active */

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
    transition: transform var(--dur-fast, 120ms);
  }

  .seal-svg { width: 18px; height: 18px; flex: none; overflow: visible; }

  /* Resting: ink ring + ink droplet, no fill. */
  .seal-fill { fill: transparent; transition: fill var(--dur-fast, 120ms); }
  .seal-ring { stroke: var(--seal-ink, #4A453B); opacity: 0.7; transition: opacity var(--dur-fast, 120ms); }
  .seal-drop { fill: var(--seal-ink, #4A453B); opacity: 0.78; transition: fill var(--dur-fast, 120ms), opacity var(--dur-fast, 120ms); }

  /* Hover: darken toward full ink + a small lift. */
  .seal:hover,
  .seal--hover { transform: scale(1.08); }
  .seal:hover .seal-ring,
  .seal--hover .seal-ring { opacity: 1; }
  .seal:hover .seal-drop,
  .seal--hover .seal-drop { opacity: 1; }

  /* Active: the field fills with ink, the droplet inverts to the surface color,
     and a soft halo blooms around the seal. */
  .seal--active .seal-fill { fill: var(--seal-ink, #4A453B); }
  .seal--active .seal-ring { stroke: var(--seal-ink, #4A453B); opacity: 1; }
  .seal--active .seal-drop { fill: var(--seal-on, #FFFFFF); opacity: 1; }
  .seal--active {
    animation: seal-bloom 600ms var(--ease-out, cubic-bezier(.22,.78,.28,1));
    border-radius: 50%;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--seal-ink, #4A453B) 22%, transparent);
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
