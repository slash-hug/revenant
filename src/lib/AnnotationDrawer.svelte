<script lang="ts">
  /**
   * AnnotationDrawer.svelte — right-side annotation panel.
   *
   * Decisions implemented:
   *  - C9  Right-side drawer with annotation list and detached badge.
   *  - C10 General Notes persistent textarea at top of drawer, persisted as
   *        general_notes in the sidecar via the annotations store.
   */
  import { createEventDispatcher } from 'svelte';
  import { annotationsStore } from './stores/annotations';
  import type { Annotation } from './types/ipc';

  /** Whether the drawer is currently open. */
  export let open: boolean = true;

  const dispatch = createEventDispatcher<{
    close: void;
  }>();

  // Debounced general notes save
  let notesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const NOTES_DEBOUNCE_MS = 800;

  function handleNotesInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    if (notesDebounceTimer) clearTimeout(notesDebounceTimer);
    notesDebounceTimer = setTimeout(() => {
      annotationsStore.updateGeneralNotes(value);
    }, NOTES_DEBOUNCE_MS);
  }

  async function handleResolve(id: string) {
    await annotationsStore.resolveAnnotation(id);
  }

  async function handleReopen(id: string) {
    await annotationsStore.reopenAnnotation(id);
  }

  async function handleDelete(id: string) {
    if (confirm('Delete this annotation permanently?')) {
      await annotationsStore.deleteAnnotation(id);
    }
  }

  function anchorLabel(ann: Annotation): string {
    if (ann.anchor.type === 'source') {
      const { start_line, end_line } = ann.anchor.anchor;
      return start_line === end_line ? `L${start_line}` : `L${start_line}–L${end_line}`;
    }
    const { block_type, block_id } = ann.anchor.anchor;
    return `block:${block_type}:${block_id}`;
  }

  function statusLabel(status: Annotation['status']): string {
    switch (status) {
      case 'open': return 'Open';
      case 'resolved': return 'Resolved';
      case 'detached': return 'Detached';
    }
  }

  $: openAnnotations = $annotationsStore.annotations.filter((a) => a.status === 'open');
  $: detachedAnnotations = $annotationsStore.annotations.filter((a) => a.status === 'detached');
  $: resolvedAnnotations = $annotationsStore.annotations.filter((a) => a.status === 'resolved');
</script>

