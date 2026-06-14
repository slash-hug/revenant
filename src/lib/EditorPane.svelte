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
  import { annotationFocus, focusAnnotation, hoverAnnotation, setAnchorRect } from './stores/annotationFocus';
  import { findSpan } from './annotationHighlight';

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

  /** Replace the hovered annotation id inside the CM6 state. */
  const setHoverAnnotationEffect = StateEffect.define<string | null>();

  // ---------------------------------------------------------------------------
  // Seal GutterMarker
  // ---------------------------------------------------------------------------

  /** A droplet-shaped annotation seal rendered in the editor gutter. */
  class SealMarker extends GutterMarker {
    annotationId: string;
    isActive: boolean;
    lineNumber: number;

    constructor(annotationId: string, isActive: boolean, lineNumber: number) {
      super();
      this.annotationId = annotationId;
      this.isActive = isActive;
      this.lineNumber = lineNumber;
    }

    override toDOM() {
      const el = document.createElement('span');
      el.className = 'cm-seal-marker' + (this.isActive ? ' cm-seal-active' : '');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `Annotation on line ${this.lineNumber}`);
      // D-RISK-2: do NOT add tabindex in this round — defer to follow-up issue.
      // Droplet-in-a-ring seal matching the preview gutter (AnnotationSeals.svelte).
      el.innerHTML =
        '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
        '<circle class="s-fill" cx="10" cy="10" r="9"/>' +
        '<circle class="s-ring" cx="10" cy="10" r="8.5" stroke-width="1.5" fill="none"/>' +
        '<path class="s-drop" d="M10 5.5 C10 5.5 7 9 7 11.2 A3 3 0 0 0 13 11.2 C13 9 10 5.5 10 5.5Z"/>' +
        '</svg>';
      // Hover preview (mirrors the preview seal): faint brush on the hovered span.
      const id = this.annotationId;
      el.addEventListener('mouseenter', () => hoverAnnotation(id));
      el.addEventListener('mouseleave', () => hoverAnnotation(null));
      return el;
    }

    override eq(other: GutterMarker): boolean {
      return (
        other instanceof SealMarker &&
        other.annotationId === this.annotationId &&
        other.isActive === this.isActive &&
        other.lineNumber === this.lineNumber
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Combined state for gutter markers + wash decorations
  // ---------------------------------------------------------------------------

  interface AnnotationCmState {
    annotations: Annotation[];
    activeId: string | null;
    hoverId: string | null;
  }

  /**
   * Resolve an annotation to a concrete document offset range.
   *
   * Anchors created from the PREVIEW store a coarse source position (the block's
   * source line + char 0..quoted_text.length) that does NOT point at the real
   * source location of the quoted words. So we prefer a text-search for
   * quoted_text (starting at/after line_start, wrapping to the doc start) and fall
   * back to the stored line/char range only when there's no quoted text.
   */
  function resolveAnnotationDocRange(
    doc: EditorState['doc'],
    ann: Annotation,
  ): { from: number; to: number } | null {
    const q = ann.quoted_text;
    if (q) {
      // Whitespace- AND markdown-tolerant search: the rendered quoted_text has
      // spaces where the source has newlines, and no backticks/asterisks where the
      // source has inline markdown. findSpan normalizes both so the source span is
      // found even for multi-line / formatted selections.
      const span = findSpan(doc.toString(), q, true);
      if (span) return span;
    }
    // Fallback: stored line/char offsets.
    const startLineNum = ann.line_start + 1;
    const endLineNum = ann.line_end + 1;
    if (startLineNum < 1 || startLineNum > doc.lines) return null;
    if (endLineNum < 1 || endLineNum > doc.lines) return null;
    const startLine = doc.line(startLineNum);
    const endLine = doc.line(endLineNum);
    const from = startLine.from + Math.min(ann.char_start, startLine.length);
    const to = endLine.from + Math.min(ann.char_end, endLine.length);
    return from < to ? { from, to } : null;
  }

  /**
   * Build a RangeSet<SealMarker> from the annotation list.
   * Each anchored/block_level annotation gets a seal on the line where its quoted
   * text actually lives (resolveAnnotationDocRange), deduped one-per-line.
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
    // Resolve each to a line position, deduping to one seal per line (active wins).
    const byLine = new Map<number, { ann: Annotation; active: boolean }>();
    for (const ann of active) {
      const range = resolveAnnotationDocRange(doc, ann);
      if (!range) continue;
      const linePos = doc.lineAt(range.from).from;
      const isActive = ann.id === activeId;
      const existing = byLine.get(linePos);
      if (!existing || isActive) {
        byLine.set(linePos, { ann, active: isActive || (existing?.active ?? false) });
      }
    }
    // RangeSetBuilder requires ascending positions.
    for (const pos of [...byLine.keys()].sort((a, b) => a - b)) {
      const { ann, active: isActive } = byLine.get(pos)!;
      builder.add(pos, pos, new SealMarker(ann.id, isActive, doc.lineAt(pos).number));
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
    hoverId: string | null,
  ): DecorationSet {
    // Paint the active span (full brush) and, if different, the hovered span
    // (faint brush) — mirrors the preview's active/hover wash.
    const washable = (id: string | null): { from: number; to: number } | null => {
      if (!id) return null;
      const ann = annotations.find((a) => a.id === id);
      if (!ann || (ann.status !== 'anchored' && ann.status !== 'block_level')) return null;
      try {
        const range = resolveAnnotationDocRange(doc, ann);
        return range && range.from < range.to ? range : null;
      } catch {
        return null;
      }
    };

    const activeRange = washable(activeId);
    const hoverRange = hoverId && hoverId !== activeId ? washable(hoverId) : null;

    // RangeSetBuilder requires ascending starts — collect, sort, then add.
    const marks: { from: number; to: number; cls: string }[] = [];
    if (activeRange) marks.push({ ...activeRange, cls: 'cm-annotation-wash' });
    if (hoverRange) marks.push({ ...hoverRange, cls: 'cm-annotation-wash cm-annotation-wash--hover' });
    marks.sort((a, b) => a.from - b.from);

    const builder = new RangeSetBuilder<Decoration>();
    for (const m of marks) builder.add(m.from, m.to, Decoration.mark({ class: m.cls }));
    return builder.finish();
  }

  /**
   * The CM6 StateField holding annotation focus state.
   * Present in the initial EditorState.create extensions array (D12).
   */
  const annotationCmField = StateField.define<AnnotationCmState>({
    create() {
      return { annotations: [], activeId: null, hoverId: null };
    },
    update(state, tr) {
      let { annotations, activeId, hoverId } = state;
      for (const effect of tr.effects) {
        if (effect.is(setAnnotationsEffect)) annotations = effect.value;
        if (effect.is(setActiveAnnotationEffect)) activeId = effect.value;
        if (effect.is(setHoverAnnotationEffect)) hoverId = effect.value;
      }
      return { annotations, activeId, hoverId };
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
      click(view, line, _event) {
        const { annotations } = view.state.field(annotationCmField);
        // Match by the seal's RESOLVED line (the quoted-text line), the same way
        // buildGutterMarkers places it — not the raw line_start, which can differ
        // for preview-created anchors.
        const clickedLine = view.state.doc.lineAt(line.from).number; // 1-indexed
        const ann = annotations.find((a) => {
          if (a.status !== 'anchored' && a.status !== 'block_level') return false;
          const range = resolveAnnotationDocRange(view.state.doc, a);
          return range != null && view.state.doc.lineAt(range.from).number === clickedLine;
        });
        if (!ann) return false;
        // Just set focus. In split/preview view the PreviewPane measures the span
        // and anchors the popover (avoids a distracting jump from gutter→preview);
        // in source-only view the focus subscription below anchors it from the
        // line coords. Either way we never anchor to the gutter marker.
        focusAnnotation(ann.id);
        return true;
      },
    },
  });

  /** Extension: wash decoration set derived from the annotationCmField.
   *  Background mark decorations naturally render beneath CM6's native selection,
   *  so no Prec.lowest wrapping is required (Prec is not imported here). */
  const annotationWashExt: Extension = EditorView.decorations.of(
    (view) => {
      const { annotations, activeId, hoverId } = view.state.field(annotationCmField);
      return buildWashDecorations(view.state.doc, annotations, activeId, hoverId);
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
  // Mirror of the content currently in the editor's doc, so the external-change
  // sync below can compare against a tracked string instead of materializing the
  // whole CodeMirror rope via doc.toString() on every reactive run (perf #1b).
  let lastSyncedContent = content;
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
          {
            // ⌘⌥M → add a comment on the current selection (keyboard path for the
            // "+ Add comment" affordance; #10). No-op when the selection is empty.
            key: 'Mod-Alt-m',
            preventDefault: true,
            run: (view) => {
              if (view.state.selection.main.empty) return false;
              handleSelectionChange(view); // rebuild the anchor from the live selection
              handleAddCommentClick();     // dispatch addAnnotation → opens the composer
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
            width: '20px',
            cursor: 'pointer',
          },
          '.cm-seal-marker': {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            transition: 'transform var(--dur-fast)',
          },
          '.cm-seal-marker svg': { width: '14px', height: '14px', overflow: 'visible' },
          '.cm-seal-marker .s-fill': { fill: 'transparent', transition: 'fill var(--dur-fast)' },
          '.cm-seal-marker .s-ring': { stroke: 'var(--seal-ink)', opacity: '0.7' },
          '.cm-seal-marker .s-drop': { fill: 'var(--seal-ink)', opacity: '0.8' },
          '.cm-seal-marker:hover': { transform: 'scale(1.1)' },
          '.cm-seal-marker:hover .s-ring, .cm-seal-marker:hover .s-drop': { opacity: '1' },
          '.cm-seal-active .s-fill': { fill: 'var(--seal-ink)' },
          '.cm-seal-active .s-ring': { opacity: '1' },
          '.cm-seal-active .s-drop': { fill: 'var(--seal-on)', opacity: '1' },
          '.cm-annotation-wash': {
            // Source view: the same brush stroke as the preview, drawn as an SVG
            // background image under the words (a real overlay isn't practical
            // inside CodeMirror). Stretches to the span width; sits at the baseline.
            backgroundImage: 'var(--ann-brush-img)',
            backgroundRepeat: 'no-repeat',
            backgroundSize: '100% 0.42em',
            backgroundPosition: 'left bottom',
            paddingBottom: '0.05em',
          },
          // Hover preview = the faint brush (must follow the base rule to win).
          '.cm-annotation-wash--hover': {
            backgroundImage: 'var(--ann-brush-img-faint)',
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
    // Gate the dispatch on activeId actually changing to avoid a CM6 transaction
    // on every hoverId update (hovering preview seals would otherwise fire one
    // per hover — harmless but wasteful).
    let lastActiveId: string | null = null;
    let lastHoverId: string | null = null;
    let lastScrollNonce = -1;
    unsubFocus = annotationFocus.subscribe((s) => {
      if (!view) return;
      // Dispatch effects only when the relevant id actually changes.
      if (s.activeId !== lastActiveId) {
        lastActiveId = s.activeId;
        view.dispatch({ effects: [setActiveAnnotationEffect.of(s.activeId)] });
      }
      if (s.hoverId !== lastHoverId) {
        lastHoverId = s.hoverId;
        view.dispatch({ effects: [setHoverAnnotationEffect.of(s.hoverId)] });
      }
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
            // In source-only view the preview isn't mounted, so nothing else
            // anchors the popover — do it here from the quoted text's coords.
            if (!document.querySelector('.preview-content')) {
              requestAnimationFrame(() => {
                if (!view) return;
                const range = resolveAnnotationDocRange(view.state.doc, ann);
                const fromPos = range ? range.from : line.from;
                const start = view.coordsAtPos(fromPos);
                const end = range ? view.coordsAtPos(range.to) : start;
                if (!start) return;
                const right = end ? end.right : start.right;
                setAnchorRect({
                  x: start.left,
                  y: start.top,
                  width: Math.max(0, right - start.left),
                  height: start.bottom - start.top,
                  bottom: start.bottom,
                });
              });
            }
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

  // Sync the content prop → editor when it changes EXTERNALLY (file reload, tab
  // content set). The editor's own edits update `content` via the debounced
  // scheduleChange (which also advances lastSyncedContent), so those match and
  // don't trigger a replace. Comparing against lastSyncedContent avoids
  // re-stringifying the whole doc on every reactive run (perf #1b).
  $: if (view && content !== lastSyncedContent) {
    lastSyncedContent = content;
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
      // This is our own edit — record it so the resulting content-prop update
      // is recognised as already-synced and doesn't trigger a doc replace (#1b).
      lastSyncedContent = newContent;
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
