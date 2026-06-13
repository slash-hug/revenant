<script lang="ts">
  /**
   * App.svelte — Application shell.
   * Owned by WS-A; this stub is provided so WS-C builds can succeed
   * while WS-A is still pending.
   *
   * In full WS-A, this will mount TabManager, Toolbar, EditorPane,
   * PreviewPane, AnnotationDrawer, and ConflictModal.
   */
  import TabManager from './lib/TabManager.svelte';
  import Toolbar from './lib/Toolbar.svelte';
  import AnnotationDrawer from './lib/AnnotationDrawer.svelte';
  import ConflictModal from './lib/ConflictModal.svelte';
  import type { ViewMode } from './lib/Toolbar.svelte';

  let viewMode: ViewMode = 'split';
  let drawerOpen = true;
  let conflictOpen = false;
  let conflictFile = '';

  function handleViewMode(e: CustomEvent<{ mode: ViewMode }>) {
    viewMode = e.detail.mode;
  }
</script>

<div class="app-shell">
  <Toolbar
    {viewMode}
    on:viewMode={handleViewMode}
    on:generateReview={() => {}}
    on:exportObsidian={() => {}}
  />

  <TabManager />

  <main class="content-area">
    <!-- Editor and Preview panes are mounted here by WS-A based on viewMode -->
    <div class="placeholder-pane">
      <p>Revenant — Open a file to begin.</p>
    </div>
  </main>

  {#if drawerOpen}
    <AnnotationDrawer open={drawerOpen} on:close={() => (drawerOpen = false)} />
  {/if}

  <ConflictModal
    open={conflictOpen}
    filePath={conflictFile}
    on:reload={() => (conflictOpen = false)}
    on:keepMine={() => (conflictOpen = false)}
  />
</div>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--bg, #fff);
    color: var(--fg, #222);
  }

  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  .content-area {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .placeholder-pane {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted, #888);
    font-size: 16px;
  }
</style>
