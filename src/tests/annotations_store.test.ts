/**
 * annotations_store.test.ts
 *
 * T2.5/A8: Serialized save chain tests.
 *
 * Covers:
 *  - Interleaved mutations both persist (chain serializes them).
 *  - An injected rejecting save does NOT block subsequent saves
 *    (chain resets to Promise.resolve() on error — R-SAVECHAIN-RECOVERY).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { annotationsStore } from '../lib/stores/annotations';
import type { Sidecar } from '../lib/types/ipc';

const mockInvoke = vi.mocked(invoke);

function makeEmptySidecar(): Sidecar {
  return {
    schema_version: 1,
    doc_content_hash: 'testhash',
    general_notes: '',
    annotations: [],
  };
}

// ---------------------------------------------------------------------------
// Helper: wait for the save chain to settle.
// We flush the microtask queue by awaiting a small chain of promises.
// ---------------------------------------------------------------------------
async function flushChain(): Promise<void> {
  // Multiple rounds to let chained .then() callbacks execute.
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('annotationsStore save chain (T2.5/A8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    annotationsStore.reset();
  });

  // ── Interleaved mutations both persist ──────────────────────────────────────

  it('interleaved mutations are both persisted via the serialized chain', async () => {
    // Load with an empty sidecar.
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar()); // load_annotations
    await annotationsStore.load('/doc.md', 'testhash');

    // Track all save_annotations calls.
    const savedSidecars: Sidecar[] = [];
    mockInvoke.mockImplementation((_cmd, args) => {
      if (_cmd === 'save_annotations') {
        savedSidecars.push((args as { sidecar: Sidecar }).sidecar);
      }
      return Promise.resolve(undefined);
    });

    // Fire two mutations without awaiting — they must enqueue on the chain.
    annotationsStore.addAnnotation(1, 1, 0, 5, 'first', 'First comment');
    annotationsStore.addAnnotation(2, 2, 0, 6, 'second', 'Second comment');

    // Flush the microtask queue.
    await flushChain();

    // Both saves must have been called.
    expect(savedSidecars.length).toBeGreaterThanOrEqual(2);

    // The final save must contain both annotations (serialized chain snapshot
    // at write time picks up latest state).
    const finalSave = savedSidecars[savedSidecars.length - 1];
    expect(finalSave.annotations.length).toBe(2);
  });

  // ── Error does not block subsequent saves ───────────────────────────────────

  it('an injected save error does not block subsequent saves (R-SAVECHAIN-RECOVERY)', async () => {
    // Load with an empty sidecar.
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'testhash');

    // Track save calls.
    let callCount = 0;
    let lastSidecar: Sidecar | null = null;

    mockInvoke.mockImplementation((_cmd, args) => {
      if (_cmd === 'save_annotations') {
        callCount++;
        if (callCount === 1) {
          // First save rejects (simulates I/O error).
          return Promise.reject(new Error('Disk full'));
        }
        lastSidecar = (args as { sidecar: Sidecar }).sidecar;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    // First mutation — will produce a rejected save.
    annotationsStore.addAnnotation(1, 1, 0, 5, 'first', 'First comment');
    await flushChain();

    // At this point the chain should have been reset after the error.
    // Second mutation must succeed (chain is unblocked).
    annotationsStore.addAnnotation(2, 2, 0, 6, 'second', 'Second comment');
    await flushChain();

    // The second save_annotations call must have been made (chain reset worked).
    expect(callCount).toBeGreaterThanOrEqual(2);
    // The second save must include the second annotation.
    expect(lastSidecar).not.toBeNull();
    expect(lastSidecar!.annotations.some((a) => a.quoted_text === 'second')).toBe(true);
  });

  // ── Error state is surfaced ─────────────────────────────────────────────────

  it('a save error is surfaced in the store error field', async () => {
    mockInvoke.mockResolvedValueOnce(makeEmptySidecar());
    await annotationsStore.load('/doc.md', 'testhash');

    mockInvoke.mockImplementation((_cmd) => {
      if (_cmd === 'save_annotations') {
        return Promise.reject(new Error('Permission denied'));
      }
      return Promise.resolve(undefined);
    });

    annotationsStore.addAnnotation(1, 1, 0, 5, 'text', 'body');
    await flushChain();

    const state = get(annotationsStore);
    expect(state.error).toContain('Permission denied');
  });
});
