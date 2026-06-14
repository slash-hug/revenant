<script lang="ts">
  /**
   * AnnotationPopover.svelte — Shared read/delete popover for annotations.
   *
   * Portal-mounted once at App root (position: fixed, z-index: --z-modal).
   * Driven by the active annotation + its anchor viewport rect.
   *
   * Placement rules (D4 / D-RISK-3):
   *  - Default: below the anchor rect (rect.bottom + gap).
   *  - Flip above when rect.bottom + POPOVER_HEIGHT > window.innerHeight.
   *  - Clamp top to toolbarBottom + TOOLBAR_GAP so it never renders under
   *    the toolbar or macOS traffic-lights.
   *  - Left: horizontally aligned to rect.x, clamped to viewport margins.
   *
   * Outside-click: listener deferred by one setTimeout(0) tick so the opening
   * click is not counted (mirror AnnotationComposer). Drawer + seals are
   * whitelisted as non-dismissing so clicking a different seal changes the
   * active annotation without closing the popover first.
   *
   * Delete: immediate + undoable — the button dispatches 'delete'; the parent
   * removes the annotation and shows an Undo toast (UX #11).
   *
   * Events (legacy createEventDispatcher for compatibility with consuming
   * components that use on:delete):
   *  - delete  { id: string }
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import type { Annotation } from './types/ipc';
  import { clearFocus } from './stores/annotationFocus';
  import type { AnchorRect } from './stores/annotationFocus';

  /** The annotation to display. If null, the popover is hidden. */
  export let annotation: Annotation | null = null;

  /** Viewport rect of the seal / gutter marker that opened the popover.
   *  When null the popover positions itself at a default screen location
   *  (drawer-triggered open with no visual anchor). */
  export let anchorRect: AnchorRect | null = null;

  /** Bottom Y of the toolbar (px). Popover must not render above this. */
  export let toolbarBottom: number = 48;

  // ── Layout constants ─────────────────────────────────────────────────────────
  const POPOVER_WIDTH = 300;
  const POPOVER_HEIGHT = 240; // estimated max; actual may be less
  const GAP = 8;              // gap between anchor and popover
  const VIEWPORT_MARGIN = 12;
  const TOOLBAR_GAP = 8;

  // ── State ────────────────────────────────────────────────────────────────────
  let panel: HTMLDivElement;
  let left = 0;
  let top = 0;
  let placement: 'below' | 'above' = 'below';
  let caretLeft = 24; // px from the popover's left edge — points at the span center



  const dispatch = createEventDispatcher<{ delete: { id: string } }>();

  function anchorLabel(ann: Annotation): string {
    const start = ann.line_start + 1;
    const end = ann.line_end + 1;
    if (ann.status === 'block_level') return `block · L${start}`;
    return start === end ? `L${start}` : `L${start}–L${end}`;
  }

  // ── Placement ────────────────────────────────────────────────────────────────

  function computePlacement(): void {
    if (!panel || !annotation) return;

    const panelRect = panel.getBoundingClientRect();
    const actualHeight = panelRect.height || POPOVER_HEIGHT;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minTop = toolbarBottom + TOOLBAR_GAP;

    if (!anchorRect) return; // hidden until a surface measures the span (see render gate)

    // Horizontal: align to anchor left, clamped to viewport margins.
    left = Math.min(
      Math.max(VIEWPORT_MARGIN, anchorRect.x),
      vw - POPOVER_WIDTH - VIEWPORT_MARGIN,
    );

    // Vertical: default below the span, flip above when it would overflow the
    // viewport AND there's room above (clamped below the toolbar either way).
    const belowTop = anchorRect.bottom + GAP;
    const aboveTop = anchorRect.y - actualHeight - GAP;
    if (belowTop + actualHeight > vh && aboveTop >= minTop) {
      placement = 'above';
      top = Math.max(minTop, aboveTop);
    } else {
      placement = 'below';
      top = Math.max(minTop, belowTop);
    }

    // Caret points at the span's horizontal centre, clamped within the popover.
    const anchorCenterX = anchorRect.x + anchorRect.width / 2;
    caretLeft = Math.min(Math.max(14, anchorCenterX - left), POPOVER_WIDTH - 14);
  }

  // ── Keyboard + outside-click dismissal ───────────────────────────────────────

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      clearFocus();
    }
  }

  function handleOutside(e: MouseEvent) {
    const target = e.target as Node;
    if (!panel) return;
    // Whitelist: popover itself, .drawer-pane, .seal (WS-2), .cm-gutter-seal (WS-3).
    if (panel.contains(target)) return;
    const drawer = document.querySelector('.drawer-pane');
    if (drawer?.contains(target)) return;
    // Allow clicks on seal markers (they update focus to a different annotation).
    const sealEl = (target as Element)?.closest?.('.seal');
    if (sealEl) return;
    const gutterSeal = (target as Element)?.closest?.('.cm-gutter-seal');
    if (gutterSeal) return;
    clearFocus();
  }

  let outsideListenerAttached = false;

  function attachOutsideListener() {
    if (outsideListenerAttached) return;
    outsideListenerAttached = true;
    // Defer by one tick so the opening click isn't counted (mirror AnnotationComposer).
    setTimeout(() => window.addEventListener('mousedown', handleOutside), 0);
  }

  function detachOutsideListener() {
    window.removeEventListener('mousedown', handleOutside);
    outsideListenerAttached = false;
  }

  // Delete is immediate + undoable: the button dispatches 'delete' and the parent
  // (App) removes the annotation, shows an Undo toast, and clears focus (UX #11).

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
    detachOutsideListener();
  });

  // Recompute placement whenever the annotation or its anchor rect changes.
  $: if (annotation) {
    // Attach outside-click listener (deferred first time).
    tick().then(() => {
      computePlacement();
      attachOutsideListener();
    });
  } else {
    detachOutsideListener();
  }

  // Re-run placement if anchorRect changes while a popover is open.
  $: if (anchorRect && annotation && panel) {
    tick().then(computePlacement);
  }
