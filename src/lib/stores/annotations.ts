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
 *  - C8  both editor-side and preview-side anchors are supported in v1.
 */

import { writable, get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import type { Annotation, Sidecar, AnchorV1 } from '../types/ipc';

export type { Annotation, AnchorV1 };

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
      const sidecar = await invoke<Sidecar>('load_annotations', { doc_path: docPath });
      update((s) => ({
        ...s,
        loading: false,
        generalNotes: sidecar.general_notes ?? '',
        annotations: sidecar.annotations ?? [],
      }));
    } catch (err) {
      // If no sidecar exists yet, start fresh.
      update((s) => ({
        ...s,
        loading: false,
        generalNotes: '',
        annotations: [],
        error: null, // not a real error — file just doesn't exist yet
      }));
    }
  }

  /**
   * Persist the current annotation state to the sidecar via the Rust core.
   */
  async function save(): Promise<void> {
    const state = get({ subscribe });
    if (!state.docPath) return;

    const sidecar: Sidecar = {
      schema_version: 1,
      doc_path: state.docPath,
      doc_content_hash: state.docContentHash,
      general_notes: state.generalNotes,
      annotations: state.annotations,
    };

    try {
      await invoke('save_annotations', {
        doc_path: state.docPath,
        sidecar,
      });
    } catch (err) {
      update((s) => ({ ...s, error: String(err) }));
      throw err;
    }
  }

  /**
   * Add a new annotation with the given anchor and body.
   * Immediately persists after adding.
   */
  async function addAnnotation(anchor: AnchorV1, body: string): Promise<Annotation> {
    const now = new Date().toISOString();
    const annotation: Annotation = {
      id: generateAnnotationId(),
      anchor,
      body,
      status: 'open',
      created_at: now,
    };

    update((s) => ({
      ...s,
      annotations: [...s.annotations, annotation],
    }));

    await save();
    return annotation;
  }

  /**
   * Resolve an annotation (mark it as resolved). Persists immediately.
   */
  async function resolveAnnotation(id: string): Promise<void> {
    const now = new Date().toISOString();
    update((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, status: 'resolved', resolved_at: now } : a
      ),
    }));
    await save();
  }

  /**
   * Reopen a resolved annotation.
   */
  async function reopenAnnotation(id: string): Promise<void> {
    update((s) => ({
      ...s,
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, status: 'open', resolved_at: undefined } : a
      ),
    }));
    await save();
  }

  /**
   * Delete an annotation permanently.
   */
  async function deleteAnnotation(id: string): Promise<void> {
    update((s) => ({
      ...s,
      annotations: s.annotations.filter((a) => a.id !== id),
    }));
    await save();
  }

  /**
   * Update the general notes field. Caller is responsible for debouncing;
   * this persists on every call.
   */
  async function updateGeneralNotes(notes: string): Promise<void> {
    update((s) => ({ ...s, generalNotes: notes }));
    await save();
  }

  /**
   * Update the in-memory doc content hash (called after a successful save so
   * re-anchoring can detect stale anchors).
   */
  function setDocContentHash(hash: string): void {
    update((s) => ({ ...s, docContentHash: hash }));
  }

  /** Reset to initial state (e.g., when all tabs are closed). */
  function reset(): void {
    set(INITIAL_STATE);
  }

  return {
    subscribe,
    load,
    save,
    addAnnotation,
    resolveAnnotation,
    reopenAnnotation,
    deleteAnnotation,
    updateGeneralNotes,
    setDocContentHash,
    reset,
  };
}

export const annotationsStore = createAnnotationsStore();
