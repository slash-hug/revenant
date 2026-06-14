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
  import { onMount, afterUpdate, createEventDispatcher, tick } from 'svelte';
  import {
    renderMarkdown,
    renderCodeBlock,
    renderMermaid,
    stripFrontmatter,
  } from './render/markdown';
  import type { AnchorV1, BlockAnchor } from './types/ipc';

  export let content: string = '';
  export let scrollLine: number = 1;

  const dispatch = createEventDispatcher<{
    blockMap: Map<string, number>;
    addAnnotation: { anchor: AnchorV1; x: number; y: number; quoted: string };
  }>();

  // "+ Add comment" affordance shown at the selection (mirrors EditorPane).
  let showAddComment = false;
  let pendingAnchor: AnchorV1 | null = null;
  let pendingQuoted = '';
  let btnX = 0;
  let btnY = 0;

  const LARGE_FILE_THRESHOLD = 2000; // lines

  let previewEl: HTMLDivElement | null = null;
  let html = '';
  let syncDegraded = false;
  let isHydrating = false;

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

  afterUpdate(async () => {
    if (!previewEl) return;
    await tick();
    await hydrateDynamicBlocks();
    emitBlockMap();
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
    }
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

  $: if (previewEl && scrollLine > 0 && !syncDegraded) {
    syncScrollToLine(scrollLine);
  }

  function syncScrollToLine(line: number) {
    if (!previewEl) return;
    // Find the block closest to the target line.
    const blocks = Array.from(
      previewEl.querySelectorAll<HTMLElement>('[data-source-line]')
    );
    if (blocks.length === 0) return;

    let best: HTMLElement | null = null;
    let bestDist = Infinity;

    for (const el of blocks) {
      const elLine = parseInt(el.dataset.sourceLine ?? '0', 10);
      const dist = Math.abs(elLine - line);
      if (dist < bestDist) {
        bestDist = dist;
        best = el;
      }
    }

    if (best) {
      best.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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

  <div class="pv-scroll">
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
    <div class="add-comment-affordance" style="left: {btnX}px; top: {btnY + 6}px;" role="tooltip">
      <button class="add-comment-btn" type="button" on:click={handleAddCommentClick}>
        + Add comment
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
  .pv-scroll { overflow: auto; flex: 1; min-height: 0; }

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

  /* reading column */
  .prose {
    padding: 32px 44px 64px;
    font-family: var(--font-prose);
    max-width: 760px;
    color: var(--text);
  }

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

  /* ---- rendered markdown ---- */
  .preview-content :global(h1) {
    font-size: var(--ps-h1);
    font-weight: var(--fw-semibold);
    line-height: var(--lh-tight);
    letter-spacing: -.012em;
    margin: 34px 0 14px;
    text-wrap: balance;
  }
  .preview-content :global(h2) {
    font-family: var(--font-ui);
    font-size: var(--ps-h2);
    font-weight: var(--fw-semibold);
    margin: 30px 0 11px;
    color: var(--text);
    text-wrap: balance;
  }
  .preview-content :global(h3),
  .preview-content :global(h4) {
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    font-weight: var(--fw-semibold);
    color: var(--text-muted);
    margin: 24px 0 8px;
  }
  .preview-content :global(p) {
    font-size: var(--ps-base);
    line-height: 1.62;
    margin: 0 0 14px;
    color: var(--text);
    text-wrap: pretty;
  }
  .preview-content :global(ul),
  .preview-content :global(ol) { margin: 0 0 16px; padding-left: 22px; }
  .preview-content :global(li) { font-size: var(--ps-base); line-height: 1.7; color: var(--text); }
  .preview-content :global(li::marker) { color: var(--accent); }
  .preview-content :global(a) { color: var(--accent-text); text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
  .preview-content :global(strong) { font-weight: var(--fw-semibold); }
  .preview-content :global(hr) { border: none; height: 1px; background: var(--border); margin: 28px 0; }

  /* inline code */
  .preview-content :global(:not(pre) > code) {
    font-family: var(--font-mono);
    font-size: .86em;
    background: var(--surface-2);
    border-radius: var(--r-xs);
    padding: 1px 5px;
    color: var(--text);
  }

  /* code blocks */
  .preview-content :global(pre) {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 15px 17px;
    margin: 0 0 18px;
    overflow: auto;
  }
  .preview-content :global(pre code) {
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--text);
    background: none;
    padding: 0;
  }

  /* highlight.js token palette mapped onto our syntax roles */
  .preview-content :global(.hljs-keyword),
  .preview-content :global(.hljs-selector-tag),
  .preview-content :global(.hljs-built_in) { color: var(--accent-text); }
  .preview-content :global(.hljs-string),
  .preview-content :global(.hljs-attr),
  .preview-content :global(.hljs-symbol) { color: var(--success-text); }
  .preview-content :global(.hljs-title),
  .preview-content :global(.hljs-title.function_),
  .preview-content :global(.hljs-section) { color: var(--success-text); font-weight: var(--fw-medium); }
  .preview-content :global(.hljs-type),
  .preview-content :global(.hljs-number),
  .preview-content :global(.hljs-literal),
  .preview-content :global(.hljs-class .hljs-title) { color: var(--warn-text); }
  .preview-content :global(.hljs-comment),
  .preview-content :global(.hljs-quote) { color: var(--text-faint); font-style: italic; }
  .preview-content :global(.hljs-punctuation),
  .preview-content :global(.hljs-operator) { color: var(--text-faint); }

  /* blockquote */
  .preview-content :global(blockquote) {
    margin: 0 0 18px;
    padding: 4px 0 4px 18px;
    border-left: 3px solid var(--accent);
    font-size: var(--ps-quote);
    line-height: 1.55;
    color: var(--text-muted);
    font-style: italic;
  }

  /* tables */
  .preview-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0 0 18px;
    font-family: var(--font-ui);
    font-size: var(--fs-base);
  }
  .preview-content :global(th),
  .preview-content :global(td) { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .preview-content :global(th) { color: var(--text-muted); font-weight: var(--fw-semibold); border-bottom-color: var(--border-strong); }
  .preview-content :global(td) { color: var(--text); }
  .preview-content :global(tbody tr:hover td) { background: var(--surface-2); }

  /* mermaid figure */
  .preview-content :global([data-block-type="mermaid"]) {
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    padding: 22px;
    margin: 0 0 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
  }
  .preview-content :global([data-mermaid-pending]) {
    min-height: 96px;
    background: linear-gradient(100deg,
      var(--surface-2) 30%,
      color-mix(in srgb, var(--surface-2) 60%, var(--surface)) 50%,
      var(--surface-2) 70%);
    background-size: 200% 100%;
    animation: pv-shimmer 1.4s var(--ease-in-out) infinite;
    color: transparent;
  }
  @keyframes pv-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) {
    .preview-content :global([data-mermaid-pending]) { animation: none; }
  }

  /* diagram error card */
  .preview-content :global(.mermaid-error) {
    border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
    background: var(--danger-soft);
    border-radius: var(--r-lg);
    padding: 14px 16px;
    margin: 0 0 18px;
    font-size: var(--fs-base);
    font-family: var(--font-ui);
    color: var(--text);
  }
  .preview-content :global(.mermaid-error strong) { color: var(--danger-text); }
</style>
