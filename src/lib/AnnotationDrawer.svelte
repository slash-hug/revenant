<script lang="ts">
  /**
   * AnnotationDrawer.svelte — right-side review panel.
   *  - C9  comment list with status badges + the detached ("revenant") section.
   *  - C10 General Notes textarea persisted as general_notes in the sidecar.
   */
  import { annotationsStore } from './stores/annotations';
  import type { Annotation } from './types/ipc';

  export let open: boolean = true;

  let notesDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const NOTES_DEBOUNCE_MS = 800;

  function handleNotesInput(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    if (notesDebounceTimer) clearTimeout(notesDebounceTimer);
    notesDebounceTimer = setTimeout(() => annotationsStore.updateGeneralNotes(value), NOTES_DEBOUNCE_MS);
  }

  async function handleDelete(id: string) {
    if (confirm('Delete this annotation permanently?')) {
      await annotationsStore.deleteAnnotation(id);
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
          placeholder="Notes that apply to the whole document…"
          value={$annotationsStore.generalNotes}
          on:input={handleNotesInput}
          rows="3"
        ></textarea>
      </section>

      <!-- Comments -->
      <section class="drawer-sec" aria-labelledby="cmt-label">
        <div class="drawer-head" id="cmt-label">
          <span>Comments</span>
          <span class="count">{activeAnnotations.length}</span>
        </div>

        {#if activeAnnotations.length === 0}
          <p class="cmt-empty">No comments yet. Select text in the editor or preview to add one.</p>
        {:else}
          <ul class="cmt-list" role="list">
            {#each activeAnnotations as ann (ann.id)}
              <li class="cmt" class:block={ann.status === 'block_level'}>
                <div class="cmt-top">
                  <span class="chip">{anchorLabel(ann)}</span>
                  {#if ann.status === 'block_level'}
                    <span class="badge badge-neutral">Block</span>
                  {:else}
                    <span class="badge badge-open">Anchored</span>
                  {/if}
                  <span class="spacer"></span>
                  <button class="cmt-del" on:click={() => handleDelete(ann.id)} aria-label="Delete comment" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
                    </svg>
                  </button>
                </div>
                {#if ann.quoted_text}
                  <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
                {/if}
                <p class="cmt-note">{ann.body}</p>
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
                  <button class="cmt-del" on:click={() => handleDelete(ann.id)} aria-label="Delete comment" title="Delete">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
                    </svg>
                  </button>
                </div>
                {#if ann.quoted_text}
                  <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
                {/if}
                <p class="cmt-note">{ann.body}</p>
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
    width: 350px;
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
    transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .cmt:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }

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

  .cmt-del {
    color: var(--text-faint);
    display: inline-flex;
    padding: 3px;
    border-radius: var(--r-xs);
    border: none;
    background: transparent;
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .cmt-del svg { width: 14px; height: 14px; }
  .cmt-del:hover { color: var(--danger-text); background: var(--danger-soft); }

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
