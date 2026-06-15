<script lang="ts">
  /**
   * AnnotationDrawer.svelte — right-side review panel.
   *  - C9  comment list with status badges + the detached ("revenant") section.
   *  - C10 General Notes textarea persisted as general_notes in the sidecar.
   */
  import { annotationsStore } from './stores/annotations';
  import { tick } from 'svelte';
  import { annotationFocus, focusAnnotation } from './stores/annotationFocus';
  import { deleteAnnotationWithUndo, saveAnnotationEdit } from './annotationActions';
  import type { Annotation } from './types/ipc';

  export let open: boolean = true;

  let notesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const NOTES_DEBOUNCE_MS = 800;

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
  const isMac = typeof navigator !== 'undefined'
    && (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));
  const saveHint = isMac ? '⌘↩' : 'Ctrl+↩';
  let editingId: string | null = null;
  let draft = '';
  let editEl: HTMLTextAreaElement | undefined;

  function startEdit(e: MouseEvent, ann: Annotation) {
    e.stopPropagation();
    editingId = ann.id;
    draft = ann.body;
    tick().then(() => { editEl?.focus(); editEl?.select(); });
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
              <!-- Card as a focusable listitem — tabindex + keydown give keyboard
                   users the same navigate-to-annotation affordance as mouse users.
                   Delete buttons inside call stopPropagation so neither the card
                   click nor the focus popover are triggered by delete actions.
                   The svelte-ignore suppresses the a11y lint for intentional
                   keyboard-accessible non-interactive element pattern. -->
              <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
              <li
                class="cmt"
                class:block={ann.status === 'block_level'}
                class:cmt-active={$annotationFocus.activeId === ann.id}
                role="listitem"
                tabindex="0"
                on:click={() => focusAnnotation(ann.id)}
                on:keydown={(e) => handleCardKeydown(e, ann.id)}
                aria-label="Annotation at {anchorLabel(ann)}: {ann.body.slice(0, 80)}"
              >
                <div class="cmt-top">
                  <span class="chip">{anchorLabel(ann)}</span>
                  {#if ann.status === 'block_level'}
                    <span class="badge badge-neutral">Block</span>
                  {:else}
                    <span class="badge badge-open">Anchored</span>
                  {/if}
                  <span class="spacer"></span>
                  {#if editingId !== ann.id}
                    <button class="cmt-icon" type="button" on:click={(e) => startEdit(e, ann)} aria-label="Edit comment" title="Edit">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                  {/if}
                  <button class="cmt-icon cmt-del" type="button" on:click={(e) => handleDelete(e, ann.id)} aria-label="Delete comment" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
                    </svg>
                  </button>
                </div>
                {#if ann.quoted_text}
                  <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
                {/if}
                {#if editingId === ann.id}
                  <textarea
                    bind:this={editEl}
                    class="cmt-edit-field"
                    bind:value={draft}
                    rows="3"
                    aria-label="Edit comment"
                    on:click|stopPropagation
                    on:keydown={handleEditKeydown}
                  ></textarea>
                  <div class="cmt-edit-actions">
                    <span class="edit-hint">{saveHint} save · Esc cancel</span>
                    <span class="spacer"></span>
                    <button class="edit-cancel" type="button" on:click|stopPropagation={cancelEdit}>Cancel</button>
                    <button class="edit-save" type="button" disabled={!draft.trim()} on:click|stopPropagation={commitEdit}>Save</button>
                  </div>
                {:else}
                  <p class="cmt-note">{ann.body}</p>
                {/if}
              </li>
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
              <li class="cmt detached">
                <div class="cmt-top">
                  <span class="chip chip-detached">{anchorLabel(ann)}</span>
                  <span class="badge badge-detached">Anchor lost</span>
                  <span class="spacer"></span>
                  {#if editingId !== ann.id}
                    <button class="cmt-icon" type="button" on:click={(e) => startEdit(e, ann)} aria-label="Edit comment" title="Edit">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                    </button>
                  {/if}
                  <button class="cmt-icon cmt-del" type="button" on:click={(e) => handleDelete(e, ann.id)} aria-label="Delete comment" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
                    </svg>
                  </button>
                </div>
                {#if ann.quoted_text}
                  <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
                {/if}
                {#if editingId === ann.id}
                  <textarea
                    bind:this={editEl}
                    class="cmt-edit-field"
                    bind:value={draft}
                    rows="3"
                    aria-label="Edit comment"
                    on:keydown={handleEditKeydown}
                  ></textarea>
                  <div class="cmt-edit-actions">
                    <span class="edit-hint">{saveHint} save · Esc cancel</span>
                    <span class="spacer"></span>
                    <button class="edit-cancel" type="button" on:click={cancelEdit}>Cancel</button>
                    <button class="edit-save" type="button" disabled={!draft.trim()} on:click={commitEdit}>Save</button>
                  </div>
                {:else}
                  <p class="cmt-note">{ann.body}</p>
                {/if}
              </li>
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

  .cmt {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    cursor: pointer;
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .cmt:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
  /* Keyboard focus ring for the card (tabindex="0" on the <li>). */
  .cmt:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Active card treatment (T3.2): left-border accent + soft tint.
     Uses --seal-ink so it is visually linked to the gutter seal and the preview
     wash. Distinct from :hover (hover only changes border/shadow; active adds
     the ink border + tint). */
  .cmt.cmt-active {
    border-left: 2.5px solid var(--seal-ink, #4A453B);
    background: color-mix(in srgb, var(--seal-ink, #4A453B) 6%, var(--surface));
  }
  .cmt.cmt-active:hover {
    border-left: 2.5px solid var(--seal-ink, #4A453B);
  }

  .cmt-top { display: flex; align-items: center; gap: var(--sp-2); }
  .spacer { flex: 1; }

  .chip {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    color: var(--accent-text);
    background: var(--accent-soft);
    border-radius: var(--r-sm);
    padding: 2px 7px;
    letter-spacing: .01em;
  }
  .chip-detached { color: var(--detached-text); background: var(--detached-soft); }

  .badge {
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    padding: 2px 8px;
    border-radius: var(--r-pill);
    letter-spacing: .01em;
  }
  .badge-open { color: var(--success-text); background: var(--success-soft); }
  .badge-neutral { color: var(--text-muted); background: var(--surface-2); }
  .badge-detached {
    color: var(--detached-text);
    background: var(--detached-soft);
    border: 1px dashed color-mix(in srgb, var(--detached) 55%, transparent);
    padding: 1px 7px;
  }

  .cmt-icon {
    color: var(--text-faint);
    display: inline-flex;
    padding: 3px;
    border-radius: var(--r-xs);
    border: none;
    background: transparent;
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .cmt-icon svg { width: 14px; height: 14px; }
  .cmt-icon:hover { color: var(--text); background: var(--surface-2); }
  .cmt-del:hover { color: var(--danger-text); background: var(--danger-soft); }

  .cmt-edit-field {
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: var(--lh-snug);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 8px 10px;
    width: 100%;
    resize: vertical;
    min-height: 54px;
  }
  .cmt-edit-field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--focus-ring); }
  .cmt-edit-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .cmt-edit-actions .spacer { flex: 1; }
  .edit-hint { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
  .edit-cancel, .edit-save {
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    line-height: 1;
    cursor: pointer;
    padding: 5px 11px;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
  }
  .edit-cancel { background: transparent; color: var(--text-muted); border-color: var(--border); }
  .edit-cancel:hover { color: var(--text); border-color: var(--border-strong); }
  .edit-save { background: var(--accent); color: var(--text-on-accent); }
  .edit-save:hover:not(:disabled) { background: var(--accent-hover); }
  .edit-save:disabled { opacity: .5; cursor: default; }

  .cmt-snippet {
    margin: 0;
    font-family: var(--font-prose);
    font-size: 13px;
    line-height: var(--lh-snug);
    color: var(--text-muted);
    border-left: 2px solid var(--accent);
    padding-left: 10px;
    font-style: italic;
  }
  .cmt-note { margin: 0; font-size: 13px; line-height: var(--lh-snug); color: var(--text); white-space: pre-wrap; }

  .cmt.block .cmt-snippet { border-left-color: var(--text-muted); }

  .cmt.detached {
    border-style: dashed;
    border-color: color-mix(in srgb, var(--detached) 50%, var(--border));
    background: var(--detached-soft);
  }
  .cmt.detached .cmt-snippet { border-left-color: var(--detached); opacity: .85; }

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
