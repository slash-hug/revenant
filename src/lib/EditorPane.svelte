<script lang="ts">
  /**
   * EditorPane.svelte — CodeMirror 6 markdown source editor.
   *
   * Decisions implemented:
   *  - C1  CodeMirror 6 markdown mode, debounced change events, Ctrl/Cmd+S → save.
   *  - C8  Source-side selection → floating "Add comment" affordance → annotation
   *        anchor. The selection range is forwarded to the parent via dispatch.
   *  - A10 Editor anchoring produces precise line/char anchors (SourceAnchor).
   *        The source-map interface for preview anchoring is established here as
   *        a passed-through store (PreviewPane feeds block-id → source-line mapping).
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import {
    EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { tabsStore } from './stores/tabs';
  import { saveFile } from './types/ipc';
  import type { SourceAnchor, AnchorV1, IpcError } from './types/ipc';

  // Editor chrome themed off the design tokens (resolves live with light/dark).
  const rvTheme = EditorView.theme({
    '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.95' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0 64px' },
    '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--text-faint)', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 18px', minWidth: '46px' },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 3.5%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-2)', color: 'var(--text-muted)', border: 'none' },
  });

  const rvHighlight = HighlightStyle.define([
    { tag: t.heading, color: 'var(--syn-heading)', fontWeight: '600' },
    { tag: t.strong, fontWeight: '600', color: 'var(--text)' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: [t.link, t.url], color: 'var(--accent-text)' },
    { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
    { tag: [t.monospace, t.string], color: 'var(--syn-string)' },
    { tag: t.list, color: 'var(--accent)' },
    { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--syn-punct)' },
    { tag: [t.meta, t.comment], color: 'var(--syn-comment)' },
    { tag: t.keyword, color: 'var(--syn-key)' },
  ]);

  /** The active tab id we are editing. */
  export let tabId: string;
  /** The document content (set externally on tab switch). */
  export let content: string = '';
  /** The path for save — displayed in tooltips. */
  export let filePath: string = '';

  const dispatch = createEventDispatcher<{
    /** Fired on every debounced change; payload is the new content string. */
    change: { content: string };
    /** Fired after a successful save; payload is the new content hash. */
    saved: { newHash: string };
    /**
     * Fired when a save was rejected because the file changed on disk since we
     * last read it (HASH_MISMATCH). The parent opens the conflict modal — the
     * save is NOT applied, so nothing is silently clobbered (A5/C12).
     */
    conflict: { filePath: string };
    /** Fired when a save failed for a non-conflict reason (I/O, permissions). */
    saveError: { message: string };
    /** Fired when user triggers "Add comment" from a selection. Carries the
     *  selection's viewport coordinates + quoted text so the parent can anchor
     *  the styled composer popover there. */
    addAnnotation: { anchor: AnchorV1; x: number; y: number; quoted: string };
  }>();

  let editorEl: HTMLDivElement;
  let view: EditorView | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 400;

  // -------------------------------------------------------------------------
  // "Add comment" floating affordance state
  // -------------------------------------------------------------------------
  let showAddComment = false;
  let addCommentX = 0;
  let addCommentY = 0;
  let selViewX = 0; // selection coords in viewport space, for the composer popover
  let selViewY = 0;
  let pendingAnchor: AnchorV1 | null = null;

  // -------------------------------------------------------------------------
  // CodeMirror setup
  // -------------------------------------------------------------------------

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        markdown(),
        syntaxHighlighting(rvHighlight),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            // Ctrl/Cmd+S → save
            key: 'Mod-s',
            run: () => {
              void handleSave();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            scheduleChange();
          }
          if (update.selectionSet) {
            handleSelectionChange(update.view);
          }
        }),
        rvTheme,
      ],
    });

    view = new EditorView({ state, parent: editorEl });
  });

  onDestroy(() => {
    view?.destroy();
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  // Sync content prop → editor when it changes externally (tab switch).
  $: if (view && content !== view.state.doc.toString()) {
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Change debounce
  // -------------------------------------------------------------------------

  function scheduleChange() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const newContent = view?.state.doc.toString() ?? '';
      tabsStore.updateContent(tabId, newContent);
      dispatch('change', { content: newContent });
    }, DEBOUNCE_MS);
  }

  // -------------------------------------------------------------------------
  // Save (Ctrl/Cmd+S)
  // -------------------------------------------------------------------------

  async function handleSave() {
    if (!view || !filePath) return;

    // Flush any pending debounced change first: Mod-s can fire within DEBOUNCE_MS
    // of a keystroke, before scheduleChange() has pushed the latest buffer into
    // the store. Without this we'd persist stale content and briefly mark the
    // tab clean against the wrong hash.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    tabsStore.updateContent(tabId, view.state.doc.toString());

    const snapshot = tabsStore.snapshot;
    const tab = snapshot.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    try {
      // The Rust save_file returns a FileResult (with content_hash) on success
      // and THROWS IpcError{code:"HASH_MISMATCH"} on an optimistic-concurrency
      // conflict — it never returns a {conflict} object. Use the typed wrapper
      // and read content_hash (not new_hash).
      const result = await saveFile({
        path: filePath,
        content: tab.content,
        expected_hash: tab.contentHash,
      });
      tabsStore.markSaved(tabId, result.content_hash);
      dispatch('saved', { newHash: result.content_hash });
    } catch (err) {
      const code = (err as IpcError)?.code;
      if (code === 'HASH_MISMATCH') {
        // The file changed on disk since we opened it. Do NOT clobber — hand off
        // to the conflict modal so the user picks Reload vs Keep mine (A5/C12).
        dispatch('conflict', { filePath });
      } else {
        const message = (err as IpcError)?.message ?? String(err);
        console.error('[EditorPane] save failed:', err);
        dispatch('saveError', { message });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Selection → "Add comment" affordance (C8 / A10)
  // -------------------------------------------------------------------------

  function handleSelectionChange(editorView: EditorView) {
    const sel = editorView.state.selection.main;
    if (sel.empty) {
      showAddComment = false;
      pendingAnchor = null;
      return;
    }

    // Build a SourceAnchor from the current selection.
    const doc = editorView.state.doc;
    const from = sel.from;
    const to = sel.to;

    const startLine = doc.lineAt(from);
    const endLine = doc.lineAt(to);

    // CodeMirror line.number is 1-based; the IPC contract stores 0-indexed lines.
    const anchor: SourceAnchor = {
      start_line: startLine.number - 1,
      start_char: from - startLine.from,
      end_line: endLine.number - 1,
      end_char: to - endLine.from,
      quoted_text: doc.sliceString(from, to),
      context_before: startLine.number > 1
        ? doc.line(startLine.number - 1).text
        : '',
      context_after: endLine.number < doc.lines
        ? doc.line(endLine.number + 1).text
        : '',
    };

    pendingAnchor = { type: 'source', anchor };

    // Position the affordance near the selection end.
    try {
      const coords = editorView.coordsAtPos(to);
      if (coords) {
        const rect = editorEl.getBoundingClientRect();
        addCommentX = coords.right - rect.left;
        addCommentY = coords.bottom - rect.top;
        selViewX = coords.right;
        selViewY = coords.bottom;
        showAddComment = true;
      }
    } catch {
      showAddComment = false;
    }
  }

  function handleAddCommentClick() {
    if (pendingAnchor) {
      dispatch('addAnnotation', {
        anchor: pendingAnchor,
        x: selViewX,
        y: selViewY,
        quoted: pendingAnchor.anchor.quoted_text,
      });
      showAddComment = false;
    }
  }
</script>

<div class="editor-pane" bind:this={editorEl} role="textbox" aria-label="Markdown editor" aria-multiline="true">
  <!-- CodeMirror mounts here -->
</div>

{#if showAddComment}
  <div
    class="add-comment-affordance"
    style="left: {addCommentX}px; top: {addCommentY + 4}px;"
    role="tooltip"
  >
    <button class="add-comment-btn" on:click={handleAddCommentClick}>
      + Add comment
    </button>
  </div>
{/if}

<style>
  .editor-pane {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: var(--editor-bg);
  }

  .add-comment-affordance {
    position: absolute;
    z-index: var(--z-pop);
    pointer-events: auto;
    transform: translateY(6px);
  }

  .add-comment-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--r-md);
    padding: 6px 11px;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
    box-shadow: var(--shadow-pop);
    white-space: nowrap;
  }
  /* up-pointing arrow toward the selection */
  .add-comment-btn::before {
    content: '';
    position: absolute;
    left: 16px;
    top: -4px;
    width: 9px;
    height: 9px;
    background: var(--accent);
    transform: rotate(45deg);
  }
  .add-comment-btn:hover { background: var(--accent-hover); }
</style>
