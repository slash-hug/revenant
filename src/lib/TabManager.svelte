<script lang="ts">
  /**
   * TabManager.svelte — horizontal tab bar.
   *
   * Decisions: C1 — tab open/close/switch, dirty dot, focus-existing on duplicate.
   * The store holds all tab state; this component just renders + dispatches.
   */
  import { tabsStore, tabList, activeTab } from './stores/tabs';

  // Close a tab, guarding dirty state.
  function handleClose(e: MouseEvent, id: string) {
    e.stopPropagation();
    const tab = $tabList.find((t) => t.id === id);
    if (tab?.dirty) {
      // Browser confirm is a quick guard; a proper unsaved-changes modal is v1.1.
      if (!confirm(`"${fileName(tab.path)}" has unsaved changes. Close anyway?`)) return;
    }
    tabsStore.closeTab(id);
  }

  function handleSwitch(id: string) {
    tabsStore.switchTab(id);
  }

  function fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
<nav class="tab-bar" aria-label="Open documents" role="tablist">
  {#each $tabList as tab (tab.id)}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="tab"
      class:active={tab.id === $activeTab?.id}
      class:dirty={tab.dirty}
      role="tab"
      tabindex="0"
      aria-selected={tab.id === $activeTab?.id}
      title={tab.path}
      on:click={() => handleSwitch(tab.id)}
      on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSwitch(tab.id); } }}
    >
      <span class="tab-label">{fileName(tab.path)}</span>
      {#if tab.dirty}
        <span class="dirty-dot" aria-label="unsaved changes" title="Unsaved changes">●</span>
      {/if}
      <button
        class="close-btn"
        on:click={(e) => handleClose(e, tab.id)}
        aria-label={`Close ${fileName(tab.path)}`}
        title="Close tab"
      >×</button>
    </div>
  {/each}

  {#if $tabList.length === 0}
    <div class="tab-bar-empty">No files open</div>
  {/if}
</nav>

<style>
  .tab-bar {
    display: flex;
    flex-direction: row;
    align-items: stretch;
    background: var(--tab-bar-bg, #f5f5f5);
    border-bottom: 1px solid var(--border-color, #ddd);
    overflow-x: auto;
    min-height: 36px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 12px;
    border: none;
    border-right: 1px solid var(--border-color, #ddd);
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    color: var(--tab-fg, #555);
    white-space: nowrap;
    min-width: 80px;
    max-width: 200px;
    position: relative;
    transition: background 0.1s;
  }

  .tab:hover {
    background: var(--tab-hover-bg, #e8e8e8);
  }

  .tab.active {
    background: var(--tab-active-bg, #fff);
    color: var(--tab-active-fg, #222);
    border-bottom: 2px solid var(--accent, #0066cc);
  }

  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  .dirty-dot {
    color: var(--dirty-color, #e67e00);
    font-size: 10px;
    line-height: 1;
    flex-shrink: 0;
  }

  .close-btn {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
    color: var(--tab-fg, #555);
    padding: 0 2px;
    line-height: 1;
    border-radius: 3px;
    flex-shrink: 0;
    opacity: 0.6;
  }

  .close-btn:hover {
    background: var(--close-btn-hover, rgba(0,0,0,0.1));
    opacity: 1;
  }

  .tab-bar-empty {
    display: flex;
    align-items: center;
    padding: 0 16px;
    font-size: 12px;
    color: var(--muted, #999);
  }
</style>
