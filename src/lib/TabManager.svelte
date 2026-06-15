<script lang="ts">
  /**
   * TabManager.svelte — horizontal tab strip.
   * C1 — open/close/switch, dirty dot, focus-existing on duplicate.
   */
  import { createEventDispatcher } from 'svelte';
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
      tabindex="0"
      aria-selected={tab.id === $activeTab?.id}
      title={tab.path}
      on:click={() => handleSwitch(tab.id)}
      on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSwitch(tab.id); } }}
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
