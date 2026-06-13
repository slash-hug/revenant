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
  import { EditorView, keymap } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { invoke } from '@tauri-apps/api/core';
  import { tabsStore } from './stores/tabs';
  import type { SourceAnchor, AnchorV1 } from './types/ipc';

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
    /** Fired when user triggers "Add comment" from a selection. */
    addAnnotation: { anchor: AnchorV1 };
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
  let pendingAnchor: AnchorV1 | null = null;

  // -------------------------------------------------------------------------
  // CodeMirror setup
  // -------------------------------------------------------------------------

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        history(),
        markdown(),
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
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { fontFamily: 'var(--editor-font, "JetBrains Mono", monospace)' },
        }),
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
    const snapshot = tabsStore.snapshot;
    const tab = snapshot.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    try {
      const result = await invoke<{ new_hash: string } | { conflict: true; disk_hash: string }>(
        'save_file',
        {
          path: filePath,
          content: tab.content,
          expected_hash: tab.contentHash,
        }
      );

      if ('new_hash' in result) {
        tabsStore.markSaved(tabId, result.new_hash);
        dispatch('saved', { newHash: result.new_hash });
      }
      // Conflict case: the ConflictModal component handles file_changed events;
      // save_file returning a conflict is surfaced there.
    } catch (err) {
      console.error('[EditorPane] save failed:', err);
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

    const anchor: SourceAnchor = {
      start_line: startLine.number,
      start_char: from - startLine.from,
      end_line: endLine.number,
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
        showAddComment = true;
      }
    } catch {
      showAddComment = false;
    }
  }

  function handleAddCommentClick() {
    if (pendingAnchor) {
      dispatch('addAnnotation', { anchor: pendingAnchor });
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
    overflow: hidden;
  }

  .add-comment-affordance {
    position: absolute;
    z-index: 50;
    pointer-events: auto;
  }

  .add-comment-btn {
    background: var(--accent, #0066cc);
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    white-space: nowrap;
  }

  .add-comment-btn:hover {
    background: var(--accent-dark, #0052a3);
  }
</style>
