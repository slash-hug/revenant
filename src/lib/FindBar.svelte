<script lang="ts">
  /**
   * FindBar.svelte — Floating find/replace bar.
   *
   * Svelte 5 runes. Positioned absolutely over the content area (ws-body),
   * centered horizontally, pinned near the top. Styled with Revenant design tokens.
   *
   * Props:
   *  - open (bindable) — whether the bar is visible
   *  - viewMode — current editor view mode
   *
   * Dispatches native DOM 'findreplace' events that bubble to the parent container.
   */
  import { findStore } from './stores/find';
  import type { MatchRange } from './stores/find';

  interface Props {
    open?: boolean;
    viewMode?: 'source' | 'split' | 'preview';
  }
  let { open = $bindable(false), viewMode = 'split' }: Props = $props();

  let searchInput: HTMLInputElement | null = $state(null);
  let replaceInput: HTMLInputElement | null = $state(null);

  // Local mirror of store state for reactivity.
  let query = $state('');
  let replaceWith = $state('');
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let useRegex = $state(false);
  let replaceOpen = $state(false);
  let matches: MatchRange[] = $state([]);
  let currentIndex = $state(-1);
  let regexError: string | null = $state(null);

  // Subscribe to the find store.
  const unsubscribe = findStore.subscribe((s) => {
    matches = s.matches;
    currentIndex = s.currentIndex;
    regexError = s.regexError;
    caseSensitive = s.caseSensitive;
    wholeWord = s.wholeWord;
    useRegex = s.useRegex;
    replaceOpen = s.replaceOpen;
  });

  // Auto-focus the search input when the bar opens.
  $effect(() => {
    if (open && searchInput) {
      requestAnimationFrame(() => searchInput?.focus());
    }
  });

  // Clean up subscription on destroy.
  import { onDestroy } from 'svelte';
  onDestroy(() => unsubscribe());

  // ── Match count display ──────────────────────────────────────────────────

  const matchCountText = $derived(
    regexError
      ? 'Invalid regex'
      : matches.length === 0
        ? query
          ? 'No results'
          : ''
        : `${currentIndex + 1} of ${matches.length}`,
  );

  // Replace row is disabled in preview-only mode.
  const replaceDisabled = $derived(viewMode === 'preview');

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleQueryInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    query = value;
    findStore.setQuery(value);
  }

  function handleReplaceInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    replaceWith = value;
    findStore.setReplaceWith(value);
  }

  function handleClose() {
    open = false;
    findStore.close();
  }

  function handleNext() {
    findStore.nextMatch();
  }

  function handlePrev() {
    findStore.prevMatch();
  }

  function handleReplace() {
    if (replaceDisabled || matches.length === 0 || currentIndex < 0) return;
    const match = matches[currentIndex];
    barEl?.dispatchEvent(
      new CustomEvent('findreplace', {
        bubbles: true,
        detail: { type: 'replace', from: match.from, to: match.to, replacement: replaceWith },
      }),
    );
  }

  function handleReplaceAll() {
    if (replaceDisabled || matches.length === 0) return;
    barEl?.dispatchEvent(
      new CustomEvent('findreplace', {
        bubbles: true,
        detail: { type: 'replaceAll', matches: [...matches], replacement: replaceWith },
      }),
    );
  }

  function handleToggleReplace() {
    if (replaceDisabled) return;
    findStore.toggleReplaceOpen();
  }

  function handleSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handlePrev();
      } else if (e.altKey) {
        handleReplace();
      } else {
        handleNext();
      }
      return;
    }
  }

  function handleReplaceKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        handleReplaceAll();
      } else {
        handleReplace();
      }
    }
  }

  let barEl: HTMLDivElement | null = $state(null);
</script>

