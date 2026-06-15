<script lang="ts">
  /**
   * ExportDialog.svelte — native <dialog> for PDF/HTML export (C5).
   *
   * Provides:
   *  - Format selector: PDF or HTML radio buttons.
   *  - Include-comments checkbox (disabled when no comments or general notes, per D6).
   *  - Descriptor copy "Includes N anchored, M detached (as endnotes)".
   *  - Export button: calls buildExportDocument → save dialog → exportHtml / exportPdf.
   *  - "Exporting…" disabled state during async op.
   *  - Toast store for success/error messages.
   *  - Cancel = no-op (dialog closes, nothing written).
   *
   * Dependencies on other workstreams supplied via props (avoiding direct module
   * imports so this component compiles independently before WS-A/B land):
   *   - `buildExportDocument` (WS-B, documentExport.ts) — passed in as a prop.
   *   - `exportHtml` / `exportPdf` (WS-A, ipc.ts additions) — passed in as props.
   *
   * Wired from App.svelte via on:exportDocument.
   * Decisions: agent-agnostic labels (no "Claude"/"Copilot").
   */

  import { createEventDispatcher } from 'svelte';
  import { save as saveDialog } from '@tauri-apps/plugin-dialog';
  import { toast } from './stores/toast';
  import type { Annotation } from './types/ipc';

  // ---------------------------------------------------------------------------
  // Types for WS-A/B deliverables (matched to plan contract)
  // These props will be bound by App.svelte once WS-A and WS-B land.
  // ---------------------------------------------------------------------------

  interface BuildExportOpts {
    docPath: string;
    includeComments: boolean;
    annotations: Annotation[];
    generalNotes: string;
  }

  type BuildExportFn = (content: string, opts: BuildExportOpts) => Promise<string>;
  type ExportHtmlFn = (outPath: string, html: string) => Promise<void>;
  type ExportPdfFn = (outPath: string, html: string) => Promise<void>;

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  /** Whether the dialog is open. Driven from App.svelte. */
  export let open: boolean = false;

  /** Canonical path of the currently active document (used as save-dialog default). */
  export let docPath: string = '';

  /** Current annotation list (passed down from App annotationsStore). */
  export let annotations: Annotation[] = [];

  /** General notes text (passed down from App annotationsStore). */
  export let generalNotes: string = '';

  /** Raw markdown source (passed to buildExportDocument). */
  export let content: string = '';

  /**
   * WS-B deliverable: buildExportDocument. Injected by App.svelte once WS-B lands.
   * Falls back to a no-op placeholder that returns the raw content so the dialog
   * does not crash if called before WS-B is integrated.
   */
  export let buildExportDocument: BuildExportFn = async (src) => src;

  /**
   * WS-A deliverable: exportHtml IPC wrapper. Injected by App.svelte.
   * Falls back to a no-op that logs a warning.
   */
  export let exportHtml: ExportHtmlFn = async () => {
    throw new Error('exportHtml: WS-A IPC wrapper not yet wired');
  };

  /**
   * WS-A deliverable: exportPdf IPC wrapper. Injected by App.svelte.
   * Falls back to a no-op that throws so the error toast fires.
   */
  export let exportPdf: ExportPdfFn = async () => {
    throw new Error('exportPdf: WS-A IPC wrapper not yet wired');
  };

  // ---------------------------------------------------------------------------
  // Local state
  // ---------------------------------------------------------------------------

  const dispatch = createEventDispatcher<{ close: void }>();

  let dialog: HTMLDialogElement | undefined;
  let format: 'pdf' | 'html' = 'pdf';
  let includeComments = false;
  let exporting = false;

  // Drive the native modal from the `open` prop.
  $: if (dialog) {
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }

  // Reset format/state when dialog opens afresh.
  $: if (open) {
    format = 'pdf';
    includeComments = false;
    exporting = false;
  }

  // ---------------------------------------------------------------------------
  // Computed annotation stats (D6)
  // ---------------------------------------------------------------------------

  $: anchored = annotations.filter(
    (a) => a.status === 'anchored' || a.status === 'block_level',
  );
  $: detached = annotations.filter((a) => a.status === 'detached');
  $: hasCommentContent = annotations.length > 0 || generalNotes.trim().length > 0;

  $: descriptorCopy = (() => {
    const a = anchored.length;
    const d = detached.length;
    if (a === 0 && d === 0) {
      return generalNotes.trim() ? 'General notes will be included.' : '';
    }
    const parts: string[] = [];
    if (a > 0) parts.push(`${a} anchored`);
    if (d > 0) parts.push(`${d} detached (as endnotes)`);
    return `Includes ${parts.join(', ')}.`;
  })();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function docBaseName(): string {
    const slash = docPath.lastIndexOf('/');
    const backslash = docPath.lastIndexOf('\\');
    const idx = Math.max(slash, backslash);
    return idx === -1 ? docPath : docPath.slice(idx + 1);
  }

  function defaultSaveName(): string {
    const base = docBaseName();
    const stripped = base.endsWith('.md') ? base.slice(0, -3) : base;
    return `${stripped}.${format}`;
  }

  function defaultSavePath(): string {
    if (!docPath) return defaultSaveName();
    const slash = docPath.lastIndexOf('/');
    const backslash = docPath.lastIndexOf('\\');
    const dirEnd = Math.max(slash, backslash);
    const dir = dirEnd === -1 ? '' : docPath.slice(0, dirEnd + 1);
    return dir + defaultSaveName();
  }

  function errMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return String(err);
  }

  // ---------------------------------------------------------------------------
  // Export action
  // ---------------------------------------------------------------------------

  async function handleExport() {
    exporting = true;
    try {
      const ext = format === 'pdf' ? 'pdf' : 'html';
      const outPath = await saveDialog({
        title: format === 'pdf' ? 'Save PDF' : 'Save HTML',
        defaultPath: defaultSavePath(),
        filters: [
          {
            name: format === 'pdf' ? 'PDF document' : 'HTML document',
            extensions: [ext],
          },
        ],
      });

      if (!outPath) {
        // User cancelled the save dialog — no-op.
        return;
      }

      const html = await buildExportDocument(content, {
        docPath,
        includeComments,
        annotations,
        generalNotes,
      });

      if (format === 'html') {
        await exportHtml(outPath, html);
        toast.show(`HTML saved: ${docBaseName().replace(/\.md$/, '.html')}`);
      } else {
        await exportPdf(outPath, html);
        toast.show(`PDF saved: ${docBaseName().replace(/\.md$/, '.pdf')}`);
      }
      close();
    } catch (err) {
      toast.show(`Export failed: ${errMessage(err)}`);
    } finally {
      exporting = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Close helpers
  // ---------------------------------------------------------------------------

  function close() {
    dispatch('close');
  }

  // Esc fires `cancel` on the native dialog. Prevent the browser's default
  // auto-close; close via the prop-driven reactive block instead.
  function handleCancel(e: Event) {
    e.preventDefault();
    close();
  }
</script>

<dialog
  bind:this={dialog}
  class="modal"
  aria-labelledby="export-title"
  aria-describedby="export-desc"
  on:cancel={handleCancel}
>
  <h3 id="export-title">Export document</h3>
  <p id="export-desc" class="modal-sub">
    Save a self-contained copy of this document.
  </p>

  <!-- Format selector -->
  <fieldset class="format-group">
    <legend class="field-label">Format</legend>
    <label class="radio-row">
      <input type="radio" bind:group={format} value="pdf" name="export-format" />
      <span class="radio-label">
        <span class="radio-title">PDF</span>
        <span class="radio-hint">Letter, 0.6in margins, fonts embedded</span>
      </span>
    </label>
    <label class="radio-row">
      <input type="radio" bind:group={format} value="html" name="export-format" />
      <span class="radio-label">
        <span class="radio-title">HTML</span>
        <span class="radio-hint">Standalone file, opens in any browser</span>
      </span>
    </label>
  </fieldset>

  <!-- Include comments (D6: disabled when no annotations AND no general notes) -->
  <div class="comments-row">
    <label class="checkbox-row" class:disabled={!hasCommentContent}>
      <input
        type="checkbox"
        bind:checked={includeComments}
        disabled={!hasCommentContent}
        aria-describedby={hasCommentContent ? 'export-comment-desc' : undefined}
      />
      <span class="checkbox-label">Include comments</span>
    </label>
    {#if hasCommentContent && descriptorCopy}
      <p id="export-comment-desc" class="comment-desc">{descriptorCopy}</p>
    {:else if !hasCommentContent}
      <p class="comment-desc comment-empty">No comments or notes to include.</p>
    {/if}
  </div>

  <!-- Actions -->
  <div class="modal-actions">
    <button
      type="button"
      class="btn btn-secondary"
      on:click={close}
      disabled={exporting}
    >
      Cancel
    </button>
    <!-- svelte-ignore a11y-autofocus -->
    <button
      type="button"
      class="btn btn-primary"
      on:click={handleExport}
      disabled={exporting}
      autofocus
    >
      {#if exporting}
        <svg class="spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-dasharray="28 8" />
        </svg>
        Exporting…
      {:else}
        Export
      {/if}
    </button>
  </div>
</dialog>

<style>
  .modal {
    margin: auto;
    width: 440px;
    max-width: 92vw;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 22px 24px;
  }
  .modal[open] {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    animation: modal-in var(--dur-slow) var(--ease-out);
  }
  .modal::backdrop {
    background: color-mix(in srgb, var(--bg) 35%, rgba(0, 0, 0, .45));
    backdrop-filter: blur(2px);
    animation: scrim-in var(--dur-base) var(--ease-out);
  }
  @keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modal-in {
    from { opacity: 0; transform: translateY(8px) scale(.985); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .modal[open], .modal::backdrop { animation: none; }
  }

  .modal h3 {
    margin: 0;
    font-size: var(--fs-xl);
    font-weight: var(--fw-semibold);
    letter-spacing: -.01em;
    color: var(--text);
  }
  .modal-sub {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }

  /* Format fieldset */
  .format-group {
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: 10px 14px;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field-label {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    letter-spacing: .04em;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 0;
    margin-bottom: 2px;
  }
  .radio-row {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2);
    cursor: pointer;
  }
  .radio-row input[type="radio"] {
    margin-top: 3px;
    accent-color: var(--accent);
    flex: none;
  }
  .radio-label { display: flex; flex-direction: column; gap: 1px; }
  .radio-title { font-size: var(--fs-base); font-weight: var(--fw-medium); color: var(--text); }
  .radio-hint { font-size: var(--fs-xs); color: var(--text-faint); }

  /* Comments row */
  .comments-row {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .checkbox-row {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
    font-size: var(--fs-base);
    color: var(--text);
  }
  .checkbox-row.disabled {
    cursor: default;
    color: var(--text-faint);
  }
  .checkbox-row input[type="checkbox"] {
    accent-color: var(--accent);
    flex: none;
  }
  .checkbox-row input[type="checkbox"]:disabled { opacity: 0.5; }
  .checkbox-label { font-weight: var(--fw-medium); }

  .comment-desc {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-faint);
    padding-left: 22px;
    line-height: var(--lh-snug);
  }
  .comment-empty { font-style: italic; }

  /* Actions */
  .modal-actions {
    display: flex;
    gap: var(--sp-2);
    justify-content: flex-end;
    margin-top: var(--sp-2);
  }
  .btn {
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    line-height: 1;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    cursor: pointer;
    padding: 8px 14px;
    border-radius: var(--r-md);
    border: 1px solid transparent;
    transition: background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .btn:disabled { opacity: 0.55; cursor: default; }
  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
    font-weight: var(--fw-semibold);
    box-shadow: var(--accent-shadow);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
  .btn-secondary {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
    box-shadow: var(--shadow-sm);
  }
  .btn-secondary:hover:not(:disabled) { border-color: var(--border-strong); }

  /* Export spinner */
  .spinner {
    width: 14px;
    height: 14px;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
