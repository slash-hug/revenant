<script lang="ts">
  /**
   * AnnotationDrawer.svelte — right-side annotation panel.
   *
   * Decisions implemented:
   *  - C9  Right-side drawer with annotation list and detached badge.
   *  - C10 General Notes persistent textarea at top of drawer, persisted as
   *        general_notes in the sidecar via the annotations store.
   *
   * Status model (frozen IPC contract v1):
   *  - "anchored"    — anchor is valid; annotation is active.
   *  - "block_level" — anchor is a transformed block (Mermaid/table); active.
   *  - "detached"    — anchor lost after a document edit; shown with warning badge.
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

  async function handleDelete(id: string) {
    if (confirm('Delete this annotation permanently?')) {
      await annotationsStore.deleteAnnotation(id);
    }
  }

  /**
   * Build a display label for an annotation's anchor.
   * Line numbers stored as 0-indexed per IPC contract; display as 1-based.
   */
  function anchorLabel(ann: Annotation): string {
    const startDisplay = ann.line_start + 1;
    const endDisplay = ann.line_end + 1;
    if (ann.status === 'block_level') {
      return `block:L${startDisplay}`;
    }
    return startDisplay === endDisplay ? `L${startDisplay}` : `L${startDisplay}–L${endDisplay}`;
  }

  function statusLabel(status: Annotation['status']): string {
    switch (status) {
      case 'anchored': return 'Anchored';
      case 'block_level': return 'Block';
      case 'detached': return 'Detached';
    }
  }

  // "Active" annotations are those with a valid anchor (anchored or block_level).
  $: activeAnnotations = $annotationsStore.annotations.filter(
    (a) => a.status === 'anchored' || a.status === 'block_level'
  );
  $: detachedAnnotations = $annotationsStore.annotations.filter((a) => a.status === 'detached');
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

    <!-- Active annotations (anchored or block_level) -->
    <section class="annotation-section" aria-labelledby="active-label">
      <div class="section-header">
        <span id="active-label" class="section-label">Comments ({activeAnnotations.length})</span>
      </div>
      {#if activeAnnotations.length === 0}
        <p class="empty-state">No comments yet. Select text in the editor or preview to add one.</p>
      {:else}
        <ul class="annotation-list" role="list">
          {#each activeAnnotations as ann (ann.id)}
            <li class="annotation-item" data-status="anchored">
              <div class="ann-meta">
                <span class="ann-anchor" title="Source anchor">{anchorLabel(ann)}</span>
                <span class="ann-status anchored">{statusLabel(ann.status)}</span>
              </div>
              {#if ann.quoted_text}
                <blockquote class="ann-quote">{ann.quoted_text}</blockquote>
              {/if}
              <p class="ann-body">{ann.body}</p>
              <div class="ann-actions">
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
                  {anchorLabel(ann)} <span class="detached-label">detached</span>
                </span>
              </div>
              {#if ann.quoted_text}
                <blockquote class="ann-quote detached-quote">{ann.quoted_text}</blockquote>
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

  .ann-status.anchored {
    background: var(--open-bg, #e8f4ff);
    color: var(--open-fg, #0055aa);
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

  .ann-actions {
    display: flex;
    gap: 6px;
  }

  .btn-delete {
    border: 1px solid var(--border-color, #ccc);
    border-radius: 4px;
    padding: 2px 10px;
    font-size: 11px;
    cursor: pointer;
    background: var(--btn-bg, #fff);
    color: var(--btn-fg, #444);
  }

  .btn-delete:hover { background: var(--error-bg, #fff0f0); color: var(--error-fg, #c00); }

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
