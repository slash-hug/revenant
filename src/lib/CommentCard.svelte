<script lang="ts">
  /**
   * CommentCard.svelte — a single annotation card in the AnnotationDrawer.
   *
   * Renders both the active (anchored / block_level) and the detached
   * ("revenant") variants; the `detached` prop selects which markup is emitted.
   * Markup, class names, and events are kept identical to the previous inline
   * blocks in AnnotationDrawer so rendered output is unchanged.
   *
   * Each card owns its own `editEl` (textarea) bind:this — this avoids the
   * previous shared-binding hazard where a single parent-level `editEl` could
   * point at the wrong card's textarea.
   */
  import { tick } from 'svelte';
  import type { Annotation } from './types/ipc';

  export let ann: Annotation;
  export let detached: boolean = false;
  /** Whether this card is the focused/active one (active variant only). */
  export let active: boolean = false;
  /** Whether this card is currently in inline-edit mode. */
  export let editing: boolean = false;
  /** Two-way bound draft text for the inline editor. */
  export let draft: string = '';
  export let saveHint: string;

  export let anchorLabel: (ann: Annotation) => string;
  export let onFocus: (id: string) => void;
  export let onCardKeydown: (e: KeyboardEvent, id: string) => void;
  export let onStartEdit: (e: MouseEvent, ann: Annotation) => void;
  export let onDelete: (e: MouseEvent, id: string) => void;
  export let onEditKeydown: (e: KeyboardEvent) => void;
  export let onCancelEdit: () => void;
  export let onCommitEdit: () => void;

  let editEl: HTMLTextAreaElement | undefined;

  // Focus + select the textarea when this card enters edit mode (matches the
  // previous startEdit behaviour, now scoped to this card's own editEl).
  let wasEditing = false;
  $: if (editing && !wasEditing) {
    wasEditing = true;
    tick().then(() => { editEl?.focus(); editEl?.select(); });
  } else if (!editing && wasEditing) {
    wasEditing = false;
  }
</script>

{#if detached}
  <!-- Focusable listitem so a keyboard user can reach the card to read
       it, matching the anchored cards (a11y #30). -->
  <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
  <li
    class="cmt detached"
    role="listitem"
    tabindex="0"
    on:keydown={(e) => onCardKeydown(e, ann.id)}
  >
    <div class="cmt-top">
      <span class="chip chip-detached">{anchorLabel(ann)}</span>
      <span class="badge badge-detached">Anchor lost</span>
      <span class="spacer"></span>
      {#if !editing}
        <button class="cmt-icon" type="button" on:click={(e) => onStartEdit(e, ann)} aria-label="Edit comment" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </button>
      {/if}
      <button class="cmt-icon cmt-del" type="button" on:click={(e) => onDelete(e, ann.id)} aria-label="Delete comment" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
        </svg>
      </button>
    </div>
    {#if ann.quoted_text}
      <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
    {/if}
    {#if editing}
      <textarea
        bind:this={editEl}
        class="cmt-edit-field"
        bind:value={draft}
        rows="3"
        aria-label="Edit comment"
        on:click|stopPropagation
        on:keydown={onEditKeydown}
      ></textarea>
      <div class="cmt-edit-actions">
        <span class="edit-hint">{saveHint} save · Esc cancel</span>
        <span class="spacer"></span>
        <button class="edit-cancel" type="button" on:click|stopPropagation={onCancelEdit}>Cancel</button>
        <button class="edit-save" type="button" disabled={!draft.trim()} on:click|stopPropagation={onCommitEdit}>Save</button>
      </div>
    {:else}
      <p class="cmt-note">{ann.body}</p>
    {/if}
  </li>
{:else}
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
    class:cmt-active={active}
    role="listitem"
    tabindex="0"
    on:click={() => onFocus(ann.id)}
    on:keydown={(e) => onCardKeydown(e, ann.id)}
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
      {#if !editing}
        <button class="cmt-icon" type="button" on:click={(e) => onStartEdit(e, ann)} aria-label="Edit comment" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </button>
      {/if}
      <button class="cmt-icon cmt-del" type="button" on:click={(e) => onDelete(e, ann.id)} aria-label="Delete comment" title="Delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12" />
        </svg>
      </button>
    </div>
    {#if ann.quoted_text}
      <blockquote class="cmt-snippet">{ann.quoted_text}</blockquote>
    {/if}
    {#if editing}
      <textarea
        bind:this={editEl}
        class="cmt-edit-field"
        bind:value={draft}
        rows="3"
        aria-label="Edit comment"
        on:click|stopPropagation
        on:keydown={onEditKeydown}
      ></textarea>
      <div class="cmt-edit-actions">
        <span class="edit-hint">{saveHint} save · Esc cancel</span>
        <span class="spacer"></span>
        <button class="edit-cancel" type="button" on:click|stopPropagation={onCancelEdit}>Cancel</button>
        <button class="edit-save" type="button" disabled={!draft.trim()} on:click|stopPropagation={onCommitEdit}>Save</button>
      </div>
    {:else}
      <p class="cmt-note">{ann.body}</p>
    {/if}
  </li>
{/if}

<style>
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
    align-items: center;
    justify-content: center;
    /* 24×24 pointer target (WCAG 2.5.8); the icon stays 14px, the box grows. */
    min-width: 24px;
    min-height: 24px;
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
</style>
