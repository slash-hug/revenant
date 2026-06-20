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
  import ExportDialog from './lib/ExportDialog.svelte';
  import UnsavedChangesModal from './lib/UnsavedChangesModal.svelte';
  import KeyboardShortcutsModal from './lib/KeyboardShortcutsModal.svelte';
  import AnnotationComposer from './lib/AnnotationComposer.svelte';
  import AnnotationPopover from './lib/AnnotationPopover.svelte';
  import ThemeToggle from './lib/ThemeToggle.svelte';
  import Suminagashi from './lib/Suminagashi.svelte';
  import CommandPalette from './lib/CommandPalette.svelte';
  import SettingsPage from './lib/SettingsPage.svelte';

  import { tabsStore, activeTab, tabList } from './lib/stores/tabs';
  import type { Tab } from './lib/stores/tabs';
  import { annotationsStore } from './lib/stores/annotations';
  import { settings, loadSettings } from './lib/stores/settings';
  import { initPreviewZoom, previewZoom, setZoom, resetZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from './lib/stores/previewZoom';
  import { annotationFocus, clearFocus, focusAnnotation } from './lib/stores/annotationFocus';
  import Toast from './lib/Toast.svelte';
  import { deleteAnnotationWithUndo, cycleAnnotationId } from './lib/annotationActions';
  import { openFile, exportObsidian, saveFile, unwatchFile, exportHtml, exportPdf, readFileBytes } from './lib/types/ipc';
  import type { AnchorV1, Sidecar, IpcError, Annotation } from './lib/types/ipc';
  import { buildExportDocument } from './lib/documentExport';
  import type { Command } from './lib/commandFilter';
  import { generateReview } from './lib/ReviewExporter';
  import { basename } from './lib/util/path';
  import { writeText } from '@tauri-apps/plugin-clipboard-manager';
  import { buildNudge, DEFAULT_NUDGE_TEMPLATE } from './lib/agentNudge';
  import { isMac as isMacPlatform } from './lib/util/platform';

  type ViewMode = 'source' | 'preview' | 'split';

  // Platform-aware shortcut glyphs for palette hints.
  const isMac = isMacPlatform();
  const mod = isMac ? '⌘' : 'Ctrl';

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
  let paletteOpen = $state(false); // ⌘K command palette (#9)
  let shortcutsOpen = $state(false); // keyboard-shortcuts help overlay (#25)
  // Settings view-state: null = settings closed; string = active category.
  // Replaces the old boolean settingsOpen (A1).
  let settingsView: 'general' | 'integrations' | 'agent' | 'about' | null = $state(null);
  // Focus target captured on settings entry so we can restore it on exit (A3).
  let focusRestoreEl: HTMLElement | null = null;
  let editorRef = $state<{ save: () => Promise<'saved' | 'conflict' | 'error' | 'noop'> } | null>(null);
  let closing = $state<Tab | null>(null); // tab pending an unsaved-changes guard (#22)
  let conflict = $state<{ open: boolean; path: string }>({ open: false, path: '' });
  let toast = $state<string>('');
  let recentFiles = $state<string[]>(loadRecent());
  let bloom = $state(false); // suminagashi open-transition overlay
  // Styled annotation composer popover (replaces window.prompt); null = closed.
  let compose = $state<{ anchor: AnchorV1; x: number; y: number; quoted: string } | null>(null);

  // Export dialog state — null = closed; string = pre-selected format ("pdf"|"html"|"").
  let exportDialogPreset = $state<string | null>(null);
  // In-flight toolbar action (#29) — drives the busy/disabled state on the
  // Generate-review and Export buttons so slow ops don't look frozen.
  let busyAction = $state<'review' | 'obsidian' | null>(null);

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
  // Settings helpers (A3)
  // -------------------------------------------------------------------------
  /** Open settings at the given category, capturing current focus for later restore. */
  function openSettings(category: 'general' | 'integrations' | 'agent' | 'about' = 'general') {
    focusRestoreEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsView = category;
  }

  /** Exit settings and restore focus to the element active before settings was opened. */
  function exitSettings() {
    settingsView = null;
    if (focusRestoreEl) {
      focusRestoreEl.focus();
      focusRestoreEl = null;
    } else if ($tabList.length === 0) {
      // On the welcome screen: focus the "Open file…" button.
      const btn = document.querySelector<HTMLButtonElement>('.drop .btn-primary');
      btn?.focus();
    }
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
  // Tab close with unsaved-changes guard (#22)
  // -------------------------------------------------------------------------
  /** Close a tab, guarding against losing unsaved edits. Clean tabs close
   *  immediately; dirty tabs raise the styled Save/Discard/Cancel modal. */
  function requestCloseTab(id: string) {
    const tab = $tabList.find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) closing = tab;
    else doCloseTab(id);
  }

  /** Close a tab and release its file watcher in the Rust core (#26). */
  function doCloseTab(id: string) {
    const path = $tabList.find((t) => t.id === id)?.path;
    tabsStore.closeTab(id);
    if (path) void unwatchFile(path).catch(() => {});
  }

  /** Save the pending tab, then close it. Active tabs save through the live
   *  editor (flushes un-debounced keystrokes); a non-active dirty tab's content
   *  is already flushed to the store (EditorPane flushes on unmount). */
  async function handleCloseSave() {
    const tab = closing;
    if (!tab) return;
    let outcome: 'saved' | 'conflict' | 'error' | 'noop';
    if (tab.id === $activeTab?.id && editorRef) {
      outcome = await editorRef.save();
    } else {
      try {
        const res = await saveFile({ path: tab.path, content: tab.content, expected_hash: tab.contentHash });
        tabsStore.markSaved(tab.id, res.content_hash);
        outcome = 'saved';
      } catch (err) {
        const code = (err as IpcError)?.code;
        if (code === 'HASH_MISMATCH') { handleConflict(tab.path); outcome = 'conflict'; }
        else { showToast(`Save failed: ${errMessage(err)}`); outcome = 'error'; }
      }
    }
    closing = null;
    // Only close on a clean save; on conflict/error keep the tab so nothing is lost.
    if (outcome === 'saved') doCloseTab(tab.id);
  }

  function handleCloseDiscard() {
    const tab = closing;
    closing = null;
    if (tab) doCloseTab(tab.id);
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
    busyAction = 'review';
    try {
      const result = await generateReview(sidecar, tab.path);
      const cfg = $settings;
      const template = cfg?.agent_nudge_template || DEFAULT_NUDGE_TEMPLATE;
      const style = cfg?.agent_nudge_path_style ?? 'relative';
      const nudge = buildNudge(template, style, {
        reviewAbs: result.review_path,
        reviewRel: result.review_path_rel,
        docAbs: result.doc_path,
        docRel: result.doc_path_rel,
      });
      try {
        await writeText(nudge);
        showToast(`Review written · nudge copied — paste into your agent`);
      } catch {
        // Clipboard failed (rare): the file is still written, so don't block.
        showToast(`Review written: ${basename(tab.path)}.review.md (clipboard unavailable)`);
      }
    } catch (err) {
      showToast(`Send to agent failed: ${errMessage(err)}`);
    } finally {
      busyAction = null;
    }
  }

  async function handleExportObsidian() {
    const tab = $activeTab;
    if (!tab || busyAction === 'obsidian') return;
    busyAction = 'obsidian';
    // The REST probe can take up to ~3s when Obsidian is unreachable, so give
    // immediate feedback rather than letting the UI look frozen (#29).
    showToast('Exporting to Obsidian…');
    try {
      // D5: read from the eager-loaded settings store (single source of truth)
      // instead of calling getSettings() inline on every export.
      const currentSettings = $settings;
      if (!currentSettings?.vaults.length) {
        showToast('No Obsidian vault configured yet. Open Settings to add one.');
        openSettings('integrations');
        return;
      }
      const res = await exportObsidian({
        doc_path: tab.path,
        vault_path: currentSettings.vaults[0],
        subfolder: currentSettings.default_export_subfolder ?? '',
      });
      showToast(
        res.method === 'rest'
          ? 'Exported to Obsidian (REST).'
          : `Copied to vault: ${basename(res.destination)}`,
      );
    } catch (err) {
      showToast(`Obsidian export failed: ${errMessage(err)}`);
    } finally {
      busyAction = null;
    }
  }

  // -------------------------------------------------------------------------
  // Export document (PDF / HTML) — A8
  // -------------------------------------------------------------------------

  /**
   * Open the ExportDialog (WS-C component).  Called from:
   *   - Toolbar "Export ▾" → "Export document…" item (exportDocument event)
   *   - Palette commands export-pdf / export-html (preset format)
   *
   * The dialog is owned by WS-C (ExportDialog.svelte); this handler only
   * opens it with an optional preset format.  The dialog itself calls
   * exportHtml / exportPdf via the IPC wrappers and fires toasts on result.
   */
  function handleExportDocument(preset: string = '') {
    if (!$activeTab) return;
    exportDialogPreset = preset;
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
    // D5: eager-load settings at app start so the store is populated before
    // any tab or export action runs.  One short IPC round-trip; avoids
    // first-open flicker and the null-state skeleton in the settings panel.
    void loadSettings().then(() => initPreviewZoom());

    const unlisteners: Array<Promise<() => void>> = [];

    // `revenant <file.md>` — cold start (delayed emit) and single-instance.
    // A3: if settings is open when a file open is requested (e.g. dropped on the
    // Dock icon), auto-exit settings so the newly-opened document is visible.
    unlisteners.push(
      listen<string>('open_file_request', (e) => {
        if (settingsView !== null) settingsView = null;
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

  function cycleAnnotation(dir: 1 | -1) {
    const id = cycleAnnotationId($annotationsStore.annotations, $annotationFocus.activeId, dir);
    if (id) {
      drawerOpen = true; // surface the panel so the cycle is visible
      focusAnnotation(id);
    }
  }

  // -------------------------------------------------------------------------
  // Command palette (#9) — actions assembled from the live app state.
  // -------------------------------------------------------------------------
  function annPreview(a: Annotation): string {
    const raw = (a.body || a.quoted_text || '').replace(/\s+/g, ' ').trim();
    return raw.length > 44 ? `${raw.slice(0, 44)}…` : raw || 'comment';
  }

  function buildCommands(): Command[] {
    const cmds: Command[] = [];
    cmds.push({
      id: 'open', title: 'Open file…', section: 'File', hint: `${mod}O`,
      keywords: 'open document markdown', run: () => void handleOpenFile(),
    });
    // Settings deep-link commands — available even from the welcome screen (first-run setup).
    // A4: three per-category commands replace the old single "Settings…" entry.
    cmds.push({
      id: 'settings-general', title: 'Settings: General', section: 'File', hint: `${mod},`,
      keywords: 'preferences configuration appearance theme',
      run: () => openSettings('general'),
    });
    cmds.push({
      id: 'settings-integrations', title: 'Settings: Integrations', section: 'File',
      keywords: 'obsidian vault key rest api integration',
      run: () => openSettings('integrations'),
    });
    cmds.push({
      id: 'settings-about', title: 'Settings: About', section: 'File',
      keywords: 'about version updates release',
      run: () => openSettings('about'),
    });
    cmds.push({
      id: 'shortcuts', title: 'Keyboard shortcuts', section: 'Help',
      keywords: 'help keys cheat sheet reference bindings', run: () => (shortcutsOpen = true),
    });

    if (!$activeTab) return cmds;

    // View
    cmds.push({ id: 'view-source', title: 'View: Source', section: 'View', hint: `${mod}1`, keywords: 'editor code', run: () => (viewMode = 'source') });
    cmds.push({ id: 'view-split', title: 'View: Split', section: 'View', hint: `${mod}2`, keywords: 'editor preview side by side', run: () => (viewMode = 'split') });
    cmds.push({ id: 'view-preview', title: 'View: Preview', section: 'View', hint: `${mod}3`, keywords: 'rendered markdown', run: () => (viewMode = 'preview') });
    cmds.push({
      id: 'toggle-drawer',
      title: drawerOpen ? 'Hide annotation panel' : 'Show annotation panel',
      section: 'View', hint: `${mod}\\`, keywords: 'comments drawer sidebar',
      run: () => (drawerOpen = !drawerOpen),
    });

    // Review
    cmds.push({ id: 'generate-review', title: 'Generate review', section: 'Review', hint: `${mod}⇧R`, keywords: 'export markdown comments report', run: () => void handleGenerateReview() });
    cmds.push({ id: 'export-obsidian', title: 'Export to Obsidian', section: 'Review', keywords: 'vault note publish', run: () => void handleExportObsidian() });
    cmds.push({ id: 'export-pdf', title: 'Export as PDF', section: 'Review', keywords: 'pdf export save download print', run: () => handleExportDocument('pdf') });
    cmds.push({ id: 'export-html', title: 'Export as HTML', section: 'Review', keywords: 'html export save download web', run: () => handleExportDocument('html') });

    // Comments
    const navigable = $annotationsStore.annotations.filter(
      (a) => a.status === 'anchored' || a.status === 'block_level',
    );
    if (navigable.length) {
      cmds.push({ id: 'next-comment', title: 'Next comment', section: 'Comments', hint: isMac ? '⌥↓' : 'Alt↓', keywords: 'annotation navigate cycle', run: () => cycleAnnotation(1) });
      cmds.push({ id: 'prev-comment', title: 'Previous comment', section: 'Comments', hint: isMac ? '⌥↑' : 'Alt↑', keywords: 'annotation navigate cycle', run: () => cycleAnnotation(-1) });
      for (const a of navigable) {
        cmds.push({
          id: `jump-${a.id}`, title: `Jump to: ${annPreview(a)}`, section: 'Comments',
          keywords: `${a.quoted_text} ${a.body}`,
          run: () => { drawerOpen = true; focusAnnotation(a.id); },
        });
      }
    }

    // Tabs
    const tabs = $tabList;
    if (tabs.length > 1) {
      for (const t of tabs) {
        if (t.id === $activeTab?.id) continue;
        cmds.push({ id: `tab-${t.id}`, title: `Switch to: ${basename(t.path)}`, section: 'Tabs', keywords: t.path, run: () => tabsStore.switchTab(t.id) });
      }
    }
    cmds.push({
      id: 'close-tab', title: 'Close current tab', section: 'Tabs',
      keywords: 'tab close', run: () => { const id = $activeTab?.id; if (id) requestCloseTab(id); },
    });

    return cmds;
  }

  const paletteCommands = $derived.by(buildCommands);

  function handleGlobalKeydown(e: KeyboardEvent) {
    // A3: Esc exits settings, but only when no overlay (palette/shortcuts) is
    // open on top of settings.  CommandPalette and KeyboardShortcutsModal handle
    // their own Esc internally but do NOT stopPropagation, so one keydown would
    // reach this handler on the same event.  The !paletteOpen && !shortcutsOpen
    // guard ensures settings is closed only by a "bare" Esc that isn't already
    // consumed by an overlay.
    if (settingsView !== null && !paletteOpen && !shortcutsOpen && e.key === 'Escape') {
      e.preventDefault();
      exitSettings();
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    // Palette + open + settings work even from the welcome screen, so they run
    // before the "no document open" guard below.
    if (!e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); paletteOpen = !paletteOpen; return; }
      if (k === 'o') { e.preventDefault(); void handleOpenFile(); return; }
      // ⌘, / Ctrl+, — open Settings (A3). Must run before the no-tabs guard
      // so settings are reachable before any file is open (first-run).
      if (e.key === ',') { e.preventDefault(); openSettings('general'); return; }
    }
    if ($tabList.length === 0) return;
    // ⌘⌥ combos — keyboard navigation of annotations (#16). ⌘⌥M (add comment on
    // selection, #10) is handled in the focused pane, not here.
    if (e.altKey) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cycleAnnotation(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cycleAnnotation(-1); }
      return;
    }
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
  {#if settingsView !== null}
    <!-- A2: Settings is the outermost render branch — overlays both welcome and
         workspace while tab/document state stays alive in the stores. The
         fade/slide transition respects --dur-* / --ease-* (auto-zero when
         prefers-reduced-motion is set, per tokens.css line 202). -->
    <SettingsPage
      category={settingsView}
      on:close={exitSettings}
    />
  {:else if $tabList.length === 0}
    <!-- Welcome / empty state (C11) -->
    <div class="welcome" role="region" aria-label="Welcome">
      <div class="welcome-top">
        <!-- D1: gear button so Settings is reachable before any file is open.
             Placed beside ThemeToggle in the top-right cluster. -->
        <button
          class="icon-btn welcome-gear"
          type="button"
          title="Settings"
          aria-label="Open settings"
          onclick={() => openSettings('general')}
        >
          <!-- Gear icon — matches the toolbar Settings button. -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
        </button>
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
        busy={busyAction}
        on:viewMode={(e) => (viewMode = e.detail.mode)}
        on:generateReview={handleGenerateReview}
        on:exportObsidian={handleExportObsidian}
        on:exportDocument={(e) => handleExportDocument(e.detail?.preset ?? '')}
        on:toggleDrawer={() => (drawerOpen = !drawerOpen)}
        on:openPalette={() => (paletteOpen = true)}
        on:openShortcuts={() => (shortcutsOpen = true)}
        on:openSettings={() => openSettings('general')}
      />

      <TabManager on:close={(e) => requestCloseTab(e.detail.id)} />

      <div class="ws-body">
        <div class="panes view-{viewMode}" bind:this={panesEl} style="--split-editor: {splitEditorFrac * 100}%">
          {#if $activeTab}
            {#key $activeTab.id}
              {#if viewMode === 'source' || viewMode === 'split'}
                <div class="pane editor-wrap">
                  <EditorPane
                    bind:this={editorRef}
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
                  <!-- Editor→preview scroll sync is disabled pending #34 (section
                       anchoring drifts ~a section). PreviewPane keeps the dormant
                       machinery; re-enabling = pass scrollLine + re-add the
                       EditorPane scroll emit. -->
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
        <!--
          The bar itself is NOT a live region: line/comment counts change on every
          keystroke and would otherwise be re-announced constantly. Only the
          save-state indicator below is role="status" so saved/unsaved transitions
          (the one status change worth announcing) reach assistive tech.
        -->
        <div class="ws-status" aria-label="Document status">
          <span
            class="st-save"
            class:dirty={$activeTab.dirty}
            role="status"
            title={$activeTab.dirty ? 'Unsaved changes' : 'All changes saved'}
          >
            <span class="st-dot" aria-hidden="true"></span>
            {$activeTab.dirty ? 'Unsaved' : 'Saved'}
          </span>
          <span class="st-path" title={$activeTab.path}>{homeAbbrev($activeTab.path)}</span>
          <span>{$activeTab.content.split('\n').length} lines</span>
          <span>{$annotationsStore.annotations.length} comments</span>
          <span class="spacer"></span>
          {#if viewMode === 'preview' || viewMode === 'split'}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <span
              class="st-zoom"
              ondblclick={() => resetZoom()}
              title="Preview zoom — double-click to reset"
            >
              <svg class="st-zoom-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" /><path d="M10.2 10.2 13.5 13.5" />
              </svg>
              <input
                type="range"
                class="st-zoom-slider"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={$previewZoom}
                oninput={(e) => setZoom(parseInt(e.currentTarget.value, 10))}
                aria-label="Preview zoom level"
              />
              <span class="st-zoom-pct">{$previewZoom}%</span>
            </span>
          {/if}
          <span>Markdown</span>
          <span>UTF-8</span>
        </div>
      {/if}
    </div>
  {/if}

  <!--
    ExportDialog (WS-C) — App-level z-index; open when exportDialogPreset is non-null.
    Adapters thread readFileBytes (WS-A IPC wrapper) through buildExportDocument so
    relative image paths are resolved by the Rust core against the doc directory.
  -->
  <ExportDialog
    open={exportDialogPreset !== null}
    preset={exportDialogPreset ?? ''}
    docPath={$activeTab?.path ?? ''}
    content={$activeTab?.content ?? ''}
    annotations={$annotationsStore.annotations}
    generalNotes={$annotationsStore.generalNotes}
    buildExportDocument={(opts) => buildExportDocument({ ...opts, readFileBytes })}
    exportHtml={exportHtml}
    exportPdf={exportPdf}
    on:close={() => (exportDialogPreset = null)}
  />

  <ConflictModal open={conflict.open} filePath={conflict.path} on:reload={handleReload} on:keepMine={handleKeepMine} />

  <!-- Unsaved-changes guard on tab close (#22) — Save / Discard / Cancel. -->
  <UnsavedChangesModal
    open={closing !== null}
    filePath={closing?.path ?? ''}
    on:save={handleCloseSave}
    on:discard={handleCloseDiscard}
    on:cancel={() => (closing = null)}
  />

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

  <!-- ⌘K command palette (#9) — keyboard launcher over all app actions. -->
  <CommandPalette bind:open={paletteOpen} commands={paletteCommands} />

  <!-- Keyboard-shortcut reference (#25) — opened from the palette or toolbar "?". -->
  <KeyboardShortcutsModal open={shortcutsOpen} on:close={() => (shortcutsOpen = false)} />

  <!-- SettingsPage is rendered in the outermost {#if settingsView !== null} branch above (A2). -->

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
  .welcome-top { width: 100%; display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding: 18px 22px; }

  /* D1 — gear button in the welcome-top cluster beside ThemeToggle. */
  .welcome-gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-sm, 4px);
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    transition: color var(--dur-fast, 100ms), background var(--dur-fast, 100ms);
  }
  .welcome-gear:hover { color: var(--text); background: var(--surface-2, var(--surface)); }
  .welcome-gear svg { width: 17px; height: 17px; }
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

  /* Status-bar zoom slider (visible in preview/split modes) */
  .ws-status .st-zoom {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: default;
  }
  .ws-status .st-zoom-icon {
    width: 12px;
    height: 12px;
    flex: none;
    opacity: .7;
  }
  .ws-status .st-zoom-slider {
    width: 80px;
    height: 3px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .ws-status .st-zoom-pct {
    min-width: 3.2ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
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
