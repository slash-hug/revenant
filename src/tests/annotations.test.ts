/**
 * annotations.test.ts
 *
 * Tests for the annotations Svelte store.
 *
 * Covers:
 *  - create/resolve/reopen/delete annotation lifecycle.
 *  - Detached annotations are displayed with the detached flag.
 *  - General notes persistence.
 *  - Schema_version: 1 is always written to the sidecar.
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

function makeEmptySidecar(docPath = '/doc.md'): Sidecar {
  return {
    schema_version: 1,
    doc_path: docPath,
    doc_content_hash: 'hash001',
    general_notes: '',
    annotations: [],
  };
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
      doc_path: '/doc.md',
      doc_content_hash: 'hash001',
      general_notes: 'Some notes',
      annotations: [
        {
          id: 'a1',
          status: 'open',
          body: 'Check this',
          created_at: '2026-01-01T00:00:00Z',
          anchor: {
            type: 'source',
            anchor: {
              start_line: 5,
              end_line: 5,
              start_char: 0,
              end_char: 10,
              quoted_text: 'test text',
              context_before: '',
              context_after: '',
            },
          },
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

  it('adds a new open annotation and saves', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar()); // load_annotations
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined); // save_annotations
    const ann = await annotationsStore.addAnnotation(
      {
        type: 'source',
        anchor: {
          start_line: 10,
          end_line: 10,
          start_char: 0,
          end_char: 5,
          quoted_text: 'hello',
          context_before: '',
          context_after: '',
        },
      },
      'This needs work'
    );

    const state = get(annotationsStore);
    expect(state.annotations).toHaveLength(1);
    expect(ann.status).toBe('open');
    expect(ann.body).toBe('This needs work');
    // Verify save was called.
    expect(mockInvoke).toHaveBeenCalledWith('save_annotations', expect.anything());
  });

  // -------------------------------------------------------------------------
  // Resolve / reopen
  // -------------------------------------------------------------------------

  it('resolves an annotation and sets resolved_at', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined); // save on add
    const ann = await annotationsStore.addAnnotation(
      { type: 'source', anchor: { start_line: 1, end_line: 1, start_char: 0, end_char: 1, quoted_text: 'x', context_before: '', context_after: '' } },
      'A comment'
    );

    mockInvoke.mockResolvedValueOnce(undefined); // save on resolve
    await annotationsStore.resolveAnnotation(ann.id);

    const state = get(annotationsStore);
    const resolved = state.annotations.find((a) => a.id === ann.id);
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolved_at).toBeTruthy();
  });

  it('reopens a resolved annotation', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'hash001');

    mockInvoke.mockResolvedValueOnce(undefined);
    const ann = await annotationsStore.addAnnotation(
      { type: 'source', anchor: { start_line: 1, end_line: 1, start_char: 0, end_char: 1, quoted_text: 'y', context_before: '', context_after: '' } },
      'Body'
    );

    mockInvoke.mockResolvedValueOnce(undefined);
    await annotationsStore.resolveAnnotation(ann.id);

    mockInvoke.mockResolvedValueOnce(undefined);
    await annotationsStore.reopenAnnotation(ann.id);

    const state = get(annotationsStore);
    const reopened = state.annotations.find((a) => a.id === ann.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.resolved_at).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Detached display
  // -------------------------------------------------------------------------

  it('detached annotations are retained and their status is detached', async () => {
    const sidecar: Sidecar = {
      schema_version: 1,
      doc_path: '/doc.md',
      doc_content_hash: 'newhash',
      general_notes: '',
      annotations: [
        {
          id: 'd1',
          status: 'detached',
          body: 'Old paragraph was here',
          created_at: '2026-01-01T00:00:00Z',
          anchor: {
            type: 'source',
            anchor: {
              start_line: 200,
              end_line: 200,
              start_char: 0,
              end_char: 5,
              quoted_text: 'moved text',
              context_before: '',
              context_after: '',
            },
          },
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
    await annotationsStore.updateGeneralNotes('My notes here');

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

    await annotationsStore.addAnnotation(
      { type: 'source', anchor: { start_line: 1, end_line: 1, start_char: 0, end_char: 1, quoted_text: 'z', context_before: '', context_after: '' } },
      'test body'
    );

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
    const ann = await annotationsStore.addAnnotation(
      { type: 'source', anchor: { start_line: 1, end_line: 1, start_char: 0, end_char: 1, quoted_text: 'w', context_before: '', context_after: '' } },
      'To delete'
    );

    mockInvoke.mockResolvedValueOnce(undefined);
    await annotationsStore.deleteAnnotation(ann.id);

    const state = get(annotationsStore);
    expect(state.annotations.find((a) => a.id === ann.id)).toBeUndefined();
  });
});
