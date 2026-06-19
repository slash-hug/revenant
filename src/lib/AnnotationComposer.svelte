<script lang="ts">
  /**
   * AnnotationComposer.svelte — styled inline popover for writing a comment,
   * anchored at the text selection. Replaces the native window.prompt() so the
   * core annotation action matches the rest of the app (C8).
   *
   * Enter (without Shift) saves; Shift+Enter inserts a newline; Esc cancels.
   * Clicking outside (on the backdrop / dialog margin) cancels. Autofocuses the
   * textarea on open.
   *
   * Uses a native <dialog> element opened via showModal(), which provides a real
   * focus trap, aria-modal semantics, and Esc handling for free (WCAG 2.1.2,
   * 1.3.1 — see issue #41). The manual outside-click setTimeout hack and the
   * manual Esc keydown handler have been removed in favour of native browser
   * behaviour.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  /** Viewport coordinates near the selection (px). */
  export let x = 0;
  export let y = 0;
  /** The selected text — shown as a quoted preview above the input. */
  export let quotedText = '';

  const dispatch = createEventDispatcher<{ submit: { body: string }; cancel: void }>();

  let body = '';
  let textarea: HTMLTextAreaElement;
  let dialog: HTMLDialogElement;
  let left = x;
  let top = y;

  function clampToViewport() {
    if (!dialog) return;
    const inner = dialog.querySelector<HTMLElement>('.composer');
    if (!inner) return;
    const r = inner.getBoundingClientRect();
    const m = 12; // viewport margin
    left = Math.min(Math.max(m, x), window.innerWidth - r.width - m);
    top = Math.min(y, window.innerHeight - r.height - m);
    if (top < m) top = m;
  }

  function save() {
    const trimmed = body.trim();
    if (!trimmed) { dispatch('cancel'); return; }
    dispatch('submit', { body: trimmed });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    // Esc is handled by the native <dialog> cancel event — no manual keydown needed.
  }

  // Native <dialog> fires a `cancel` event when Esc is pressed from any child
  // element (not just the textarea). We preventDefault to stop the native
  // auto-close and let the parent component control open state, then dispatch
  // our own cancel so callers can react.
  function handleCancel(e: Event) {
    e.preventDefault();
    dispatch('cancel');
  }

  // Native <dialog> does NOT close on backdrop / outside-click by default.
  // We replicate the old behaviour: clicking on the dialog element itself
  // (outside the inner .composer content) dispatches cancel.
  function handleDialogClick(e: MouseEvent) {
    if (e.target === dialog) dispatch('cancel');
  }

  onMount(async () => {
    // Open as a modal — provides built-in focus trap, aria-modal, and Esc handling.
    dialog?.showModal();
    // Clamp inner panel position to viewport, then focus the textarea.
    // We read the inner .composer size after layout via a micro-task.
    await Promise.resolve();
    clampToViewport();
    textarea?.focus();
  });

  onDestroy(() => {
    // Close the native dialog if it is still open (e.g. parent removes component
    // programmatically rather than through a cancel/submit event).
    if (dialog?.open) dialog.close();
  });
</script>

<!--
  The <dialog> element is the accessible modal container. showModal() sets
  aria-modal="true" implicitly and traps focus inside it. The inner .composer
  div carries the visible styling; the <dialog> itself is reset to transparent
  so the existing card styles apply unchanged.
-->
<dialog
  bind:this={dialog}
  class="composer-dialog"
  aria-label="Add a comment"
  on:cancel={handleCancel}
  on:click={handleDialogClick}
>
  <div
    class="composer"
    style="left: {left}px; top: {top}px;"
  >
    {#if quotedText}
      <p class="quote" title={quotedText}>{quotedText}</p>
    {/if}
    <textarea
      bind:this={textarea}
      bind:value={body}
      class="composer-input"
      placeholder="Add a comment…"
      rows="3"
      on:keydown={handleKeydown}
    ></textarea>
    <div class="composer-actions">
      <span class="hint"><kbd>↵</kbd> to save</span>
      <span class="spacer"></span>
      <button type="button" class="c-btn c-secondary" on:click={() => dispatch('cancel')}>Cancel</button>
      <button type="button" class="c-btn c-primary" on:click={save}>Comment</button>
    </div>
  </div>
</dialog>

<style>
  /* Reset native <dialog> chrome so the inner .composer card stays intact. */
  .composer-dialog {
    padding: 0;
    border: 0;
    background: transparent;
    overflow: visible;
    /* Allow the inner card to be absolutely positioned within the viewport. */
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    /* The scrim is handled via ::backdrop below. */
    pointer-events: none;
  }
  /* Re-enable pointer events on the inner content so clicks register. */
  .composer-dialog .composer {
    pointer-events: auto;
  }
  /* Subtle scrim behind the composer to signal modal context. */
  .composer-dialog::backdrop {
    background: transparent;
  }

  .composer {
    position: fixed;
    z-index: var(--z-pop);
    width: 288px;
    max-width: calc(100vw - 24px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    animation: composer-in var(--dur-fast) var(--ease-out);
  }
  @keyframes composer-in {
    from { opacity: 0; transform: translateY(4px) scale(.99); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) { .composer { animation: none; } }

  .quote {
    margin: 0;
    padding: 4px 8px;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    font-style: italic;
    background: var(--surface-2);
    border-radius: var(--r-sm);
    max-height: 2.6em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-input {
    font: inherit;
    font-size: var(--fs-base);
    line-height: var(--lh-snug);
    color: var(--text);
    background: var(--editor-bg);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 8px 9px;
    resize: vertical;
    min-height: 56px;
    outline: none;
  }
  .composer-input::placeholder { color: var(--text-faint); }
  .composer-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .composer-actions { display: flex; align-items: center; gap: var(--sp-2); }
  .composer-actions .spacer { flex: 1; }
  .hint { font-size: var(--fs-xs); color: var(--text-faint); }
  .hint kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 0 4px;
  }

  .c-btn {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    line-height: 1;
    cursor: pointer;
    padding: 6px 12px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
  }
  .c-primary { background: var(--accent); color: var(--text-on-accent); font-weight: var(--fw-semibold); }
  .c-primary:hover { background: var(--accent-hover); }
  .c-secondary { background: var(--surface); color: var(--text); border-color: var(--border); }
  .c-secondary:hover { border-color: var(--border-strong); }
</style>
