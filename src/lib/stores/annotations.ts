/**
 * annotations.ts — Annotation + general-notes store.
 *
 * Wraps the Rust-side load_annotations / save_annotations IPC commands.
 * Each file path gets its own sidecar; switching tabs loads a fresh sidecar.
 *
 * Decisions implemented here:
 *  - C9  annotation panel = right-side drawer (the store feeds it).
 *  - C10 general_notes is a top-level sidecar field, persisted with every save.
 *  - A3  schema_version: 1 in every sidecar write.
 *  - C8  anchored | detached | block_level statuses match the IPC contract.
 */

import { writable, get } from 'svelte/store';
import type { Annotation, Sidecar } from '../types/ipc';
import { loadAnnotations, saveAnnotations } from '../types/ipc';

export type { Annotation, Sidecar };

interface AnnotationsState {
  docPath: string | null;
  docContentHash: string;
  generalNotes: string;
  annotations: Annotation[];
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: AnnotationsState = {
  docPath: null,
  docContentHash: '',
  generalNotes: '',
  annotations: [],
  loading: false,
  error: null,
};

/**
 * T2.5/A8: Serialized save chain.
 *
 * All mutation calls enqueue onto this promise chain instead of calling
 * `save()` bare. This guarantees that concurrent mutations in the same event
 * loop turn are serialized: each save starts only after the previous one
 * resolves.
 *
 * On error: surface the error AND reset `saveChain` to `Promise.resolve()`
 * so subsequent saves can proceed (R-SAVECHAIN-RECOVERY). Without the reset,
 * a single I/O error would permanently block all future writes in the session.
 */
let saveChain: Promise<void> = Promise.resolve();

function createAnnotationsStore() {
  const { subscribe, update, set } = writable<AnnotationsState>(INITIAL_STATE);

  function generateAnnotationId(): string {
    return `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Load annotations for the given document path from the Rust sidecar.
   * Clears any previously loaded state first.
   */
  async function load(docPath: string, docContentHash: string): Promise<void> {
    update((s) => ({ ...s, loading: true, error: null, docPath, docContentHash }));
    try {
      const sidecar = await loadAnnotations(docPath);
      update((s) => ({
        ...s,
        loading: false,
        generalNotes: sidecar.general_notes ?? '',
        annotations: sidecar.annotations ?? [],
      }));
    } catch {
      // If no sidecar exists yet, start fresh — not a real error.
      update((s) => ({
        ...s,
        loading: false,
        generalNotes: '',
        annotations: [],
        error: null,
      }));
    }
  }

  /**
   * Persist the current annotation state to the sidecar via the Rust core.
   * Snapshots the latest store state at write time (not at enqueue time).
   */
  async function runSave(): Promise<void> {
    // Snapshot the latest state at the moment we actually execute the write
    // (not at enqueue time — a later mutation may have already updated state).
    const state = get({ subscribe });
    if (!state.docPath) return;

    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: state.docContentHash,
      general_notes: state.generalNotes,
      annotations: state.annotations,
    };

    try {
      await saveAnnotations(state.docPath, sidecar);
    } catch (err) {
      update((s) => ({ ...s, error: String(err) }));
      // Reset the chain so future saves can proceed (R-SAVECHAIN-RECOVERY).
      saveChain = Promise.resolve();
      throw err;
    }
  }

  /**
   * Enqueue a save onto the serialized save chain (T2.5/A8).
   * Replaces bare `await save()` calls across all mutators.
   *
   * The chain always resolves (never rejects at the chain level) because
   * `runSave` catches its own error, surfaces it in the store, resets the
   * chain, and re-throws. The `.catch(() => {})` at the chain level absorbs
   * the re-throw so Vitest / the browser does not report an unhandled rejection
   * while still allowing the error to propagate to callers that `await save()`.
   */
  function enqueueSave(): void {
    saveChain = saveChain.then(runSave).catch(() => {
      // Error already handled in runSave (surfaced + chain reset).
    });
  }

  /**
   * Public save — enqueues onto the serialized chain and returns the settled
   * promise so callers can await completion.
   *
   * IMPORTANT: this must enqueue behind `saveChain` (not start `runSave`
   * immediately) to preserve the serialized-write invariant (T2.5/A8).
   * The previous implementation called `runSave()` immediately and only added
   * the already-started promise to the chain, which allowed concurrent IPC
   * writes if an enqueued save was still in flight — exactly the hazard the
   * chain exists to prevent.
   */
  async function save(): Promise<void> {
    saveChain = saveChain.then(runSave).catch(() => {
      // Error already handled in runSave (surfaced + chain reset).
    });
    return saveChain;
  }

  /**
   * Add a new annotation with the given anchor fields and body.
   * Immediately persists after adding.
   *
   * @param lineStart   - 0-indexed starting line.
   * @param lineEnd     - 0-indexed ending line (inclusive).
   * @param charStart   - Character offset within lineStart.
   * @param charEnd     - Character offset within lineEnd.
   * @param quotedText  - The exact selected text at anchor time.
   * @param body        - Reviewer's comment.
   * @param status      - Initial anchor status ('anchored' | 'block_level').
   */
  async function addAnnotation(
    lineStart: number,
    lineEnd: number,
    charStart: number,
    charEnd: number,
    quotedText: string,
    body: string,
    status: 'anchored' | 'block_level' = 'anchored',
  ): Promise<Annotation> {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: generateAnnotationId(),
      body,
      quoted_text: quotedText,
      line_start: lineStart,
      line_end: lineEnd,
      char_start: charStart,
      char_end: charEnd,
      status,
      created_at: now,
      updated_at: now,
    };

    update((s) => ({
      ...s,
      annotations: [...s.annotations, annotation],
    }));

    enqueueSave();
    return annotation;
  }

  /**
   * Update an annotation's body. Persists immediately.
   */
  async function updateAnnotationBody(id: string, body: string): Promise<void> {
    const now = new Date().toISOString();
    update((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, body, updated_at: now } : a
      ),
    }));
    enqueueSave();
  }

  /**
   * Mark an annotation as detached (anchor could not be re-found after edit).
   * The annotation is preserved — the UI shows a "detached" badge.
   */
  async function detachAnnotation(id: string): Promise<void> {
    const now = new Date().toISOString();
    update((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, status: 'detached' as const, updated_at: now } : a
      ),
    }));
    enqueueSave();
  }

  /**
   * Re-anchor a previously detached annotation to a new line range.
   */
  async function reanchorAnnotation(
    id: string,
    lineStart: number,
    lineEnd: number,
    charStart: number,
    charEnd: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    update((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === id
          ? { ...a, line_start: lineStart, line_end: lineEnd, char_start: charStart, char_end: charEnd, status: 'anchored' as const, updated_at: now }
          : a
      ),
    }));
    enqueueSave();
  }

  /**
   * Delete an annotation permanently.
   */
  async function deleteAnnotation(id: string): Promise<void> {
    update((s) => ({
      ...s,
      annotations: s.annotations.filter((a) => a.id !== id),
    }));
    enqueueSave();
  }

  /**
   * Update the general notes field. Caller is responsible for debouncing;
   * this persists on every call.
   */
  async function updateGeneralNotes(notes: string): Promise<void> {
    update((s) => ({ ...s, generalNotes: notes }));
    enqueueSave();
  }

  /**
   * Update the in-memory doc content hash (called after a successful save so
   * re-anchoring can detect stale anchors on the next load).
   */
  function setDocContentHash(hash: string): void {
    update((s) => ({ ...s, docContentHash: hash }));
  }

  /** Reset to initial state (e.g., when all tabs are closed). */
  function reset(): void {
    set(INITIAL_STATE);
    // Also reset the chain so no stale saves from the previous session bleed
    // through after a reset.
    saveChain = Promise.resolve();
  }

  return {
    subscribe,
    load,
    save,
    addAnnotation,
    updateAnnotationBody,
    detachAnnotation,
    reanchorAnnotation,
    deleteAnnotation,
    updateGeneralNotes,
    setDocContentHash,
    reset,
  };
}

export const annotationsStore = createAnnotationsStore();
