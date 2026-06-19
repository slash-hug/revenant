<script lang="ts">
  /**
   * AnnotationDrawer.svelte — right-side review panel.
   *  - C9  comment list with status badges + the detached ("revenant") section.
   *  - C10 General Notes textarea persisted as general_notes in the sidecar.
   */
  import { onDestroy } from 'svelte';
  import { annotationsStore } from './stores/annotations';
  import { annotationFocus, focusAnnotation } from './stores/annotationFocus';
  import { deleteAnnotationWithUndo, saveAnnotationEdit } from './annotationActions';
  import { isMac } from './util/platform';
  import CommentCard from './CommentCard.svelte';
  import type { Annotation } from './types/ipc';

  export let open: boolean = true;

  let notesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const NOTES_DEBOUNCE_MS = 800;

  onDestroy(() => {
    if (notesDebounceTimer) {
      clearTimeout(notesDebounceTimer);
      notesDebounceTimer = null;
    }
  });

  function handleNotesInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    if (notesDebounceTimer) clearTimeout(notesDebounceTimer);
    notesDebounceTimer = setTimeout(() => annotationsStore.updateGeneralNotes(value), NOTES_DEBOUNCE_MS);
  }

  // Delete immediately + offer an Undo toast (UX #11) — stopPropagation so the
  // click doesn't also trigger the card's focus/navigate handler.
  function handleDelete(e: MouseEvent, id: string) {
    e.stopPropagation();
    deleteAnnotationWithUndo(id);
  }

  // Inline body editing (UX #17). Empty saves are disallowed (saveAnnotationEdit).
  const saveHint = isMac() ? '⌘↩' : 'Ctrl+↩';
  let editingId: string | null = null;
  let draft = '';

  function startEdit(e: MouseEvent, ann: Annotation) {
    e.stopPropagation();
    editingId = ann.id;
    draft = ann.body;
    // Focus/select is handled inside CommentCard when it enters edit mode.
  }
  function cancelEdit() { editingId = null; }
  function commitEdit() {
    if (editingId && saveAnnotationEdit(editingId, draft)) editingId = null;
  }
  function handleEditKeydown(e: KeyboardEvent) {
    e.stopPropagation(); // don't bubble to the card's Enter/Space navigate handler
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); }
  }

  /** Allow keyboard activation of the card body (Enter / Space). */
  function handleCardKeydown(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focusAnnotation(id);
    }
  }

  function anchorLabel(ann: Annotation): string {
    const start = ann.line_start + 1;
    const end = ann.line_end + 1;
    if (ann.status === 'block_level') return `block · L${start}`;
    return start === end ? `L${start}` : `L${start}–L${end}`;
  }

  $: activeAnnotations = $annotationsStore.annotations.filter(
    (a) => a.status === 'anchored' || a.status === 'block_level',
  );
  $: detachedAnnotations = $annotationsStore.annotations.filter((a) => a.status === 'detached');
</script>

{#if open}
  <aside class="drawer-pane" aria-label="Annotations">
    <div class="drawer-scroll">
      <!-- General notes (C10) -->
      <section class="drawer-sec" aria-labelledby="gn-label">
        <span id="gn-label" class="drawer-label">General notes</span>
        <textarea
          class="note-input"
          aria-labelledby="gn-label"
          placeholder="Notes that apply to the whole document…"
          value={$annotationsStore.generalNotes}
          on:input={handleNotesInput}
          rows="3"
        ></textarea>
      </section>

      <!-- Comments -->
      <section class="drawer-sec" aria-labelledby="cmt-label" aria-keyshortcuts="Alt+ArrowDown Alt+ArrowUp">
        <div class="drawer-head" id="cmt-label">
          <span>Comments</span>
          <span class="count">{activeAnnotations.length}</span>
        </div>

        {#if activeAnnotations.length === 0}
          <p class="cmt-empty">No comments yet. Select text in the editor or preview to add one.</p>
        {:else}
          <ul class="cmt-list" role="list">
            {#each activeAnnotations as ann (ann.id)}
              <CommentCard
                {ann}
                active={$annotationFocus.activeId === ann.id}
                editing={editingId === ann.id}
                bind:draft
                {saveHint}
                {anchorLabel}
                onFocus={focusAnnotation}
                onCardKeydown={handleCardKeydown}
                onStartEdit={startEdit}
                onDelete={handleDelete}
                onEditKeydown={handleEditKeydown}
                onCancelEdit={cancelEdit}
                onCommitEdit={commitEdit}
              />
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Detached / revenant -->
      {#if detachedAnnotations.length > 0}
        <section class="drawer-sec" aria-labelledby="det-label">
          <div class="drawer-head detached-head" id="det-label">
            <span>Detached</span>
            <span class="count">{detachedAnnotations.length}</span>
          </div>
          <p class="detached-hint">These lost their anchor after the document was edited.</p>
          <ul class="cmt-list" role="list">
            {#each detachedAnnotations as ann (ann.id)}
              <CommentCard
                {ann}
                detached
                editing={editingId === ann.id}
                bind:draft
                {saveHint}
                {anchorLabel}
                onFocus={focusAnnotation}
                onCardKeydown={handleCardKeydown}
                onStartEdit={startEdit}
                onDelete={handleDelete}
                onEditKeydown={handleEditKeydown}
                onCancelEdit={cancelEdit}
                onCommitEdit={commitEdit}
              />
            {/each}
          </ul>
        </section>
      {/if}

      {#if $annotationsStore.error}
        <div class="drawer-error" role="alert">{$annotationsStore.error}</div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .drawer-pane {
    width: 100%;
    height: 100%;
    background: var(--drawer-bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: none;
  }
  .drawer-scroll {
    overflow: auto;
    flex: 1;
    padding: 16px 14px 40px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }

  .drawer-sec { display: flex; flex-direction: column; gap: var(--sp-3); }
  .drawer-label, .drawer-head {
    font-size: 12px;
    font-weight: var(--fw-semibold);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .count {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-pill);
    padding: 1px 7px;
  }
  .detached-head { color: var(--detached-text); }
  .detached-head .count {
    color: var(--detached-text);
    background: var(--detached-soft);
    border-color: transparent;
  }
  .detached-hint {
    margin: -2px 0 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    line-height: var(--lh-snug);
  }

  .note-input {
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    line-height: var(--lh-snug);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 11px 12px;
    min-height: 64px;
    resize: vertical;
    width: 100%;
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .note-input::placeholder { color: var(--text-faint); }
  .note-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }

  .cmt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }

  .cmt-empty {
    border: 1px dashed var(--border);
    border-radius: var(--r-lg);
    padding: 22px 16px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
    font-family: var(--font-prose);
    font-style: italic;
    margin: 0;
  }

  .drawer-error {
    padding: 9px 12px;
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    border-radius: var(--r-md);
    font-size: var(--fs-sm);
    color: var(--danger-text);
  }
</style>
