<script lang="ts">
  /**
   * PreviewPane.svelte — live markdown preview.
   *
   * Decisions implemented:
   *  - C15 / A8   DOMPurify sanitization via renderMarkdown() in markdown.ts.
   *  - A11        Lazy dynamic import of Mermaid + highlight.js with loading
   *               skeletons and per-block error isolation.
   *  - C7 / A9   Section-anchored best-effort scroll sync. For files above
   *               LARGE_FILE_THRESHOLD, sync degrades and a status indicator
   *               is shown. DOM-removing virtualization deferred to v1.1.
   *  - C8         HTML→source mapping layer: emits block-id → source-line map
   *               upward so EditorPane can use it for preview-side annotation
   *               anchoring. Mermaid/table/footnote blocks degrade to block-level.
   *
   * Props:
   *  - content    : string   — raw markdown source.
   *  - scrollLine : number   — editor scroll position (1-based line number)
   *                            used for section-anchored sync.
   *
   * Events:
   *  - blockMap   : Map<string, number>  — block-id → source-line mapping (C8).
   *  - addAnnotation : { anchor: AnchorV1 }  — preview-side "Add comment" (C8).
   */
  import { onMount, onDestroy, afterUpdate, createEventDispatcher, tick } from 'svelte';
  import './styles/markdown.css';
  import {
    renderMarkdown,
    renderCodeBlock,
    renderMermaid,
    stripFrontmatter,
  } from './render/markdown';
  import type { AnchorV1, BlockAnchor } from './types/ipc';
  import AnnotationSeals from './AnnotationSeals.svelte';
  import {
    annotationFocus,
    clearFocus,
    setAnchorRect,
  } from './stores/annotationFocus';
  import {
    buildRange,
    refreshHighlights,
    clearHighlights,
    isHighlightSupported,
  } from './annotationHighlight';
  import { annotationsStore } from './stores/annotations';
  import { resolveBlock } from './annotationResolve';
  import { nearestLineIndex } from './scrollSync';

  export let content: string = '';
  export let scrollLine: number = 1;

  const dispatch = createEventDispatcher<{
    blockMap: Map<string, number>;
    addAnnotation: { anchor: AnchorV1; x: number; y: number; quoted: string };
  }>();

  // Shortcut hint shown on the "+ Add comment" affordance (#10 discoverability).
  const _isMac = typeof navigator !== 'undefined'
    && (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));
  const addCommentShortcut = _isMac ? '⌘⌥M' : 'Ctrl+Alt+M';

  // "+ Add comment" affordance shown at the selection (mirrors EditorPane).
  let showAddComment = false;
  let pendingAnchor: AnchorV1 | null = null;
  let pendingQuoted = '';
  let btnX = 0;
  let btnY = 0;

  const LARGE_FILE_THRESHOLD = 2000; // lines

  let previewEl: HTMLDivElement | null = null;
  let pvScrollEl: HTMLDivElement | null = null;
  let sealsComponent: AnnotationSeals | null = null;
  let html = '';
  let syncDegraded = false;
  let isHydrating = false;

  // ── ResizeObserver for seal recompute (TRAP 2) ──────────────────────────────
  let resizeObserver: ResizeObserver | null = null;

  // ── annotationFocus subscription (T2.6) ─────────────────────────────────────
  // Repaint the wash whenever the active/hovered annotation changes, and scroll
  // + re-anchor the popover whenever a navigation (scrollNonce bump) occurs.
  let prevScrollNonce = -1;
  let prevActiveId: string | null = null;
  let prevHoverId: string | null = null;
  const unsubFocus = annotationFocus.subscribe((state) => {
    if (state.activeId !== prevActiveId || state.hoverId !== prevHoverId) {
      prevActiveId = state.activeId;
      prevHoverId = state.hoverId;
      refreshAnnotationWash();
    }
    if (state.scrollNonce !== prevScrollNonce && prevScrollNonce !== -1) {
      void scrollToActiveAndAnchor(state.activeId);
    }
    prevScrollNonce = state.scrollNonce;
  });

  // -------------------------------------------------------------------------
  // Frontmatter header
  // -------------------------------------------------------------------------

  interface FrontmatterHeader {
    title?: string;
    author?: string;
    date?: string;
    [key: string]: unknown;
  }

  function parseFrontmatterHeader(src: string): FrontmatterHeader | null {
    const { raw } = stripFrontmatter(src);
    if (!raw) return null;
    // Simple key: value parsing (no full YAML needed for display).
    const pairs: FrontmatterHeader = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\w[\w-]*):\s*(.+)/);
      if (m) pairs[m[1]] = m[2].trim();
    }
    return Object.keys(pairs).length > 0 ? pairs : null;
  }

  $: frontmatterHeader = parseFrontmatterHeader(content);
  $: fmTitle = frontmatterHeader?.title as string | undefined;
  $: fmMeta = frontmatterHeader
    ? Object.entries(frontmatterHeader).filter(([k]) => k !== 'title')
    : [];

  function initials(name: string): string {
    return name.trim().split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase();
  }

  // -------------------------------------------------------------------------
  // Render + hydrate pipeline
  // -------------------------------------------------------------------------

  $: {
    // Sync render (no Mermaid/hljs yet — those are hydrated async after mount).
    html = renderMarkdown(content);
  }

  // afterUpdate fires on EVERY update (focus, scroll, annotations…), but the heavy
  // post-render pipeline (hydrate Mermaid/hljs, rebuild the block-map + scroll
  // index) only matters when the rendered HTML actually changed. Gate it on an
  // html token so typing/focus updates don't re-query + re-hydrate every block
  // (#2 — the dominant per-keystroke cost). Seal recompute still runs every update
  // because annotations can change without the HTML changing.
  let lastHydratedHtml = '';
  afterUpdate(async () => {
    if (!previewEl) return;
    await tick();
    if (html !== lastHydratedHtml) {
      lastHydratedHtml = html;
      await hydrateDynamicBlocks();
      emitBlockMap();
      rebuildScrollIndex(); // sorted line→block index for binary-search scroll-sync (#3)
    }
    // Recompute seal positions after render (D2/D10: stays on afterUpdate).
    triggerSealRecompute();
  });

  /**
   * Hydrate Mermaid placeholders and code blocks with async renderers.
   * Per-block error isolation: a failing block shows an error message and
   * other blocks continue rendering.
   */
  async function hydrateDynamicBlocks() {
    if (!previewEl || isHydrating) return;
    isHydrating = true;

    try {
      // Mermaid placeholders
      const mermaidDivs = previewEl.querySelectorAll<HTMLElement>('[data-mermaid-pending]');
      await Promise.allSettled(
        Array.from(mermaidDivs).map(async (div) => {
          const code = div.textContent ?? '';
          const blockId = div.dataset.blockId ?? '';
          try {
            const svg = await renderMermaid(code, blockId);
            // Keep the source so we can re-render in the other Mermaid theme when
            // the app flips light/dark (the SVG bakes its colors at render time).
            div.setAttribute('data-mermaid-src', encodeURIComponent(code));
            div.innerHTML = svg;
            div.removeAttribute('data-mermaid-pending');
          } catch (err) {
            // Per-block error isolation: show error, don't crash preview.
            div.innerHTML = `<div class="mermaid-error"><strong>Diagram error.</strong></div>`;
            div.removeAttribute('data-mermaid-pending');
          }
        })
      );

      // Code blocks without hljs (lang is in class="language-*")
      const preTags = previewEl.querySelectorAll<HTMLPreElement>('pre:not([data-mermaid-pending]):not([data-hljs-done])');
      await Promise.allSettled(
        Array.from(preTags).map(async (pre) => {
          const code = pre.querySelector('code');
          if (!code) return;
          const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
          const lang = langClass ? langClass.replace('language-', '') : '';
          if (!lang || lang === 'plaintext') return;
          try {
            const highlighted = await renderCodeBlock(code.textContent ?? '', lang);
            const tmp = document.createElement('div');
            tmp.innerHTML = highlighted;
            const newPre = tmp.querySelector('pre');
            if (newPre) {
              // Copy data attributes from original pre
              Array.from(pre.attributes).forEach((attr) => {
                if (attr.name.startsWith('data-')) {
                  newPre.setAttribute(attr.name, attr.value);
                }
              });
              pre.replaceWith(newPre);
            }
            pre.setAttribute('data-hljs-done', '1');
          } catch {
            // Per-block error isolation.
          }
        })
      );
    } finally {
      isHydrating = false;
      // Recompute seals + refresh highlights at the tail of hydration (TRAP 2:
      // Mermaid/hljs hydration is async; compute offsetTop only after SVGs inject).
      triggerSealRecompute();
      refreshAnnotationWash();
    }
  }

  /**
   * Trigger a seal position recompute via the AnnotationSeals component.
   * Safe to call any time; component guards against null containers.
   */
  function triggerSealRecompute() {
    if (sealsComponent) {
      sealsComponent.recompute();
    }
  }

  /**
   * Repaint the inline ink wash. The prose is clean at rest — only the active
   * span (full wash) and the hovered span (faint wash) are painted, via the CSS
   * Custom Highlight API. Feature-detected — no-op on unsupported environments.
   */
  function refreshAnnotationWash() {
    if (!previewEl || !isHighlightSupported()) return;
    const state = $annotationsStore;
    const focusState = $annotationFocus;

    const rangeForId = (id: string | null): Range | null => {
      if (!id) return null;
      const ann = state.annotations.find((a) => a.id === id);
      if (!ann || !ann.quoted_text) return null;
      const blockEl = findBlockForAnnotation(ann);
      if (!blockEl) return null;
      return buildRange(blockEl, ann.quoted_text);
    };

    refreshHighlights(rangeForId(focusState.activeId), rangeForId(focusState.hoverId));
  }

  /**
   * Measure the active annotation's span (or block, for block-level / unfound
   * spans) and publish its viewport rect so AnnotationPopover anchors under the
   * actual words. Runs after a smooth scroll settles (scrollend, with a timeout
   * fallback) so the rect reflects the final on-screen position.
   */
  function anchorPopoverToActive(activeId: string, reduced: boolean) {
    const measure = () => {
      if ($annotationFocus.activeId !== activeId || !previewEl) return; // focus moved on
      const ann = $annotationsStore.annotations.find((a) => a.id === activeId);
      if (!ann) return;
      const blockEl = findBlockForAnnotation(ann);
      if (!blockEl) return;
      let rect: DOMRect | null = null;
      if (ann.quoted_text) {
        const range = buildRange(blockEl, ann.quoted_text);
        if (range) rect = range.getBoundingClientRect();
      }
      if (!rect || rect.width === 0) rect = blockEl.getBoundingClientRect();
      setAnchorRect({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
      });
    };

    if (reduced || !pvScrollEl) { measure(); return; }
    let settled = false;
    const onEnd = () => {
      if (settled) return;
      settled = true;
      pvScrollEl?.removeEventListener('scrollend', onEnd);
      measure();
    };
    pvScrollEl.addEventListener('scrollend', onEnd);
    // Fallback: 'scrollend' may not fire if the element was already in position.
    setTimeout(onEnd, 500);
  }

  /**
   * Find the block element for an annotation.
   * Delegates to the shared resolveBlock helper (annotationResolve.ts) so this
   * always uses the same algorithm as AnnotationSeals — seal and highlight can
   * never disagree about which block an annotation resolves to.
   */
  function findBlockForAnnotation(ann: { status: string; line_start: number; quoted_text: string }): Element | null {
    if (!previewEl) return null;
    return resolveBlock(ann as Parameters<typeof resolveBlock>[0], previewEl);
  }

  /**
   * Scroll the active annotation's block into view, repaint its wash, and anchor
   * the popover under the span (T2.6). Reduced-motion-aware (D2 / §8); does NOT
   * reuse syncScrollToLine's hardcoded smooth behavior.
   */
  async function scrollToActiveAndAnchor(activeId: string | null) {
    if (!activeId || !previewEl) { setAnchorRect(null); return; }

    // Wait one tick so seals/blocks have laid out.
    await tick();

    const ann = $annotationsStore.annotations.find((a) => a.id === activeId);
    if (!ann) return;

    const blockEl = findBlockForAnnotation(ann);
    if (!blockEl) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    blockEl.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });

    // Paint the active wash, then anchor the popover to the span once scroll settles.
    refreshAnnotationWash();
    anchorPopoverToActive(activeId, reduced);
  }

  /**
   * Re-render already-rendered Mermaid diagrams when the app theme flips, so they
   * switch between the light and dark Mermaid themes. Mermaid bakes its colors
   * into the SVG at render time, so a cached diagram keeps its original theme
   * until re-rendered.
   */
  async function reRenderMermaidForTheme() {
    if (!previewEl) return;
    const divs = previewEl.querySelectorAll<HTMLElement>(
      '[data-block-type="mermaid"][data-mermaid-src]',
    );
    if (divs.length === 0) return;
    await Promise.allSettled(
      Array.from(divs).map(async (div) => {
        const code = decodeURIComponent(div.getAttribute('data-mermaid-src') ?? '');
        const blockId = div.dataset.blockId ?? '';
        if (!code) return;
        try {
          div.innerHTML = await renderMermaid(code, blockId);
        } catch { /* keep the current render on failure */ }
      }),
    );
  }

  // Re-theme diagrams on a light/dark switch — covers the manual toggle AND an OS
  // change while in "system" mode, both of which update <html data-theme>.
  onMount(() => {
    const obs = new MutationObserver(() => void reRenderMermaidForTheme());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  });

  // ResizeObserver on .pv-scroll for seal recompute (TRAP 2 / risks).
  // Cleaned up in onDestroy, not conflicting with the MutationObserver above.
  onMount(() => {
    if (!pvScrollEl) return;
    resizeObserver = new ResizeObserver(() => {
      triggerSealRecompute();
    });
    resizeObserver.observe(pvScrollEl);
  });

  // Initialize prevScrollNonce after mount so the subscription doesn't fire
  // spuriously on first render.
  onMount(() => {
    prevScrollNonce = $annotationFocus.scrollNonce;
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (scrollSyncRaf) cancelAnimationFrame(scrollSyncRaf);
    unsubFocus();
    clearHighlights();
    clearFocus();
  });

  /**
   * Build and emit the block-id → source-line map for the C8 source-map layer.
   */
  function emitBlockMap() {
    if (!previewEl) return;
    const map = new Map<string, number>();
    const blocks = previewEl.querySelectorAll<HTMLElement>('[data-block-id][data-source-line]');
    blocks.forEach((el) => {
      const blockId = el.dataset.blockId;
      const sourceLine = parseInt(el.dataset.sourceLine ?? '0', 10);
      if (blockId && sourceLine > 0) {
        map.set(blockId, sourceLine);
      }
    });
    dispatch('blockMap', map);
  }

  // -------------------------------------------------------------------------
  // Scroll sync (C7 / A9 — section-anchored, best-effort)
  // -------------------------------------------------------------------------

  $: {
    const lineCount = content.split('\n').length;
    syncDegraded = lineCount > LARGE_FILE_THRESHOLD;
  }

  // Parallel sorted arrays (lines + elements), rebuilt once per render
  // (rebuildScrollIndex) so scroll-sync is a binary search instead of an
  // O(blocks) linear scan on every editor scroll/cursor move (perf #3).
  let scrollLines: number[] = [];
  let scrollEls: HTMLElement[] = [];
  let scrollSyncRaf = 0;
  let pendingScrollLine = 0;
  // Last editor line we synced the preview to. The sync block below depends on
  // `syncDegraded`, which is reassigned on every `content` re-pass (i.e. any App
  // re-render) — without this guard the block re-fires and yanks the preview back
  // to `scrollLine` even when the editor never moved, so a user scrolling the
  // preview gets snapped to the top. Only sync on a real line change.
  let lastSyncedScrollLine = -1;

  function rebuildScrollIndex() {
    if (!previewEl) { scrollLines = []; scrollEls = []; return; }
    const sorted = Array.from(previewEl.querySelectorAll<HTMLElement>('[data-source-line]'))
      .map((el) => ({ line: parseInt(el.dataset.sourceLine ?? '0', 10), el }))
      .filter((b) => b.line > 0)
      .sort((a, b) => a.line - b.line);
    scrollLines = sorted.map((b) => b.line);
    scrollEls = sorted.map((b) => b.el);
  }

  // Editor→preview scroll sync. DORMANT: `scrollLine` is not currently fed by the
  // parent (disabled pending #34 — section anchoring drifts). The `lastSyncedScrollLine`
  // guard is what keeps it inert: without it, `syncDegraded` reassigning on every
  // content re-pass would re-fire this and yank the preview to the top.
  // rAF-throttle so a future re-enable coalesces continuous scroll to one sync/frame.
  $: if (previewEl && scrollLine > 0 && !syncDegraded && scrollLine !== lastSyncedScrollLine) {
    lastSyncedScrollLine = scrollLine;
    pendingScrollLine = scrollLine;
    if (!scrollSyncRaf) {
      scrollSyncRaf = requestAnimationFrame(() => {
        scrollSyncRaf = 0;
        syncScrollToLine(pendingScrollLine);
      });
    }
  }

  function syncScrollToLine(line: number) {
    if (!previewEl || !pvScrollEl) return;
    const idx = nearestLineIndex(scrollLines, line);
    if (idx < 0) return;
    // Align the matched block to the TOP of the preview so the editor's top
    // visible line and the preview's top line show the same content. ('nearest'
    // would instead snap it to whichever edge is closest — the bottom when
    // scrolling down — leaving the synced line off-screen-low.) Scroll the
    // container directly rather than scrollIntoView so we never scroll ancestors
    // or fight a user mid-gesture in the other pane.
    const el = scrollEls[idx];
    const elRect = el.getBoundingClientRect();
    const cRect = pvScrollEl.getBoundingClientRect();
    const top = pvScrollEl.scrollTop + (elRect.top - cRect.top);
    // Instant, not smooth: continuous editor scrolling fires a sync per line, and
    // a ~300ms smooth animation per step interrupts the previous one — so the
    // preview ends up stranded mid-animation ("hit or miss"). Instant tracking
    // keeps the preview locked to the editor; the editor's own scroll is smooth.
    pvScrollEl.scrollTo({ top, behavior: 'auto' });
  }

  // -------------------------------------------------------------------------
  // Preview-side annotation anchoring (C8 ruling)
  // -------------------------------------------------------------------------

  /**
   * Handle text selection in the preview. Builds a block-level anchor for
   * transformed blocks (Mermaid/table/footnote) or a source anchor via the
   * block-map for regular text.
   */
  function handlePreviewMouseUp() {
    const sel = window.getSelection();
    // A plain click (collapsed selection) dismisses the affordance instead of
    // firing — selecting text to copy must not trigger the comment flow.
    if (!sel || sel.isCollapsed || !previewEl) { showAddComment = false; return; }

    const range = sel.getRangeAt(0);
    if (!previewEl.contains(range.commonAncestorContainer)) { showAddComment = false; return; }

    const quotedText = sel.toString();

    // Walk up to find the nearest block with data-block-id and build an anchor.
    let anchor: AnchorV1 | null = null;
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== previewEl) {
      if (node instanceof HTMLElement) {
        const blockId = node.dataset.blockId;
        const blockType = node.dataset.blockType;
        if (blockId) {
          // Transformed blocks → block-level anchor (C8 degradation rule).
          if (blockType === 'mermaid' || blockType === 'table') {
            const blockAnchor: BlockAnchor = {
              block_id: blockId,
              block_type: blockType as BlockAnchor['block_type'],
              quoted_text: quotedText,
            };
            anchor = { type: 'block', anchor: blockAnchor };
            break;
          }
          // Regular block: coarse source anchor from the data-source-line.
          const sourceLine = parseInt(node.dataset.sourceLine ?? '0', 10);
          if (sourceLine > 0) {
            anchor = {
              type: 'source',
              anchor: {
                start_line: sourceLine,
                start_char: 0,
                end_line: sourceLine,
                end_char: quotedText.length,
                quoted_text: quotedText,
                // context_before / context_after removed (T1.5/C-IPC-TYPE)
                // — context is derived server-side at save time (T1.2/A2).
              },
            };
            break;
          }
        }
      }
      node = node.parentNode;
    }

    if (!anchor) { showAddComment = false; return; }

    const rect = range.getBoundingClientRect();
    pendingAnchor = anchor;
    pendingQuoted = quotedText;
    btnX = rect.right;
    btnY = rect.bottom;
    showAddComment = true;
  }

  function handleAddCommentClick() {
    if (!pendingAnchor) return;
    dispatch('addAnnotation', { anchor: pendingAnchor, x: btnX, y: btnY, quoted: pendingQuoted });
    showAddComment = false;
  }

  // ⌘⌥M → add a comment on the current preview selection (#10). Guarded to only
  // act when the selection is inside THIS preview, so it doesn't fire for an
  // editor selection (the editor has its own ⌘⌥M keymap). Uses e.code so the
  // macOS Option-character remap (⌥M → µ) doesn't break the match.
  function handleAddCommentKeydown(e: KeyboardEvent) {
    if (!((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM')) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !previewEl) return;
    if (!previewEl.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    e.preventDefault();
    handlePreviewMouseUp(); // builds pendingAnchor from the current selection
    handleAddCommentClick();
  }
  // Dismiss the affordance on any mousedown that isn't on the affordance itself —
  // covers clicking into the editor pane or anywhere else (the per-pane selection
  // handlers don't fire for the other pane). Clicking the affordance button is
  // whitelisted so its own click still registers.
  function handleAffordanceDismiss(e: MouseEvent) {
    if (!showAddComment) return;
    if ((e.target as Element | null)?.closest?.('.add-comment-affordance')) return;
    showAddComment = false;
  }
  onMount(() => {
    window.addEventListener('keydown', handleAddCommentKeydown);
    window.addEventListener('mousedown', handleAffordanceDismiss);
    return () => {
      window.removeEventListener('keydown', handleAddCommentKeydown);
      window.removeEventListener('mousedown', handleAffordanceDismiss);
    };
  });
</script>

<div class="preview-pane">
  {#if syncDegraded}
    <div class="banner" role="status" aria-live="polite">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
      </svg>
      <span>Large file — scroll sync is best-effort.</span>
    </div>
  {/if}

  <div class="pv-scroll" bind:this={pvScrollEl}>
    <!-- AnnotationSeals overlay — first child of .pv-scroll (D3).
         Absolutely positioned relative to .pv-scroll (position: relative added below). -->
    <AnnotationSeals
      bind:this={sealsComponent}
      scrollContainer={pvScrollEl}
      {previewEl}
    />
    <article class="prose">
      {#if frontmatterHeader}
        <header class="pv-header" aria-label="Document metadata">
          {#if fmTitle}<h1 class="pv-title">{fmTitle}</h1>{/if}
          {#if fmMeta.length}
            <div class="pv-meta">
              {#each fmMeta as [key, value], i (key)}
                {#if i > 0}<span class="pv-dot" aria-hidden="true">·</span>{/if}
                {#if key === 'author'}
                  <span class="pv-author">
                    <span class="pv-avatar" aria-hidden="true">{initials(String(value))}</span>
                    {value}
                  </span>
                {:else}
                  <span class="pv-meta-item">{value}</span>
                {/if}
              {/each}
            </div>
          {/if}
        </header>
      {/if}

      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div
        class="preview-content"
        bind:this={previewEl}
        on:mouseup={handlePreviewMouseUp}
      >{@html html}</div>
    </article>
  </div>

  {#if showAddComment}
    <!-- Positioning wrapper only; the button inside is self-labeling (no
         role="tooltip" — that would hide the interactive button from AT). -->
    <div class="add-comment-affordance" style="left: {btnX}px; top: {btnY + 6}px;">
      <button class="add-comment-btn" type="button" on:click={handleAddCommentClick}>
        + Add comment
        <span class="add-comment-kbd" aria-hidden="true">{addCommentShortcut}</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--preview-bg);
    color: var(--text);
  }
  /* D3: position:relative so AnnotationSeals overlay can use absolute positioning
     relative to this scroll container (seals scroll with content). */
  .pv-scroll { overflow: auto; flex: 1; min-height: 0; position: relative; }


  /* "+ Add comment" affordance at the selection (viewport-fixed; preview scrolls) */
  .add-comment-affordance { position: fixed; z-index: var(--z-pop); pointer-events: auto; }
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
  .add-comment-kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: var(--fw-semibold);
    color: var(--text-on-accent);
    background: color-mix(in srgb, #000 18%, transparent);
    border-radius: var(--r-xs);
    padding: 1px 5px;
    letter-spacing: .02em;
  }
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

  /* info / best-effort banner */
  .banner {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    margin: 12px 16px 0;
    padding: 9px 14px;
    font-size: var(--fs-sm);
    border-radius: var(--r-md);
    background: var(--warn-soft);
    color: var(--warn-text);
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  }
  .banner svg { width: 15px; height: 15px; flex: none; }

  /*
   * .prose content rules have moved to src/lib/styles/markdown.css.
   * The z-index comment below documents the stacking context requirement
   * for the AnnotationSeals overlay — z-index: 1 is set in markdown.css.
   * Sit above the wash layer (z-index: 0) and below the seals (z-index: 2)
   * so the ink brush paints behind the text.
   */

  .pv-header { margin-bottom: 28px; }
  .pv-title {
    font-size: var(--ps-h1);
    font-weight: var(--fw-semibold);
    line-height: var(--lh-tight);
    letter-spacing: -.012em;
    margin: 0 0 12px;
    text-wrap: balance;
  }
  .pv-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }
  .pv-author { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--text); font-weight: var(--fw-medium); }
  .pv-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 9.5px;
    font-weight: var(--fw-bold);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    letter-spacing: .02em;
  }
  .pv-dot { color: var(--text-faint); }

  /* Rendered markdown content rules live in src/lib/styles/markdown.css
     (imported above). Keeping only the empty rule comment for orientation. */
</style>