{#if open}
  <div
    class="find-bar"
    class:has-error={!!regexError}
    bind:this={barEl}
    role="search"
    aria-label="Find and replace"
  >
    <!-- Row 1: Find -->
    <div class="fb-row">
      <button
        class="fb-chevron"
        class:fb-chevron-open={replaceOpen}
        onclick={handleToggleReplace}
        aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
        aria-expanded={replaceOpen}
        disabled={replaceDisabled}
        title={replaceDisabled ? 'Replace is unavailable in preview-only mode' : ''}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>

      <div class="fb-input-wrap">
        <input
          bind:this={searchInput}
          class="fb-input"
          class:fb-input-error={!!regexError}
          type="text"
          placeholder="Find…"
          value={query}
          oninput={handleQueryInput}
          onkeydown={handleSearchKeydown}
          spellcheck="false"
          autocomplete="off"
          aria-label="Search"
        />
        <span class="fb-count" class:fb-count-error={!!regexError}>
          {matchCountText}
        </span>
      </div>

      <div class="fb-toggles">
        <button
          class="fb-toggle"
          class:fb-toggle-active={caseSensitive}
          onclick={() => findStore.toggleCaseSensitive()}
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
        >Aa</button>
        <button
          class="fb-toggle"
          class:fb-toggle-active={wholeWord}
          onclick={() => findStore.toggleWholeWord()}
          aria-label="Match whole word"
          aria-pressed={wholeWord}
          title="Match whole word"
        >W</button>
        <button
          class="fb-toggle"
          class:fb-toggle-active={useRegex}
          onclick={() => findStore.toggleRegex()}
          aria-label="Use regular expression"
          aria-pressed={useRegex}
          title="Use regular expression"
        >.*</button>
      </div>

      <div class="fb-nav">
        <button class="fb-btn" onclick={handlePrev} aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matches.length === 0}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 4l-5 5h10z"/></svg>
        </button>
        <button class="fb-btn" onclick={handleNext} aria-label="Next match" title="Next match (Enter)" disabled={matches.length === 0}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12l5-5H3z"/></svg>
        </button>
      </div>

      <button class="fb-btn fb-close" onclick={handleClose} aria-label="Close find bar" title="Close (Escape)">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
      </button>
    </div>

    <!-- Row 2: Replace (collapsible) -->
    {#if replaceOpen && !replaceDisabled}
      <div class="fb-row fb-replace-row">
        <div class="fb-chevron-spacer"></div>
        <div class="fb-input-wrap">
          <input
            bind:this={replaceInput}
            class="fb-input"
            type="text"
            placeholder="Replace…"
            value={replaceWith}
            oninput={handleReplaceInput}
            onkeydown={handleReplaceKeydown}
            spellcheck="false"
            autocomplete="off"
            aria-label="Replace"
          />
        </div>
        <div class="fb-replace-actions">
          <button
            class="fb-btn fb-replace-btn"
            onclick={handleReplace}
            disabled={matches.length === 0 || currentIndex < 0}
            title="Replace (Alt+Enter)"
          >Replace</button>
          <button
            class="fb-btn fb-replace-btn"
            onclick={handleReplaceAll}
            disabled={matches.length === 0}
            title="Replace all (Ctrl+Alt+Enter)"
          >All</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .find-bar {
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: var(--z-pop);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 420px;
    max-width: 600px;
    animation: fb-in var(--dur-slow) var(--ease-out);
  }
  @keyframes fb-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .find-bar { animation: none; }
  }

  .fb-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Chevron toggle */
  .fb-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    border-radius: var(--r-sm);
    flex: none;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  .fb-chevron svg { width: 14px; height: 14px; }
  .fb-chevron:hover { color: var(--text); background: var(--surface-2); }
  .fb-chevron-open { transform: rotate(90deg); }
  .fb-chevron:disabled { opacity: 0.4; cursor: not-allowed; }
  .fb-chevron-spacer { width: 22px; flex: none; }

  /* Input wrapper (search/replace) */
  .fb-input-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    background: var(--editor-bg);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 0 6px;
    min-width: 0;
    transition: border-color var(--dur-fast);
  }
  .fb-input-wrap:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--focus-ring);
  }
  .fb-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 12.5px;
    padding: 5px 0;
    outline: none;
    min-width: 0;
  }
  .fb-input::placeholder { color: var(--text-faint); }
  .fb-input-error { color: var(--detached-text); }

  /* Match count inside search input */
  .fb-count {
    flex: none;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    padding-left: 6px;
    white-space: nowrap;
    user-select: none;
  }
  .fb-count-error { color: var(--detached-text); }

  /* Toggle buttons (Aa, W, .*) */
  .fb-toggles {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .fb-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 24px;
    padding: 0 5px;
    border: 1px solid transparent;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast);
  }
  .fb-toggle:hover { background: var(--surface-2); color: var(--text); }
  .fb-toggle-active {
    background: var(--accent-soft);
    color: var(--accent-text);
    border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  }

  /* Navigation and action buttons */
  .fb-nav {
    display: flex;
    gap: 1px;
    flex: none;
  }
  .fb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .fb-btn svg { width: 14px; height: 14px; }
  .fb-btn:hover { background: var(--surface-2); color: var(--text); }
  .fb-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .fb-close { margin-left: 2px; }

  /* Replace row */
  .fb-replace-row {
    animation: fb-slide var(--dur-base) var(--ease-out);
  }
  @keyframes fb-slide {
    from { opacity: 0; max-height: 0; }
    to   { opacity: 1; max-height: 40px; }
  }
  .fb-replace-actions {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .fb-replace-btn {
    width: auto;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    white-space: nowrap;
  }
</style>
