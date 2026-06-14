<script lang="ts">
  /**
   * CommandPalette.svelte — ⌘K command palette (#9).
   *
   * A keyboard-first launcher over the app's actions. Rendered with a native
   * <dialog> (showModal) so focus trapping, Esc-to-close, and the ::backdrop
   * come for free. Typing fuzzy-filters the command list (see commandFilter.ts);
   * ↑/↓ move the selection, Enter runs it, Esc or a backdrop click dismisses.
   *
   * `open` is bindable — the parent toggles it (⌘K) and the dialog's own close
   * paths (Esc / backdrop / run) flip it back to false.
   */
  import { tick } from 'svelte';
  import { filterCommands, type Command } from './commandFilter';

  export let open = false;
  export let commands: Command[] = [];

  let dialogEl: HTMLDialogElement;
  let inputEl: HTMLInputElement;
  let listEl: HTMLElement;
  let query = '';
  let selected = 0;

  $: results = filterCommands(commands, query);
  // Section headers are only meaningful for the full, unsorted menu.
  $: showSections = query.trim().length === 0;
  // Keep the selection in range as the result set shrinks.
  $: if (selected > results.length - 1) selected = Math.max(0, results.length - 1);

  // Drive the native dialog from the `open` prop.
  $: if (dialogEl) syncDialog(open);

  async function syncDialog(shouldOpen: boolean) {
    if (shouldOpen && !dialogEl.open) {
      query = '';
      selected = 0;
      dialogEl.showModal();
      await tick();
      inputEl?.focus();
    } else if (!shouldOpen && dialogEl.open) {
      dialogEl.close();
    }
  }

  function close() {
    open = false;
  }

  function runAt(index: number) {
    const r = results[index];
    if (!r) return;
    // Close first so anything the command opens (composer, dialog) isn't nested
    // under this modal.
    close();
    r.command.run();
  }

  function move(delta: number) {
    const n = results.length;
    if (n === 0) return;
    selected = (selected + delta + n) % n;
    scrollSelectedIntoView();
  }

  async function scrollSelectedIntoView() {
    await tick();
    listEl?.querySelector('.row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function handleKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); selected = 0; scrollSelectedIntoView(); break;
      case 'End': e.preventDefault(); selected = results.length - 1; scrollSelectedIntoView(); break;
      case 'Enter': e.preventDefault(); runAt(selected); break;
      // Esc is handled natively by <dialog> (fires `cancel` → `close`).
    }
  }

  // Backdrop click: a click whose target is the dialog itself (not its content).
  function handleDialogClick(e: MouseEvent) {
    if (e.target === dialogEl) close();
  }

  /** Split a title into matched / unmatched runs for highlighting. */
  function segments(title: string, indices: number[]): Array<{ text: string; hit: boolean }> {
    if (indices.length === 0) return [{ text: title, hit: false }];
    const hits = new Set(indices);
    const parts: Array<{ text: string; hit: boolean }> = [];
    let cur = '';
    let curHit = hits.has(0);
    for (let i = 0; i < title.length; i++) {
      const hit = hits.has(i);
      if (hit !== curHit) {
        if (cur) parts.push({ text: cur, hit: curHit });
        cur = '';
        curHit = hit;
      }
      cur += title[i];
    }
    if (cur) parts.push({ text: cur, hit: curHit });
    return parts;
  }
</script>

<dialog
  bind:this={dialogEl}
  class="cmdk"
  aria-label="Command palette"
  on:click={handleDialogClick}
  on:close={() => (open = false)}
  on:cancel={() => (open = false)}
>
  <div class="cmdk-panel">
    <div class="cmdk-search">
      <svg class="cmdk-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
      </svg>
      <input
        bind:this={inputEl}
        bind:value={query}
        class="cmdk-input"
        type="text"
        placeholder="Type a command…"
        spellcheck="false"
        autocomplete="off"
        aria-label="Search commands"
        on:keydown={handleKeydown}
      />
      <kbd class="cmdk-esc">esc</kbd>
    </div>

    <div class="cmdk-list" bind:this={listEl} role="listbox" aria-label="Commands">
      {#if results.length === 0}
        <p class="cmdk-empty">No matching commands</p>
      {:else}
        {#each results as r, i (r.command.id)}
          {#if showSections && r.command.section !== results[i - 1]?.command.section}
            <div class="cmdk-section">{r.command.section}</div>
          {/if}
          <button
            type="button"
            class="row"
            class:active={i === selected}
            role="option"
            aria-selected={i === selected}
            on:mousemove={() => (selected = i)}
            on:click={() => runAt(i)}
          >
            <span class="row-title">
              {#each segments(r.command.title, r.indices) as seg}
                {#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
              {/each}
            </span>
            {#if r.command.hint}<kbd class="row-hint">{r.command.hint}</kbd>{/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
</dialog>

<style>
  .cmdk {
    width: min(560px, calc(100vw - 32px));
    max-width: none;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text);
    /* Pin near the top like Spotlight/VS Code rather than vertically centered. */
    margin: 12vh auto auto;
  }
  .cmdk::backdrop {
    background: var(--scrim, rgba(0, 0, 0, 0.4));
    backdrop-filter: blur(2px);
  }

  .cmdk-panel {
    display: flex;
    flex-direction: column;
    max-height: 60vh;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    animation: cmdk-in var(--dur-fast) var(--ease-out);
  }
  @keyframes cmdk-in {
    from { opacity: 0; transform: translateY(-6px) scale(.985); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cmdk-panel { animation: none; }
  }

  .cmdk-search {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .cmdk-search-ic { width: 17px; height: 17px; color: var(--text-faint); flex: none; }
  .cmdk-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: var(--fs-md);
    color: var(--text);
    background: transparent;
    border: none;
    outline: none;
  }
  .cmdk-input::placeholder { color: var(--text-faint); }
  .cmdk-esc {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-faint);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 1px 5px;
    flex: none;
  }

  .cmdk-list { overflow-y: auto; padding: 6px; min-height: 0; }
  .cmdk-empty {
    margin: 0;
    padding: 22px;
    text-align: center;
    color: var(--text-faint);
    font-size: var(--fs-base);
    font-style: italic;
    font-family: var(--font-prose);
  }

  .cmdk-section {
    padding: 10px 10px 4px;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    border: none;
    border-radius: var(--r-md);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-base);
  }
  .row.active { background: var(--accent-soft); }
  .row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.active .row-title { color: var(--accent-text); }
  .row-title mark { background: transparent; color: var(--accent-text); font-weight: var(--fw-semibold); }
  .row-hint {
    flex: none;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 1px 6px;
  }
</style>
