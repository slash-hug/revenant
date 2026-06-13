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
    addAnnotation: { anchor: AnchorV1 };
  }>();

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
    if (!sel || sel.isCollapsed || !previewEl) return;

    const range = sel.getRangeAt(0);
    if (!previewEl.contains(range.commonAncestorContainer)) return;

    // Walk up to find the nearest block with data-block-id.
    let node: Node | null = range.commonAncestorContainer;
    while (node && node !== previewEl) {
      if (node instanceof HTMLElement) {
        const blockId = node.dataset.blockId;
        const blockType = node.dataset.blockType;
        if (blockId) {
          const quotedText = sel.toString();

          // Transformed blocks → block-level anchor (C8 degradation rule).
          if (blockType === 'mermaid' || blockType === 'table') {
            const blockAnchor: BlockAnchor = {
              block_id: blockId,
              block_type: blockType as BlockAnchor['block_type'],
              quoted_text: quotedText,
            };
            dispatch('addAnnotation', {
              anchor: { type: 'block', anchor: blockAnchor },
            });
            return;
          }

          // Regular block: use source-line from data attribute to build
          // a coarse source anchor (line-level, not char-level from preview).
          const sourceLine = parseInt(node.dataset.sourceLine ?? '0', 10);
          if (sourceLine > 0) {
            dispatch('addAnnotation', {
              anchor: {
                type: 'source',
                anchor: {
                  start_line: sourceLine,
                  start_char: 0,
                  end_line: sourceLine,
                  end_char: quotedText.length,
                  quoted_text: quotedText,
                  context_before: '',
                  context_after: '',
                },
              },
            });
            return;
          }
        }
      }
      node = node.parentNode;
    }
  }
</script>

<div class="preview-pane">
  {#if syncDegraded}
    <div class="sync-degraded-banner" role="status" aria-live="polite">
      Large file — scroll sync is best-effort only.
    </div>
  {/if}

  {#if frontmatterHeader}
    <header class="frontmatter-header" aria-label="Document metadata">
      {#if frontmatterHeader.title}
        <h1 class="fm-title">{frontmatterHeader.title}</h1>
      {/if}
      <dl class="fm-meta">
        {#each Object.entries(frontmatterHeader).filter(([k]) => k !== 'title') as [key, value]}
          <div class="fm-row">
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        {/each}
      </dl>
    </header>
  {/if}

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="preview-content"
    bind:this={previewEl}
    on:mouseup={handlePreviewMouseUp}
  >{@html html}</div>
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    background: var(--preview-bg, #fff);
    color: var(--preview-fg, #222);
    padding: 24px 32px;
    font-family: var(--prose-font, Georgia, serif);
    font-size: 16px;
    line-height: 1.7;
  }

  .sync-degraded-banner {
    background: var(--warning-bg, #fff7e0);
    border: 1px solid var(--warning-border, #e6c200);
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--warning-fg, #5c4e00);
    margin-bottom: 12px;
    flex-shrink: 0;
  }

  .frontmatter-header {
    border-bottom: 1px solid var(--border-color, #ddd);
    margin-bottom: 24px;
    padding-bottom: 16px;
  }

  .fm-title {
    font-size: 1.8em;
    font-weight: 700;
    margin: 0 0 8px 0;
  }

  .fm-meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    font-size: 13px;
    color: var(--muted, #666);
    margin: 0;
  }

  .fm-row {
    display: contents;
  }

  dt {
    font-weight: 600;
  }

  dd {
    margin: 0;
  }

  .preview-content :global(h1),
  .preview-content :global(h2),
  .preview-content :global(h3),
  .preview-content :global(h4),
  .preview-content :global(h5),
  .preview-content :global(h6) {
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    line-height: 1.3;
  }

  .preview-content :global(pre) {
    background: var(--code-bg, #f6f6f6);
    border-radius: 4px;
    padding: 12px 16px;
    overflow-x: auto;
    font-size: 13px;
  }

  .preview-content :global(code) {
    font-family: var(--editor-font, "JetBrains Mono", monospace);
    font-size: 0.9em;
  }

  .preview-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
  }

  .preview-content :global(th),
  .preview-content :global(td) {
    border: 1px solid var(--border-color, #ddd);
    padding: 6px 12px;
    text-align: left;
  }

  .preview-content :global(blockquote) {
    border-left: 4px solid var(--accent, #0066cc);
    margin: 0;
    padding: 4px 16px;
    color: var(--muted, #555);
  }

  .preview-content :global(.mermaid-error) {
    background: var(--error-bg, #fff0f0);
    border: 1px solid var(--error-border, #f08080);
    border-radius: 4px;
    padding: 8px 12px;
    font-size: 13px;
    color: var(--error-fg, #800);
  }

  .preview-content :global([data-mermaid-pending]) {
    background: var(--skeleton-bg, #f0f0f0);
    border-radius: 4px;
    min-height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted, #999);
    font-size: 13px;
  }
</style>
