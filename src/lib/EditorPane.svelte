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
    gutter, GutterMarker, Decoration,
  } from '@codemirror/view';
  import { EditorState, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
  import type { DecorationSet } from '@codemirror/view';
  import type { Extension } from '@codemirror/state';
  import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags as t } from '@lezer/highlight';
  import { tabsStore } from './stores/tabs';
  import { flushPendingDebounce } from './editor-flush';
  import { saveFile } from './types/ipc';
  import type { SourceAnchor, AnchorV1, IpcError, Annotation } from './types/ipc';
  import { annotationsStore } from './stores/annotations';
  import { annotationFocus, focusAnnotation } from './stores/annotationFocus';

  // -------------------------------------------------------------------------
  // Annotation focus / gutter-seal CM6 integration (T3.1 / D12)
  //
  // Architecture:
  //  - Two StateEffects carry the annotation set and the active annotation id
  //    from the Svelte store world into the CM6 update cycle.
  //  - A single StateField holds the combined state (annotations + activeId)
  //    and derives BOTH the gutter marker RangeSet AND the wash DecorationSet.
  //  - The StateField is in the INITIAL EditorState.create extensions array so
  //    it is always present and reconfigure-free (D12).
  //  - Svelte store subscriptions dispatch effects on change.
  //  - The wash Decoration.mark uses Prec.lowest so CM6's native selection
  //    always renders above it (selection remains readable).
  // -------------------------------------------------------------------------

  /** Replace the current annotation list inside the CM6 state. */
  const setAnnotationsEffect = StateEffect.define<Annotation[]>();

  /** Replace the active annotation id inside the CM6 state. */
  const setActiveAnnotationEffect = StateEffect.define<string | null>();

  // ---------------------------------------------------------------------------
  // Seal GutterMarker
  // ---------------------------------------------------------------------------

  /** A droplet-shaped annotation seal rendered in the editor gutter. */
  class SealMarker extends GutterMarker {
    annotationId: string;
    isActive: boolean;

    constructor(annotationId: string, isActive: boolean) {
      super();
      this.annotationId = annotationId;
      this.isActive = isActive;
    }

    override toDOM() {
      const el = document.createElement('span');
      el.className = 'cm-seal-marker' + (this.isActive ? ' cm-seal-active' : '');
      el.setAttribute('aria-label', 'Annotation');
      // D-RISK-2: do NOT add tabindex in this round — defer to follow-up issue.
      el.textContent = '◆';
      return el;
    }

    override eq(other: GutterMarker): boolean {
      return (
        other instanceof SealMarker &&
        other.annotationId === this.annotationId &&
        other.isActive === this.isActive
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Combined state for gutter markers + wash decorations
  // ---------------------------------------------------------------------------

  interface AnnotationCmState {
    annotations: Annotation[];
    activeId: string | null;
  }

  /**
   * Build a RangeSet<SealMarker> from the annotation list.
   * Each anchored/block_level annotation gets a seal on its `line_start` line.
   * Lines are 0-indexed in Annotation; CM6 doc.line() is 1-indexed.
   */
  function buildGutterMarkers(
    doc: EditorState['doc'],
    annotations: Annotation[],
    activeId: string | null,
  ): ReturnType<RangeSetBuilder<SealMarker>['finish']> {
    const builder = new RangeSetBuilder<SealMarker>();
    // Only anchored and block_level annotations get seals; detached do not.
    const active = annotations.filter(
      (a) => a.status === 'anchored' || a.status === 'block_level',
    );
    // Sort ascending by line so the RangeSetBuilder receives ranges in order.
    const sorted = [...active].sort((a, b) => a.line_start - b.line_start);
    for (const ann of sorted) {
      // line_start is 0-indexed; CM6 doc.line() expects 1-indexed.
      const lineNum = ann.line_start + 1;
      if (lineNum < 1 || lineNum > doc.lines) continue;
      const line = doc.line(lineNum);
      builder.add(line.from, line.from, new SealMarker(ann.id, ann.id === activeId));
    }
    return builder.finish();
  }

  /**
   * Build a DecorationSet washing the active annotation's line/char range.
   * Sits at Prec.lowest so CM6's native selection renders above it.
   */
  function buildWashDecorations(
    doc: EditorState['doc'],
    annotations: Annotation[],
    activeId: string | null,
  ): DecorationSet {
    if (!activeId) return Decoration.none;
    const ann = annotations.find((a) => a.id === activeId);
    if (!ann || (ann.status !== 'anchored' && ann.status !== 'block_level')) {
      return Decoration.none;
    }
    const builder = new RangeSetBuilder<Decoration>();
    try {
      const startLineNum = ann.line_start + 1;
      const endLineNum = ann.line_end + 1;
      if (startLineNum < 1 || startLineNum > doc.lines) return Decoration.none;
      if (endLineNum < 1 || endLineNum > doc.lines) return Decoration.none;
      const startLine = doc.line(startLineNum);
      const endLine = doc.line(endLineNum);
      const from = startLine.from + Math.min(ann.char_start, startLine.length);
      const to = endLine.from + Math.min(ann.char_end, endLine.length);
      if (from >= to) return Decoration.none;
      builder.add(from, to, Decoration.mark({ class: 'cm-annotation-wash' }));
    } catch {
      return Decoration.none;
    }
    return builder.finish();
  }

  /**
   * The CM6 StateField holding annotation focus state.
   * Present in the initial EditorState.create extensions array (D12).
   */
  const annotationCmField = StateField.define<AnnotationCmState>({
    create() {
      return { annotations: [], activeId: null };
    },
    update(state, tr) {
      let { annotations, activeId } = state;
      for (const effect of tr.effects) {
        if (effect.is(setAnnotationsEffect)) annotations = effect.value;
        if (effect.is(setActiveAnnotationEffect)) activeId = effect.value;
      }
      return { annotations, activeId };
    },
  });

  /** Extension: gutter marker set derived from the annotationCmField. */
  const annotationGutterExt: Extension = gutter({
    class: 'cm-annotation-gutter',
    markers(view) {
      const { annotations, activeId } = view.state.field(annotationCmField);
      return buildGutterMarkers(view.state.doc, annotations, activeId);
    },
    domEventHandlers: {
      click(view, line, event) {
        const { annotations, activeId: _active } = view.state.field(annotationCmField);
        // Find the annotation whose line_start maps to this gutter line.
        const lineNum = view.state.doc.lineAt(line.from).number; // 1-indexed
        const ann = annotations.find(
          (a) =>
            (a.status === 'anchored' || a.status === 'block_level') &&
            a.line_start + 1 === lineNum,
        );
        if (!ann) return false;
        focusAnnotation(ann.id);
        // Emit anchor rect for the shared popover (D4): use the clicked element's
        // bounding rect as the popover anchor coordinate.
        const el = event.target as HTMLElement;
        const rect = el.getBoundingClientRect();
        popoverAnchorRect = rect;
        return true;
      },
    },
  });

  /** Extension: wash decoration set derived from the annotationCmField. */
  const annotationWashExt: Extension = EditorView.decorations.of(
    (view) => {
      const { annotations, activeId } = view.state.field(annotationCmField);
      return buildWashDecorations(view.state.doc, annotations, activeId);
    },
  );

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

  // T2.6/C-FLUSH-TABID: snapshot the tab id at mount time so the onDestroy
  // flush uses the correct id even when the prop changes (e.g. rapid tab switch
  // with {#key $activeTab.id} remounting). Each EditorPane instance's tabId
  // prop is stable for its lifetime because {#key} creates a new instance per
  // tab, but we snapshot explicitly for robustness.
  const myTabId = tabId;

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
  // Annotation seal / popover anchor state
  // -------------------------------------------------------------------------
  /** The viewport rect of the last gutter seal that was clicked (for popover placement). */
  let popoverAnchorRect: DOMRect | null = null;

  /** Store unsubscribe handles — cleaned up in onDestroy. */
  let unsubAnnotations: (() => void) | null = null;
  let unsubFocus: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // CodeMirror setup
  // -------------------------------------------------------------------------

  onMount(() => {
    const state = EditorState.create({
      doc: content,
      extensions: [
        // Annotation focus field + gutter + wash — present from creation (D12).
        annotationCmField,
        annotationGutterExt,
        annotationWashExt,
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
        // Seal gutter theme
        EditorView.theme({
          '.cm-annotation-gutter': {
            width: '18px',
            cursor: 'pointer',
          },
          '.cm-seal-marker': {
            display: 'block',
            width: '100%',
            textAlign: 'center',
            fontSize: '9px',
            lineHeight: '1.95',
            color: 'var(--seal-ink)',
            opacity: '0.75',
            transition: 'opacity var(--dur-fast)',
          },
          '.cm-seal-marker:hover': {
            opacity: '1',
          },
          '.cm-seal-active': {
            opacity: '1',
            color: 'var(--seal-ink)',
          },
          '.cm-annotation-wash': {
            backgroundColor: 'color-mix(in srgb, var(--seal-ink, #4A453B) 10%, transparent)',
          },
        }),
      ],
    });

    view = new EditorView({ state, parent: editorEl });

    // Subscribe to the annotation store: push annotation list into CM6 state
    // whenever it changes.
    unsubAnnotations = annotationsStore.subscribe((s) => {
      if (!view) return;
      view.dispatch({
        effects: [setAnnotationsEffect.of(s.annotations)],
      });
    });

    // Subscribe to the focus store: push the active id into CM6 state, and
    // scroll the active line into view whenever scrollNonce changes.
    let lastScrollNonce = -1;
    unsubFocus = annotationFocus.subscribe((s) => {
      if (!view) return;
      // Always sync the active id.
      view.dispatch({
        effects: [setActiveAnnotationEffect.of(s.activeId)],
      });
      // Scroll to the active annotation's line when scrollNonce bumps.
      if (s.scrollNonce !== lastScrollNonce && s.activeId !== null) {
        lastScrollNonce = s.scrollNonce;
        const { annotations } = view.state.field(annotationCmField);
        const ann = annotations.find((a) => a.id === s.activeId);
        if (ann) {
          const lineNum = ann.line_start + 1;
          if (lineNum >= 1 && lineNum <= view.state.doc.lines) {
            const line = view.state.doc.line(lineNum);
            const prefersReducedMotion =
              typeof window !== 'undefined' &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            view.dispatch({
              effects: EditorView.scrollIntoView(line.from, {
                y: 'center',
                yMargin: prefersReducedMotion ? 0 : undefined,
              }),
            });
          }
        }
      }
    });
  });

  onDestroy(() => {
    // T2.6/C-FLUSH-TABID: if a debounce timer is pending, flush the latest
    // editor content to the tab store BEFORE destroying the view, so keystrokes
    // typed within DEBOUNCE_MS of unmount (e.g. rapid tab switch via {#key
    // $activeTab.id}) are not lost. Delegates to the extracted helper so this
    // exact code path can be exercised by unit tests (closes fidelity gap).
    debounceTimer = flushPendingDebounce(debounceTimer, view, myTabId, tabsStore);
    // Unsubscribe from annotation stores before destroying the view.
    unsubAnnotations?.();
    unsubFocus?.();
    view?.destroy();
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
    // context_before / context_after are now derived server-side at save time
    // (T1.2/A2) and are no longer part of the SourceAnchor interface (T1.5/C-IPC-TYPE).
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
