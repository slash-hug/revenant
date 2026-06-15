<script lang="ts">
  /**
   * AnnotationComposer.svelte — styled inline popover for writing a comment,
   * anchored at the text selection. Replaces the native window.prompt() so the
   * core annotation action matches the rest of the app (C8).
   *
   * Enter (without Shift) saves; Shift+Enter inserts a newline; Esc cancels.
   * Clicking outside cancels. Autofocuses the textarea on open.
   */
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';

  /** Viewport coordinates near the selection (px). */
  export let x = 0;
  export let y = 0;
  /** The selected text — shown as a quoted preview above the input. */
  export let quotedText = '';

  const dispatch = createEventDispatcher<{ submit: { body: string }; cancel: void }>();

  let body = '';
  let textarea: HTMLTextAreaElement;
  let panel: HTMLDivElement;
  let left = x;
  let top = y;
  // Element focused before the composer opened — focus returns here on close so
  // keyboard users aren't dropped at the top of the document (WCAG 2.4.3, #30).
  let previouslyFocused: HTMLElement | null = null;

  function clampToViewport() {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
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
    else if (e.key === 'Escape') { e.preventDefault(); dispatch('cancel'); }
  }

  function handleOutside(e: MouseEvent) {
    if (panel && !panel.contains(e.target as Node)) dispatch('cancel');
  }

  onMount(async () => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    await tick();
    clampToViewport();
    textarea?.focus();
    // Defer so the opening click doesn't immediately count as "outside".
    setTimeout(() => window.addEventListener('mousedown', handleOutside), 0);
  });
  onDestroy(() => {
    window.removeEventListener('mousedown', handleOutside);
    // Return focus to whatever held it before the composer opened.
    previouslyFocused?.focus?.();
  });
</script>

<div
  bind:this={panel}
  class="composer"
  style="left: {left}px; top: {top}px;"
  role="dialog"
  aria-label="Add a comment"
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

<style>
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
