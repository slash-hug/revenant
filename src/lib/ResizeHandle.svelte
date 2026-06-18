<script lang="ts">
  /**
   * ResizeHandle.svelte — a thin vertical splitter between two panes (#18).
   *
   * Emits `resize` with the pointer delta (px) during drag and on arrow-key
   * press (keyboard-accessible); emits `reset` on double-click. The parent owns
   * the sizes and applies/clamps them (see layout.ts).
   */
  import { createEventDispatcher } from 'svelte';

  export let ariaLabel = 'Resize panel';
  /** px moved per Arrow key press. */
  export let step = 24;

  const dispatch = createEventDispatcher<{ resize: { dx: number }; reset: void }>();

  let dragging = false;
  let lastX = 0;

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    lastX = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    if (dx !== 0) dispatch('resize', { dx });
  }
  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { dispatch('resize', { dx: -step }); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { dispatch('resize', { dx: step }); e.preventDefault(); }
  }
</script>

<!-- A focusable role="separator" is the WAI-ARIA window-splitter pattern — it is
     intentionally interactive (drag + arrow keys), so the non-interactive a11y
     lints are false positives here. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
<div
  class="resize-handle"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={ariaLabel}
  tabindex="0"
  on:pointerdown={onPointerDown}
  on:pointermove={onPointerMove}
  on:pointerup={onPointerUp}
  on:pointercancel={onPointerUp}
  on:dblclick={() => dispatch('reset')}
  on:keydown={onKeydown}
></div>

<style>
  /* Grab zone is the element itself (7px) — wide enough for comfortable mouse
     targeting without overflowing into adjacent panes and blocking their
     scrollbars (fixes #scrollbar-overlap).  The visible divider is a centered
     1px ::after so the visual weight stays minimal. */
  .resize-handle {
    flex: none;
    width: 7px;
    align-self: stretch;
    position: relative;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;          /* (7 − 1) / 2 = 3 → centers the 1px line */
    width: 1px;
    background: var(--border);
    transition: background var(--dur-fast);
    pointer-events: none;
  }
  .resize-handle:hover::after,
  .resize-handle.dragging::after,
  .resize-handle:focus-visible::after { background: var(--seal-ink); }
  .resize-handle:focus-visible { outline: none; }
</style>
