<script lang="ts">
  /**
   * TabManager.svelte — horizontal tab strip.
   * C1 — open/close/switch, dirty dot, focus-existing on duplicate.
   */
  import { createEventDispatcher, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { tabsStore, tabList, activeTab } from './stores/tabs';
  import { basename } from './util/path';

  // Closing is routed through the parent so a dirty tab can show the styled
  // Save/Discard/Cancel guard (#22) instead of a native confirm.
  const dispatch = createEventDispatcher<{ close: { id: string } }>();

  function handleClose(e: MouseEvent, id: string) {
    e.stopPropagation();
    dispatch('close', { id });
  }

  function handleSwitch(id: string) {
    tabsStore.switchTab(id);
  }

  // APG tablist keyboard model (a11y #30): Enter/Space activates; Left/Right move
  // focus between tabs with automatic activation (roving tabindex — only the
  // active tab is in the Tab order).
  function handleTabKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSwitch(id);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const tabs = get(tabList);
      if (tabs.length === 0) return;
      const idx = tabs.findIndex((t) => t.id === id);
      let nextIdx: number;
      if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabs.length - 1;
      else {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        nextIdx = (idx + dir + tabs.length) % tabs.length;
      }
      const next = tabs[nextIdx];
      handleSwitch(next.id);
      void tick().then(() => {
        document.querySelector<HTMLElement>(`.ws-tabs [data-tab-id="${next.id}"]`)?.focus();
      });
    }
  }

  function fileName(path: string): string {
    return basename(path);
  }
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
<nav class="ws-tabs" aria-label="Open documents" role="tablist">
  {#each $tabList as tab (tab.id)}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="tab"
      class:active={tab.id === $activeTab?.id}
      role="tab"
      data-tab-id={tab.id}
      tabindex={tab.id === $activeTab?.id ? 0 : -1}
      aria-selected={tab.id === $activeTab?.id}
      title={tab.path}
      on:click={() => handleSwitch(tab.id)}
      on:keydown={(e) => handleTabKeydown(e, tab.id)}
    >
      {#if tab.dirty}
        <span class="dot" aria-label="Unsaved changes" title="Unsaved changes"></span>
      {/if}
      <span class="tab-label">{fileName(tab.path)}</span>
      <button
        class="tab-x"
        on:click={(e) => handleClose(e, tab.id)}
        aria-label={`Close ${fileName(tab.path)}`}
        title="Close tab"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  {/each}

  {#if $tabList.length === 0}
    <div class="tabs-empty">No files open</div>
  {/if}
</nav>

<style>
  .ws-tabs {
    height: 39px;
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 3px;
    padding: 0 var(--sp-3);
    background: var(--tab-strip);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .ws-tabs::-webkit-scrollbar { height: 0; }

  .tab {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 31px;
    padding: 0 11px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
    border-radius: var(--r-md) var(--r-md) 0 0;
    cursor: pointer;
    border: 1px solid transparent;
    border-bottom: none;
    background: transparent;
    white-space: nowrap;
    max-width: 220px;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .tab:hover { background: var(--surface-2); color: var(--text); }
  .tab.active {
    background: var(--editor-bg);
    color: var(--text);
    border-color: var(--border);
    margin-bottom: -1px;
    font-weight: var(--fw-medium);
  }

  .tab-label { overflow: hidden; text-overflow: ellipsis; }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }

  .tab-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* 24×24 pointer target (WCAG 2.5.8). */
    min-width: 24px;
    min-height: 24px;
    color: var(--text-faint);
    padding: 2px;
    border-radius: var(--r-xs);
    border: none;
    background: transparent;
    cursor: pointer;
    flex: none;
  }
  .tab-x svg { width: 13px; height: 13px; }
  .tab-x:hover { color: var(--text); background: var(--surface-2); }

  .tabs-empty {
    display: flex;
    align-items: center;
    padding: 0 var(--sp-3);
    font-size: var(--fs-sm);
    color: var(--text-faint);
  }
</style>