{#if open}
  <aside class="annotation-drawer" aria-label="Annotations">
    <div class="drawer-header">
      <span class="drawer-title">Annotations</span>
      {#if detachedAnnotations.length > 0}
        <span class="detached-badge" title="{detachedAnnotations.length} detached annotation(s)">
          {detachedAnnotations.length} detached
        </span>
      {/if}
      <button class="close-drawer" on:click={() => dispatch('close')} aria-label="Close annotations">×</button>
    </div>

    <!-- General Notes (C10) — always at top -->
    <section class="general-notes" aria-labelledby="general-notes-label">
      <label id="general-notes-label" for="general-notes-textarea" class="section-label">General notes</label>
      <textarea
        id="general-notes-textarea"
        class="notes-textarea"
        placeholder="Notes that apply to the whole document…"
        value={$annotationsStore.generalNotes}
        on:input={handleNotesInput}
        rows="4"
      ></textarea>
    </section>

    <!-- Open annotations -->
    <section class="annotation-section" aria-labelledby="open-label">
      <div class="section-header">
        <span id="open-label" class="section-label">Open ({openAnnotations.length})</span>
      </div>
      {#if openAnnotations.length === 0}
        <p class="empty-state">No open comments. Select text in the editor or preview to add one.</p>
      {:else}
        <ul class="annotation-list" role="list">
          {#each openAnnotations as ann (ann.id)}
            <li class="annotation-item" data-status="open">
              <div class="ann-meta">
                <span class="ann-anchor" title="Source anchor">{anchorLabel(ann)}</span>
                <span class="ann-status open">Open</span>
              </div>
              {#if ann.anchor.type === 'source' && ann.anchor.anchor.quoted_text}
                <blockquote class="ann-quote">{ann.anchor.anchor.quoted_text}</blockquote>
              {/if}
              <p class="ann-body">{ann.body}</p>
              <div class="ann-actions">
                <button class="btn-resolve" on:click={() => handleResolve(ann.id)}>Resolve</button>
                <button class="btn-delete" on:click={() => handleDelete(ann.id)}>Delete</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Detached annotations (lost their anchor) -->
    {#if detachedAnnotations.length > 0}
      <section class="annotation-section" aria-labelledby="detached-label">
        <div class="section-header">
          <span id="detached-label" class="section-label">
            Detached ({detachedAnnotations.length})
          </span>
          <span class="section-hint">These lost their anchor after document edits.</span>
        </div>
        <ul class="annotation-list" role="list">
          {#each detachedAnnotations as ann (ann.id)}
            <li class="annotation-item" data-status="detached">
              <div class="ann-meta">
                <span class="ann-anchor detached" title="Detached anchor">
                  {anchorLabel(ann)} <span class="detached-label">⚠ detached</span>
                </span>
              </div>
              {#if ann.anchor.type === 'source' && ann.anchor.anchor.quoted_text}
                <blockquote class="ann-quote detached-quote">{ann.anchor.anchor.quoted_text}</blockquote>
              {/if}
              <p class="ann-body">{ann.body}</p>
              <div class="ann-actions">
                <button class="btn-delete" on:click={() => handleDelete(ann.id)}>Delete</button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Resolved annotations (collapsed by default) -->
    {#if resolvedAnnotations.length > 0}
      <details class="resolved-section">
        <summary class="section-label">Resolved ({resolvedAnnotations.length})</summary>
        <ul class="annotation-list resolved" role="list">
          {#each resolvedAnnotations as ann (ann.id)}
            <li class="annotation-item" data-status="resolved">
              <div class="ann-meta">
                <span class="ann-anchor">{anchorLabel(ann)}</span>
                <span class="ann-status resolved">Resolved</span>
              </div>
              <p class="ann-body resolved-body">{ann.body}</p>
              <div class="ann-actions">
                <button class="btn-reopen" on:click={() => handleReopen(ann.id)}>Reopen</button>
                <button class="btn-delete" on:click={() => handleDelete(ann.id)}>Delete</button>
              </div>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if $annotationsStore.error}
      <div class="error-banner" role="alert">{$annotationsStore.error}</div>
    {/if}
  </aside>
{/if}

<style>
  .annotation-drawer {
    width: 320px;
    min-width: 260px;
    max-width: 400px;
    height: 100%;
    border-left: 1px solid var(--border-color, #ddd);
    background: var(--drawer-bg, #fafafa);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color, #ddd);
    background: var(--drawer-header-bg, #f0f0f0);
    flex-shrink: 0;
  }

  .drawer-title {
    font-weight: 600;
    font-size: 13px;
    flex: 1;
  }

  .detached-badge {
    background: var(--warning-bg, #fff3cd);
    color: var(--warning-fg, #856404);
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
  }

  .close-drawer {
    border: none;
    background: transparent;
    font-size: 16px;
    cursor: pointer;
    color: var(--muted, #666);
    padding: 0 4px;
    line-height: 1;
  }

  .general-notes {
    padding: 12px;
    border-bottom: 1px solid var(--border-color, #ddd);
    flex-shrink: 0;
  }

  .section-label {
    display: block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted, #666);
    margin-bottom: 6px;
  }

  .notes-textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
    resize: vertical;
    background: var(--input-bg, #fff);
    color: var(--fg, #222);
    font-family: inherit;
    line-height: 1.5;
  }

  .notes-textarea:focus {
    outline: 2px solid var(--accent, #0066cc);
    outline-offset: 1px;
  }

  .annotation-section {
    padding: 12px;
    border-bottom: 1px solid var(--border-color, #ddd);
  }

  .section-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
  }

  .section-hint {
    font-size: 11px;
    color: var(--muted, #888);
  }

  .empty-state {
    font-size: 12px;
    color: var(--muted, #888);
    margin: 0;
    font-style: italic;
  }

  .annotation-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .annotation-item {
    background: var(--ann-bg, #fff);
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 6px;
    padding: 10px;
    font-size: 13px;
  }

  .annotation-item[data-status="detached"] {
    border-color: var(--warning-border, #f0c040);
    background: var(--detached-bg, #fffbf0);
  }

  .annotation-item[data-status="resolved"] {
    opacity: 0.65;
  }

  .ann-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .ann-anchor {
    font-family: var(--editor-font, monospace);
    font-size: 11px;
    background: var(--code-bg, #f0f0f0);
    border-radius: 3px;
    padding: 1px 5px;
    color: var(--accent, #0055aa);
  }

  .ann-anchor.detached {
    color: var(--warning-fg, #856404);
  }

  .detached-label {
    margin-left: 2px;
  }

  .ann-status {
    font-size: 11px;
    border-radius: 10px;
    padding: 1px 7px;
    font-weight: 600;
  }

  .ann-status.open {
    background: var(--open-bg, #e8f4ff);
    color: var(--open-fg, #0055aa);
  }

  .ann-status.resolved {
    background: var(--resolved-bg, #e8f8e8);
    color: var(--resolved-fg, #2a7a2a);
  }

  .ann-quote {
    border-left: 3px solid var(--accent, #0066cc);
    margin: 0 0 6px 0;
    padding: 2px 8px;
    color: var(--muted, #555);
    font-style: italic;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .detached-quote {
    border-color: var(--warning-border, #e6c200);
    color: var(--muted, #777);
  }

  .ann-body {
    margin: 0 0 8px 0;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .resolved-body {
    text-decoration: line-through;
    color: var(--muted, #888);
  }

  .ann-actions {
    display: flex;
    gap: 6px;
  }

  .btn-resolve, .btn-delete, .btn-reopen {
    border: 1px solid var(--border-color, #ccc);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    background: var(--btn-bg, #fff);
    color: var(--btn-fg, #444);
  }

  .btn-resolve:hover { background: var(--resolved-bg, #e8f8e8); }
  .btn-delete:hover { background: var(--error-bg, #fff0f0); color: var(--error-fg, #c00); }
  .btn-reopen:hover { background: var(--open-bg, #e8f4ff); }

  .resolved-section {
    padding: 12px;
    border-bottom: 1px solid var(--border-color, #ddd);
  }

  .resolved-section summary {
    cursor: pointer;
    list-style: revert;
  }

  .error-banner {
    margin: 12px;
    padding: 8px 12px;
    background: var(--error-bg, #fff0f0);
    border: 1px solid var(--error-border, #f08080);
    border-radius: 4px;
    font-size: 12px;
    color: var(--error-fg, #c00);
  }
</style>
