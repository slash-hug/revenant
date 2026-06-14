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
  /* A 1px hairline divider (no layout gap). The grab zone is a wider invisible
     ::before that overflows the 1px box without taking any layout space, so the
     col-resize cursor appears across ~9px while the visible line stays thin. */
  .resize-handle {
    flex: none;
    width: 1px;
    align-self: stretch;
    position: relative;
    cursor: col-resize;
    background: var(--border);
    touch-action: none;
    transition: background var(--dur-fast);
  }
  .resize-handle::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    right: -4px;
  }
  .resize-handle:hover,
  .resize-handle.dragging,
  .resize-handle:focus-visible { background: var(--accent); }
  .resize-handle:focus-visible { outline: none; }
</style>
