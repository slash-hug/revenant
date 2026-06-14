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
  import ResizeHandle from './lib/ResizeHandle.svelte';
  import {
    nextSplitFrac, nextDrawerWidth, clamp,
    SPLIT_DEFAULT, DRAWER_DEFAULT, SPLIT_MIN, SPLIT_MAX, DRAWER_MIN, DRAWER_MAX,
  } from './lib/layout';
  import ConflictModal from './lib/ConflictModal.svelte';
  import AnnotationComposer from './lib/AnnotationComposer.svelte';
  import AnnotationPopover from './lib/AnnotationPopover.svelte';
  import ThemeToggle from './lib/ThemeToggle.svelte';
  import Suminagashi from './lib/Suminagashi.svelte';

  import { tabsStore, activeTab, tabList } from './lib/stores/tabs';
  import { annotationsStore } from './lib/stores/annotations';
  import { annotationFocus, clearFocus } from './lib/stores/annotationFocus';
  import Toast from './lib/Toast.svelte';
  import { deleteAnnotationWithUndo } from './lib/annotationActions';
  import { openFile, getSettings, exportObsidian } from './lib/types/ipc';
  import type { AnchorV1, Sidecar, IpcError } from './lib/types/ipc';
  import { generateReview } from './lib/ReviewExporter';
  import { basename } from './lib/util/path';

  type ViewMode = 'source' | 'preview' | 'split';

  // Device-local layout prefs (#18), persisted in localStorage.
  const LAYOUT_KEY = 'revenant.layout.v1';
  function loadLayout() {
    const def = { frac: SPLIT_DEFAULT, width: DRAWER_DEFAULT, open: true };
    if (typeof localStorage === 'undefined') return def;
    try {
      const o = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
      return {
        frac: typeof o.frac === 'number' ? clamp(o.frac, SPLIT_MIN, SPLIT_MAX) : def.frac,
        width: typeof o.width === 'number' ? clamp(o.width, DRAWER_MIN, DRAWER_MAX) : def.width,
        open: typeof o.open === 'boolean' ? o.open : def.open,
      };
    } catch { return def; }
  }
  const _layout0 = loadLayout();

  let viewMode = $state<ViewMode>('split');
  let drawerOpen = $state(_layout0.open);
  let splitEditorFrac = $state(_layout0.frac); // editor's share of the split
  let drawerWidth = $state(_layout0.width);    // px
  let panesEl = $state<HTMLElement | null>(null);

  // Persist layout on any change (runs once on mount too — harmless).
  $effect(() => {
    const data = JSON.stringify({ frac: splitEditorFrac, width: drawerWidth, open: drawerOpen });
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(LAYOUT_KEY, data); } catch { /* ignore quota/private-mode */ }
    }
  });

  function onSplitResize(dx: number) {
    splitEditorFrac = nextSplitFrac(splitEditorFrac, dx, panesEl?.clientWidth ?? 0);
  }
  function onDrawerResize(dx: number) {
    drawerWidth = nextDrawerWidth(drawerWidth, dx);
  }
  let conflict = $state<{ open: boolean; path: string }>({ open: false, path: '' });
  let toast = $state<string>('');
  let recentFiles = $state<string[]>(loadRecent());
  let bloom = $state(false); // suminagashi open-transition overlay
  // Styled annotation composer popover (replaces window.prompt); null = closed.
  let compose = $state<{ anchor: AnchorV1; x: number; y: number; quoted: string } | null>(null);

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

  /** Abbreviate a home-dir prefix to ~ for the status bar (mac/linux/windows). */
  function homeAbbrev(path: string): string {
    return path.replace(/^([A-Za-z]:)?[\\/](Users|home)[\\/][^\\/]+/, '~');
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
    const wasEmpty = $tabList.length === 0;
    try {
      const res = await openFile(path);
      tabsStore.openTab(res.path, res.content, res.content_hash);
      rememberRecent(res.path);
      // Ink-bloom transition on entering the workspace from the welcome screen.
      if (wasEmpty) bloom = true;
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

  // D11/TRAP 4 — annotationFocus is not tab-scoped; clear it on every tab switch
  // so a stale activeId from the previous tab does not ghost-wash the new one.
  // scrollNonce is left unchanged (clearFocus does not touch it).
  $effect(() => {
    // Reading $activeTab?.id registers the dependency; the body runs whenever it
    // changes (including initial mount, which is a no-op — activeId is already null).
    $activeTab?.id;
    clearFocus();
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

  /** A pane requested a comment: open the styled composer at the selection. */
  function requestAnnotation(detail: { anchor: AnchorV1; x: number; y: number; quoted: string }) {
    if (!$activeTab) return;
    compose = detail;
  }

  /** Composer saved: create the annotation with the typed body. */
  async function commitAnnotation(body: string) {
    const detail = compose;
    compose = null;
    if (!detail || !$activeTab) return;
    const anchor = detail.anchor;

    if (anchor.type === 'source') {
      const a = anchor.anchor;
      annotationsStore.addAnnotation(
        a.start_line, a.end_line, a.start_char, a.end_char, a.quoted_text, body, 'anchored',
      );
    } else {
      // Block-level anchor (Mermaid/table): no precise source range available.
      annotationsStore.addAnnotation(0, 0, 0, 0, anchor.anchor.quoted_text, body, 'block_level');
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
    if (s.annotations.length === 0 && !s.generalNotes.trim()) {
      showToast('Nothing to export yet — add a comment or a general note first.');
      return;
    }
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

    // Chrome accelerators (the editor owns its own keys via CodeMirror; these
    // combos aren't in its keymap, so they bubble to the window).
    //   ⌘/Ctrl 1·2·3 → Source · Split · Preview
    //   ⌘/Ctrl \      → toggle the annotation drawer
    //   ⌘/Ctrl ⇧ R    → generate review
    window.addEventListener('keydown', handleGlobalKeydown);

    return () => {
      unlisteners.forEach((p) => void p.then((f) => f()));
      void dnd.then((f) => f());
      window.removeEventListener('keydown', handleGlobalKeydown);
      if (toastTimer) clearTimeout(toastTimer);
    };
  });

  function handleGlobalKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if ($tabList.length === 0) return;
    if (e.shiftKey) {
      if (e.code === 'KeyR') { e.preventDefault(); void handleGenerateReview(); }
      return;
    }
    switch (e.key) {
      case '1': e.preventDefault(); viewMode = 'source'; break;
      case '2': e.preventDefault(); viewMode = 'split'; break;
      case '3': e.preventDefault(); viewMode = 'preview'; break;
      case '\\': e.preventDefault(); drawerOpen = !drawerOpen; break;
    }
  }
</script>

<main class="app-root">
  {#if $tabList.length === 0}
    <!-- Welcome / empty state (C11) -->
    <div class="welcome" role="region" aria-label="Welcome">
      <div class="welcome-top">
        <ThemeToggle />
      </div>

      <div class="welcome-inner">
        <div class="welcome-mark">
          <svg class="welcome-logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="var(--accent)" />
            <path d="M8.5 16.5V8.4a.9.9 0 0 1 .9-.9h2.9a2.6 2.6 0 0 1 0 5.2H9.4M12.6 12.7l3 3.8"
              stroke="var(--text-on-accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="welcome-word">Revenant</span>
        </div>
        <p class="welcome-tag">Markdown viewer &amp; review companion</p>

        <div class="drop" aria-label="Open a markdown file">
          <svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2Z" />
          </svg>
          <p class="drop-title">Drop a <code>.md</code> file here</p>
          <p class="drop-or">or</p>
          <button class="btn btn-primary" onclick={handleOpenFile} type="button">Open file…</button>
        </div>

        <section class="recent" aria-label="Recent files">
          <div class="recent-head">
            <span class="recent-title">Recent files</span>
          </div>
          {#if recentFiles.length === 0}
            <p class="recent-empty">Nothing here yet — open a file to begin.</p>
          {:else}
            <div class="recent-list">
              {#each recentFiles as path (path)}
                <button class="recent-row" type="button" onclick={() => openDoc(path)} title={path}>
                  <span class="recent-ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M6 21a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2Z" />
                    </svg>
                  </span>
                  <span class="recent-main">
                    <span class="recent-name">{basename(path)}</span>
                    <span class="recent-path">{path}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    </div>
  {:else}
    <div class="ws">
      <Toolbar
        {viewMode}
        {drawerOpen}
        on:viewMode={(e) => (viewMode = e.detail.mode)}
        on:generateReview={handleGenerateReview}
        on:exportObsidian={handleExportObsidian}
        on:toggleDrawer={() => (drawerOpen = !drawerOpen)}
      />

      <TabManager />

      <div class="ws-body">
        <div class="panes view-{viewMode}" bind:this={panesEl} style="--split-editor: {splitEditorFrac * 100}%">
          {#if $activeTab}
            {#key $activeTab.id}
              {#if viewMode === 'source' || viewMode === 'split'}
                <div class="pane editor-wrap">
                  <EditorPane
                    tabId={$activeTab.id}
                    content={$activeTab.content}
                    filePath={$activeTab.path}
                    on:saved={(e) => handleSaved(e.detail.newHash)}
                    on:conflict={(e) => handleConflict(e.detail.filePath)}
                    on:saveError={(e) => showToast(e.detail.message)}
                    on:addAnnotation={(e) => requestAnnotation(e.detail)}
                  />
                </div>
              {/if}
              {#if viewMode === 'split'}
                <ResizeHandle
                  ariaLabel="Resize editor and preview"
                  on:resize={(e) => onSplitResize(e.detail.dx)}
                  on:reset={() => (splitEditorFrac = SPLIT_DEFAULT)}
                />
              {/if}
              {#if viewMode === 'preview' || viewMode === 'split'}
                <div class="pane preview-wrap">
                  <PreviewPane
                    content={$activeTab.content}
                    on:addAnnotation={(e) => requestAnnotation(e.detail)}
                  />
                </div>
              {/if}
            {/key}
          {/if}
        </div>

        {#if drawerOpen}
          <ResizeHandle
            ariaLabel="Resize annotation drawer"
            on:resize={(e) => onDrawerResize(e.detail.dx)}
            on:reset={() => (drawerWidth = DRAWER_DEFAULT)}
          />
        {/if}
        <div class="drawer-wrap" class:hidden={!drawerOpen} style="width: {drawerWidth}px">
          <AnnotationDrawer open={drawerOpen} />
        </div>
      </div>

      {#if $activeTab}
        <div class="ws-status" role="status" aria-label="Document status">
          <span
            class="st-save"
            class:dirty={$activeTab.dirty}
            title={$activeTab.dirty ? 'Unsaved changes' : 'All changes saved'}
          >
            <span class="st-dot" aria-hidden="true"></span>
            {$activeTab.dirty ? 'Unsaved' : 'Saved'}
          </span>
          <span class="st-path" title={$activeTab.path}>{homeAbbrev($activeTab.path)}</span>
          <span>{$activeTab.content.split('\n').length} lines</span>
          <span>{$annotationsStore.annotations.length} comments</span>
          <span class="spacer"></span>
          <span>Markdown</span>
          <span>UTF-8</span>
        </div>
      {/if}
    </div>
  {/if}

  <ConflictModal open={conflict.open} filePath={conflict.path} on:reload={handleReload} on:keepMine={handleKeepMine} />

  <!-- Shared annotation popover — portal-mounted at App root, position: fixed.
       Driven by $annotationFocus.activeId. Placement is coordinate-driven from
       the seal/marker rect emitted via the focus store (D4). -->
  <AnnotationPopover
    annotation={$annotationFocus.activeId
      ? ($annotationsStore.annotations.find((a) => a.id === $annotationFocus.activeId) ?? null)
      : null}
    anchorRect={$annotationFocus.anchorRect}
    on:delete={(e) => { deleteAnnotationWithUndo(e.detail.id); clearFocus(); }}
  />

  <!-- Transient status toast (undoable delete, etc.) -->
  <Toast />

  {#if compose}
    <AnnotationComposer
      x={compose.x}
      y={compose.y}
      quotedText={compose.quoted}
      on:submit={(e) => commitAnnotation(e.detail.body)}
      on:cancel={() => (compose = null)}
    />
  {/if}

  {#if bloom}
    <Suminagashi on:done={() => (bloom = false)} />
  {/if}

  {#if toast}
    <div class="toast-stack">
      <div class="toast" role="status" aria-live="polite">
        <span class="dotmark" aria-hidden="true"></span>
        <span class="toast-msg">{toast}</span>
      </div>
    </div>
  {/if}
</main>

<style>
  .app-root {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    transition: background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out);
  }

  /* ============ Welcome ============ */
  .welcome { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; align-items: center; }
  .welcome-top { width: 100%; display: flex; justify-content: flex-end; padding: 18px 22px; }
  .welcome-inner {
    width: 100%;
    max-width: 540px;
    margin: auto;
    padding: 0 24px 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .welcome-mark { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
  .welcome-logo { width: 34px; height: 34px; }
  .welcome-word { font-size: 40px; font-weight: var(--fw-semibold); letter-spacing: -.025em; }
  .welcome-tag {
    font-family: var(--font-prose);
    font-size: 17px;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 36px;
  }

  .drop {
    width: 100%;
    border: 1.5px dashed var(--border-strong);
    border-radius: var(--r-xl);
    background: var(--surface);
    padding: 40px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    transition: border-color var(--dur-base), background var(--dur-base);
  }
  .drop-icon { width: 30px; height: 30px; color: var(--text-faint); }
  .drop-title { margin: 0; font-size: var(--fs-md); color: var(--text); font-weight: var(--fw-medium); }
  .drop-title code { font-family: var(--font-mono); font-size: .92em; }
  .drop-or { margin: 0; font-size: var(--fs-sm); color: var(--text-faint); }

  .recent { width: 100%; margin-top: 40px; text-align: left; }
  .recent-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .recent-title {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .recent-list { display: flex; flex-direction: column; gap: 6px; }
  .recent-row {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    text-align: left;
    padding: 11px 12px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .recent-row:hover { background: var(--surface); border-color: var(--border); }
  .recent-ic { color: var(--text-faint); flex: none; display: inline-flex; }
  .recent-ic svg { width: 17px; height: 17px; }
  .recent-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .recent-name { font-size: var(--fs-base); color: var(--text); font-weight: var(--fw-medium); }
  .recent-path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-empty {
    border: 1px dashed var(--border);
    border-radius: var(--r-lg);
    padding: 28px;
    text-align: center;
    color: var(--text-faint);
    font-size: var(--fs-base);
    font-family: var(--font-prose);
    font-style: italic;
  }

  .btn {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    cursor: pointer;
    padding: 9px 18px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
  }
  .btn-primary { background: var(--accent); color: var(--text-on-accent); box-shadow: var(--accent-shadow); }
  .btn-primary:hover { background: var(--accent-hover); }

  /* ============ Workspace ============ */
  .ws { flex: 1; min-height: 0; display: flex; flex-direction: column; }

  .ws-body { flex: 1; min-height: 0; display: flex; min-width: 0; }

  .panes { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
  .pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
  /* Split widths: editor share is the draggable --split-editor; preview takes the
     rest. The ResizeHandle between them is the visible divider. */
  .panes.view-split .editor-wrap { flex: 0 0 var(--split-editor, 47%); }
  .panes.view-split .preview-wrap { flex: 1 1 0; }
  .panes.view-source .pane,
  .panes.view-preview .pane { flex: 1 1 100%; }

  .drawer-wrap { flex: none; display: flex; min-height: 0; }
  .drawer-wrap.hidden { display: none; }

  /* status bar */
  .ws-status {
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
    background: var(--toolbar);
    border-top: 1px solid var(--border);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
  }
  .ws-status .spacer { flex: 1; }
  .ws-status .st-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }
  .ws-status .st-save {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--success-text);
  }
  .ws-status .st-save.dirty { color: var(--text-muted); }
  .ws-status .st-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    flex: none;
  }
  .ws-status .st-save.dirty .st-dot {
    background: transparent;
    border: 1px solid var(--text-muted);
  }

  /* ============ Toast ============ */
  .toast-stack {
    position: fixed;
    left: 50%;
    bottom: 36px;
    transform: translateX(-50%);
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 10px 14px;
    font-size: var(--fs-base);
    border-radius: var(--r-lg);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    min-width: 240px;
    max-width: 80vw;
    animation: toast-in var(--dur-slow) var(--ease-out);
  }
  .toast .dotmark { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
</style>
