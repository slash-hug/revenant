<script lang="ts">
  // App shell — Revenant
  //
  // Assembles the full editor surface and wires it to the Rust core:
  //  - subscribes to `open_file_request` (CLI / single-instance) → opens a tab
  //  - subscribes to `file_changed` (file watcher) → conflict modal or silent reload
  //  - mounts Toolbar / TabManager / EditorPane / PreviewPane / AnnotationDrawer
  //  - drives hasOpenFile from the tabs store
  //  - routes save / conflict / review / Obsidian / annotation actions
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { getCurrentWebview } from '@tauri-apps/api/webview';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';

  import Toolbar from './lib/Toolbar.svelte';
  import TabManager from './lib/TabManager.svelte';
  import EditorPane from './lib/EditorPane.svelte';
  import PreviewPane from './lib/PreviewPane.svelte';
  import AnnotationDrawer from './lib/AnnotationDrawer.svelte';
  import ConflictModal from './lib/ConflictModal.svelte';

  import { tabsStore, activeTab, tabList } from './lib/stores/tabs';
  import { annotationsStore } from './lib/stores/annotations';
  import { openFile, getSettings, exportObsidian } from './lib/types/ipc';
  import type { AnchorV1, Sidecar, IpcError } from './lib/types/ipc';
  import { generateReview } from './lib/ReviewExporter';
  import { basename } from './lib/util/path';

  type ViewMode = 'source' | 'preview' | 'split';

  let viewMode = $state<ViewMode>('split');
  let drawerOpen = $state(true);
  let conflict = $state<{ open: boolean; path: string }>({ open: false, path: '' });
  let toast = $state<string>('');
  let recentFiles = $state<string[]>(loadRecent());

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let loadedPath: string | null = null;

  // -------------------------------------------------------------------------
  // Toast helper
  // -------------------------------------------------------------------------
  function showToast(message: string) {
    toast = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 4000);
  }

  function errMessage(err: unknown): string {
    return (err as IpcError)?.message ?? String(err);
  }

  // -------------------------------------------------------------------------
  // Recent files (localStorage-backed)
  // -------------------------------------------------------------------------
  function loadRecent(): string[] {
    try {
      const raw = localStorage.getItem('revenant.recentFiles');
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  function rememberRecent(path: string) {
    recentFiles = [path, ...recentFiles.filter((p) => p !== path)].slice(0, 8);
    try {
      localStorage.setItem('revenant.recentFiles', JSON.stringify(recentFiles));
    } catch {
      /* non-fatal */
    }
  }

  // -------------------------------------------------------------------------
  // Open / reload
  // -------------------------------------------------------------------------
  async function openDoc(path: string) {
    try {
      const res = await openFile(path);
      tabsStore.openTab(res.path, res.content, res.content_hash);
      rememberRecent(res.path);
    } catch (err) {
      showToast(`Could not open file: ${errMessage(err)}`);
    }
  }

  async function reloadFromDisk(path: string) {
    try {
      const res = await openFile(path);
      const tab = $tabList.find((t) => t.path === res.path);
      if (tab) {
        tabsStore.reloadTab(tab.id, res.content, res.content_hash);
        annotationsStore.setDocContentHash(res.content_hash);
      }
    } catch (err) {
      showToast(`Could not reload file: ${errMessage(err)}`);
    }
  }

  // Load the sidecar whenever the active document changes (open or tab switch).
  $effect(() => {
    const tab = $activeTab;
    if (tab && tab.path !== loadedPath) {
      loadedPath = tab.path;
      void annotationsStore.load(tab.path, tab.contentHash);
    } else if (!tab) {
      loadedPath = null;
    }
  });

  // -------------------------------------------------------------------------
  // Editor events
  // -------------------------------------------------------------------------
  function handleSaved(newHash: string) {
    // Keep the annotation store's content hash in sync so re-anchoring on next
    // load compares against the right baseline.
    annotationsStore.setDocContentHash(newHash);
  }

  function handleConflict(path: string) {
    conflict = { open: true, path };
  }

  async function handleAddAnnotation(anchor: AnchorV1) {
    const tab = $activeTab;
    if (!tab) return;
    const body = window.prompt('Add a comment:');
    if (body == null || body.trim() === '') return;

    if (anchor.type === 'source') {
      const a = anchor.anchor;
      await annotationsStore.addAnnotation(
        a.start_line, a.end_line, a.start_char, a.end_char, a.quoted_text, body.trim(), 'anchored',
      );
    } else {
      // Block-level anchor (Mermaid/table): no precise source range available.
      await annotationsStore.addAnnotation(0, 0, 0, 0, anchor.anchor.quoted_text, body.trim(), 'block_level');
    }
    drawerOpen = true;
  }

  // -------------------------------------------------------------------------
  // Conflict resolution
  // -------------------------------------------------------------------------
  async function handleReload() {
    const path = conflict.path;
    conflict = { open: false, path: '' };
    await reloadFromDisk(path);
  }

  function handleKeepMine() {
    // Keep in-app edits; the on-disk change is ignored until the next save
    // attempt (which will surface the conflict again). No data loss.
    conflict = { open: false, path: '' };
  }

  // -------------------------------------------------------------------------
  // Toolbar actions
  // -------------------------------------------------------------------------
  async function handleGenerateReview() {
    const tab = $activeTab;
    if (!tab) return;
    const s = $annotationsStore;
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: s.docContentHash,
      general_notes: s.generalNotes,
      annotations: s.annotations,
    };
    try {
      await generateReview(sidecar, tab.path);
      showToast(`Review written: ${basename(tab.path)}.review.md`);
    } catch (err) {
      showToast(`Generate review failed: ${errMessage(err)}`);
    }
  }

  async function handleExportObsidian() {
    const tab = $activeTab;
    if (!tab) return;
    try {
      const settings = await getSettings();
      if (!settings.vaults.length) {
        showToast('No Obsidian vault configured yet.');
        return;
      }
      const res = await exportObsidian({
        doc_path: tab.path,
        vault_path: settings.vaults[0],
        subfolder: settings.default_export_subfolder ?? '',
      });
      showToast(
        res.method === 'rest'
          ? 'Exported to Obsidian (REST).'
          : `Copied to vault: ${basename(res.destination)}`,
      );
    } catch (err) {
      showToast(`Obsidian export failed: ${errMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Welcome-screen actions
  // -------------------------------------------------------------------------
  async function handleOpenFile() {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (typeof selected === 'string') await openDoc(selected);
    } catch (err) {
      showToast(`Open dialog failed: ${errMessage(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------
  onMount(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    // `revenant <file.md>` — cold start (delayed emit) and single-instance.
    unlisteners.push(
      listen<string>('open_file_request', (e) => {
        if (e.payload) void openDoc(e.payload);
      }),
    );

    // External file change detected by the Rust watcher.
    unlisteners.push(
      listen<{ path: string; external: boolean }>('file_changed', (e) => {
        if (!e.payload.external) return;
        const tab = $tabList.find((t) => t.path === e.payload.path);
        if (!tab) return;
        if (tab.dirty) {
          // Unsaved edits would be lost — ask before clobbering (A5/C12).
          conflict = { open: true, path: e.payload.path };
        } else {
          // No local edits to lose — refresh silently.
          void reloadFromDisk(e.payload.path);
        }
      }),
    );

    // Native OS file drag-and-drop (Tauri delivers real paths here, not the DOM).
    const dnd = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      const md = event.payload.paths.filter((p) => p.toLowerCase().endsWith('.md'));
      if (md.length) md.forEach((p) => void openDoc(p));
      else if (event.payload.paths.length) showToast('Only .md files can be opened.');
    });

    return () => {
      unlisteners.forEach((p) => void p.then((f) => f()));
      void dnd.then((f) => f());
      if (toastTimer) clearTimeout(toastTimer);
    };
  });
</script>

<main class="app-shell">
  {#if $tabList.length === 0}
    <!-- Welcome screen (C11): shown when no tab is open -->
    <div class="welcome-screen" role="region" aria-label="Welcome">
      <div class="welcome-content">
        <h1 class="welcome-title">Revenant</h1>
        <p class="welcome-subtitle">Markdown viewer &amp; review companion</p>

        <div class="drop-zone" aria-label="Drop zone for markdown files">
          <span class="drop-zone-icon">📄</span>
          <p>Drop a <code>.md</code> file here</p>
          <p class="drop-zone-or">or</p>
          <button class="open-btn" onclick={handleOpenFile} type="button">Open file…</button>
        </div>

        <section class="recent-files" aria-label="Recent files">
          <h2>Recent files</h2>
          {#if recentFiles.length === 0}
            <p class="recent-empty">No recent files.</p>
          {:else}
            <ul class="recent-list">
              {#each recentFiles as path (path)}
                <li>
                  <button class="recent-item" type="button" onclick={() => openDoc(path)} title={path}>
                    {basename(path)}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    </div>
  {:else}
    <div class="editor-shell" class:drawer-open={drawerOpen}>
      <div class="toolbar-slot">
        <Toolbar
          {viewMode}
          on:viewMode={(e) => (viewMode = e.detail.mode)}
          on:generateReview={handleGenerateReview}
          on:exportObsidian={handleExportObsidian}
        />
      </div>

      <div class="tabs-slot">
        <TabManager />
      </div>

      <div class="content-area">
        {#if $activeTab}
          {#key $activeTab.id}
            <div class="panes view-{viewMode}">
              {#if viewMode === 'source' || viewMode === 'split'}
                <div class="pane editor-wrap">
                  <EditorPane
                    tabId={$activeTab.id}
                    content={$activeTab.content}
                    filePath={$activeTab.path}
                    on:saved={(e) => handleSaved(e.detail.newHash)}
                    on:conflict={(e) => handleConflict(e.detail.filePath)}
                    on:saveError={(e) => showToast(e.detail.message)}
                    on:addAnnotation={(e) => handleAddAnnotation(e.detail.anchor)}
                  />
                </div>
              {/if}
              {#if viewMode === 'preview' || viewMode === 'split'}
                <div class="pane preview-wrap">
                  <PreviewPane
                    content={$activeTab.content}
                    on:addAnnotation={(e) => handleAddAnnotation(e.detail.anchor)}
                  />
                </div>
              {/if}
            </div>
          {/key}
        {/if}
      </div>

      {#if drawerOpen}
        <div class="drawer-slot">
          <AnnotationDrawer open={drawerOpen} on:close={() => (drawerOpen = false)} />
        </div>
      {/if}
    </div>
  {/if}

  <ConflictModal open={conflict.open} filePath={conflict.path} on:reload={handleReload} on:keepMine={handleKeepMine} />

  {#if toast}
    <div class="toast" role="status" aria-live="polite">{toast}</div>
  {/if}
</main>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #1a1a1a;
    color: #e0e0e0;
    height: 100vh;
    overflow: hidden;
  }

  .app-shell {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* --- Welcome screen --- */
  .welcome-screen {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .welcome-content {
    max-width: 480px;
    width: 100%;
    text-align: center;
  }

  .welcome-title {
    font-size: 2.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: #f0f0f0;
    margin-bottom: 0.5rem;
  }

  .welcome-subtitle {
    color: #888;
    margin-bottom: 2rem;
    font-size: 1rem;
  }

  .drop-zone {
    border: 2px dashed #444;
    border-radius: 12px;
    padding: 2.5rem 2rem;
    margin-bottom: 2rem;
    transition: border-color 0.2s ease;
    cursor: default;
  }

  .drop-zone:hover {
    border-color: #666;
  }

  .drop-zone-icon {
    font-size: 2.5rem;
    display: block;
    margin-bottom: 1rem;
  }

  .drop-zone p {
    color: #aaa;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }

  .drop-zone-or {
    color: #666;
    font-size: 0.85rem;
    margin: 0.75rem 0;
  }

  .open-btn {
    background: #3b82f6;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 0.6rem 1.4rem;
    font-size: 0.9rem;
    cursor: pointer;
    transition: background 0.15s ease;
    margin-top: 0.5rem;
  }

  .open-btn:hover {
    background: #2563eb;
  }

  .recent-files {
    text-align: left;
  }

  .recent-files h2 {
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #666;
    margin-bottom: 0.75rem;
  }

  .recent-empty {
    color: #555;
    font-size: 0.875rem;
  }

  .recent-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: #9bb8e0;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .recent-item:hover {
    background: #262626;
  }

  /* --- Editor shell --- */
  .editor-shell {
    flex: 1;
    display: grid;
    grid-template-rows: auto auto 1fr;
    grid-template-columns: 1fr;
    height: 100vh;
    min-height: 0;
  }

  .editor-shell.drawer-open {
    grid-template-columns: 1fr auto;
  }

  .toolbar-slot {
    grid-column: 1 / -1;
    background: #252525;
    border-bottom: 1px solid #333;
  }

  .tabs-slot {
    grid-column: 1 / -1;
    background: #1e1e1e;
    border-bottom: 1px solid #333;
  }

  .content-area {
    grid-column: 1;
    overflow: hidden;
    background: #1a1a1a;
    min-height: 0;
  }

  .panes {
    display: flex;
    height: 100%;
    min-height: 0;
  }

  .panes.view-split .pane {
    flex: 1 1 50%;
    min-width: 0;
  }

  .panes.view-source .pane,
  .panes.view-preview .pane {
    flex: 1 1 100%;
    min-width: 0;
  }

  .editor-wrap {
    border-right: 1px solid #333;
    overflow: hidden;
  }

  .preview-wrap {
    overflow: hidden;
  }

  .drawer-slot {
    grid-column: 2;
    grid-row: 3;
    overflow: hidden;
  }

  /* --- Toast --- */
  .toast {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    background: #2b2b2b;
    color: #eee;
    border: 1px solid #444;
    border-radius: 8px;
    padding: 8px 16px;
    font-size: 13px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 2000;
    max-width: 80vw;
  }
</style>