</script>

{#if annotation && anchorRect}
  <div
    bind:this={panel}
    class="popover"
    class:placement-above={placement === 'above'}
    style="left: {left}px; top: {top}px; width: {POPOVER_WIDTH}px;"
    role="dialog"
    aria-label="Annotation"
    aria-modal="false"
  >
    <!-- Caret tying the popover to the span it's about. -->
    <span class="pop-caret" style="left: {caretLeft}px;" aria-hidden="true"></span>
    <!-- Header: line chip + status badge + delete action -->
    <div class="pop-top">
      <span class="chip">{anchorLabel(annotation)}</span>
      {#if annotation.status === 'block_level'}
        <span class="badge badge-neutral">Block</span>
      {:else}
        <span class="badge badge-open">Anchored</span>
      {/if}
      <span class="spacer"></span>
      <button
        class="pop-icon pop-del"
        type="button"
        on:click={() => dispatch('delete', { id: annotation!.id })}
        aria-label="Delete annotation"
        title="Delete"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
        </svg>
      </button>
    </div>

    <!-- Quoted snippet (italic Literata, ink-left-border) -->
    {#if annotation.quoted_text}
      <blockquote class="pop-snippet">{annotation.quoted_text}</blockquote>
    {/if}

    <!-- Comment body (read-only; editing lives in the drawer — single source). -->
    <p class="pop-body">{annotation.body}</p>
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    z-index: var(--z-modal);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    animation: pop-in var(--dur-fast) var(--ease-out);
    max-width: calc(100vw - 24px);
  }
  @keyframes pop-in {
    from { opacity: 0; transform: translateY(4px) scale(.99); }
    to   { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) { .popover { animation: none; } }

  /* Caret tying the popover to the span. Sits on the top edge by default,
     flips to the bottom edge when the popover opens above the span. */
  .pop-caret {
    position: absolute;
    top: -7px;
    width: 12px;
    height: 12px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    border-top: 1px solid var(--border);
    transform: translateX(-50%) rotate(45deg);
  }
  .placement-above .pop-caret {
    top: auto;
    bottom: -7px;
    border-left: none;
    border-top: none;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  .pop-top { display: flex; align-items: center; gap: var(--sp-2); }
  .spacer { flex: 1; }

  .chip {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    color: var(--accent-text);
    background: var(--accent-soft);
    border-radius: var(--r-sm);
    padding: 2px 7px;
    letter-spacing: .01em;
    white-space: nowrap;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    padding: 2px 8px;
    border-radius: var(--r-pill);
    letter-spacing: .01em;
    white-space: nowrap;
  }
  .badge-open    { color: var(--success-text); background: var(--success-soft); }
  .badge-neutral { color: var(--text-muted);   background: var(--surface-2); }

  .pop-icon {
    color: var(--text-faint);
    display: inline-flex;
    padding: 3px;
    border-radius: var(--r-xs);
    border: none;
    background: transparent;
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
    flex: none;
  }
  .pop-icon svg { width: 14px; height: 14px; }
  .pop-icon:hover { color: var(--text); background: var(--surface-2); }
  .pop-del:hover { color: var(--danger-text); background: var(--danger-soft); }

  .pop-snippet {
    margin: 0;
    font-family: var(--font-prose);
    font-size: 13px;
    line-height: var(--lh-snug);
    color: var(--seal-ink);
    border-left: 2px solid var(--seal-ink);
    padding-left: 10px;
    font-style: italic;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .pop-body {
    margin: 0;
    font-size: 13px;
    line-height: var(--lh-snug);
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
