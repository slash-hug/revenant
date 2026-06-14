/**
 * annotations.test.ts
 *
 * Tests for the annotations Svelte store.
 *
 * Covers:
 *  - add/detach/reanchor/delete annotation lifecycle.
 *  - Detached annotations are retained with 'detached' status.
 *  - General notes persistence.
 *  - schema_version: 1 is always written to the sidecar.
 *
 * Note on mutator calls: addAnnotation, detachAnnotation, reanchorAnnotation,
 * deleteAnnotation, and updateGeneralNotes are synchronous — they return values
 * immediately and enqueue a fire-and-forget save on the serialized chain. Tests
 * flush the microtask queue via flushChain() when they need the save to have run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { annotationsStore } from '../lib/stores/annotations';
import type { Sidecar } from '../lib/types/ipc';

// The setup.ts file mocks @tauri-apps/api/core; we just cast invoke to a spy.
const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySidecar(): Sidecar {
  return {
    schema_version: 1,
    doc_content_hash: 'hash001',
    general_notes: '',
    annotations: [],
  };
}

/** Flush the microtask queue to let the save chain execute. */
async function flushChain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('annotationsStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store to initial state before each test.
    annotationsStore.reset();
  });

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  it('loads annotations from the Rust sidecar on load()', async () => {
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: 'hash001',
      general_notes: 'Some notes',
      annotations: [
        {
          id: 'a1',
          status: 'anchored',
          body: 'Check this',
          quoted_text: 'test text',
          line_start: 5,
          line_end: 5,
          char_start: 0,
          char_end: 9,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    mockInvoke.mockResolvedValueOnce(sidecar);

    await annotationsStore.load('/doc.md', 'hash001');

    const state = get(annotationsStore);
    expect(state.annotations).toHaveLength(1);
    expect(state.annotations[0].id).toBe('a1');
    expect(state.generalNotes).toBe('Some notes');
  });

  it('starts fresh if no sidecar exists (load_annotations throws)', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('No sidecar'));

    await annotationsStore.load('/new-doc.md', 'hash002');

    const state = get(annotationsStore);
    expect(state.annotations).toHaveLength(0);
    expect(state.generalNotes).toBe('');
    expect(state.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Add annotation
  // -------------------------------------------------------------------------

  it('adds a new anchored annotation and saves', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar()); // load_annotations
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined); // save_annotations
    const ann = annotationsStore.addAnnotation(
      10,   // lineStart
      10,   // lineEnd
      0,    // charStart
      5,    // charEnd
      'hello', // quotedText
      'This needs work', // body
    );
    await flushChain();

    const state = get(annotationsStore);
    expect(state.annotations).toHaveLength(1);
    expect(ann.status).toBe('anchored');
    expect(ann.body).toBe('This needs work');
    expect(ann.quoted_text).toBe('hello');
    // Verify save was called.
    expect(mockInvoke).toHaveBeenCalledWith('save_annotations', expect.anything());
  });

  it('adds a block_level annotation for transformed blocks', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined);
    const ann = annotationsStore.addAnnotation(
      5, 5, 0, 0, '', 'Mermaid diagram issue', 'block_level'
    );
    await flushChain();

    expect(ann.status).toBe('block_level');
  });

  // -------------------------------------------------------------------------
  // Detach / re-anchor
  // -------------------------------------------------------------------------

  it('marks an annotation as detached', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined); // save on add
    const ann = annotationsStore.addAnnotation(1, 1, 0, 1, 'x', 'A comment');
    await flushChain();

    mockInvoke.mockResolvedValueOnce(undefined); // save on detach
    annotationsStore.detachAnnotation(ann.id);
    await flushChain();

    const state = get(annotationsStore);
    const found = state.annotations.find((a) => a.id === ann.id);
    expect(found?.status).toBe('detached');
  });

  it('re-anchors a detached annotation to new position', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined);
    const ann = annotationsStore.addAnnotation(1, 1, 0, 1, 'y', 'Body');
    await flushChain();

    mockInvoke.mockResolvedValueOnce(undefined);
    annotationsStore.detachAnnotation(ann.id);
    await flushChain();

    mockInvoke.mockResolvedValueOnce(undefined);
    annotationsStore.reanchorAnnotation(ann.id, 5, 5, 0, 10);
    await flushChain();

    const state = get(annotationsStore);
    const found = state.annotations.find((a) => a.id === ann.id);
    expect(found?.status).toBe('anchored');
    expect(found?.line_start).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Detached annotations are retained
  // -------------------------------------------------------------------------

  it('detached annotations are retained and their status is detached', async () => {
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_content_hash: 'newhash',
      general_notes: '',
      annotations: [
        {
          id: 'd1',
          status: 'detached',
          body: 'Old paragraph was here',
          quoted_text: 'moved text',
          line_start: 200,
          line_end: 200,
          char_start: 0,
          char_end: 10,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    mockInvoke.mockResolvedValueOnce(sidecar);
    await annotationsStore.load('/doc.md', 'newhash');

    const state = get(annotationsStore);
    const detached = state.annotations.filter((a) => a.status === 'detached');
    expect(detached).toHaveLength(1);
    expect(detached[0].id).toBe('d1');
  });

  // -------------------------------------------------------------------------
  // General notes
  // -------------------------------------------------------------------------

  it('updates general notes and persists on updateGeneralNotes()', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined);
    annotationsStore.updateGeneralNotes('My notes here');
    await flushChain();

    const state = get(annotationsStore);
    expect(state.generalNotes).toBe('My notes here');
    expect(mockInvoke).toHaveBeenCalledWith('save_annotations', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Schema version
  // -------------------------------------------------------------------------

  it('always writes schema_version: 1 to the sidecar payload', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    let capturedArgs: unknown;
    mockInvoke.mockImplementationOnce((_cmd, args) => {
      capturedArgs = args;
      return Promise.resolve(undefined);
    });

    annotationsStore.addAnnotation(1, 1, 0, 1, 'z', 'test body');
    await flushChain();

    const sidecar = (capturedArgs as { sidecar: Sidecar }).sidecar;
    expect(sidecar.schema_version).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  it('deletes an annotation by id', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined);
    const ann = annotationsStore.addAnnotation(1, 1, 0, 1, 'w', 'To delete');
    await flushChain();

    mockInvoke.mockResolvedValueOnce(undefined);
    annotationsStore.deleteAnnotation(ann.id);
    await flushChain();

    const state = get(annotationsStore);
    expect(state.annotations.find((a) => a.id === ann.id)).toBeUndefined();
  });
});
