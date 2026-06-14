/**
 * annotation_undo.test.ts — UX #11: undoable delete + toast store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { annotationsStore } from '../lib/stores/annotations';
import { toast } from '../lib/stores/toast';

function seed() {
  annotationsStore.reset();
  annotationsStore.addAnnotation(0, 0, 0, 1, 'a', 'first');
  annotationsStore.addAnnotation(1, 1, 0, 1, 'b', 'second');
  annotationsStore.addAnnotation(2, 2, 0, 1, 'c', 'third');
}

describe('annotationsStore delete/restore (undo)', () => {
  beforeEach(seed);

  it('deleteAnnotation returns the removed annotation + its index', () => {
    const ids = get(annotationsStore).annotations.map((a) => a.id);
    const removed = annotationsStore.deleteAnnotation(ids[1]);
    expect(removed).not.toBeNull();
    expect(removed!.index).toBe(1);
    expect(removed!.annotation.id).toBe(ids[1]);
    expect(get(annotationsStore).annotations.map((a) => a.id)).toEqual([ids[0], ids[2]]);
  });

  it('restoreAnnotation re-inserts at the original index', () => {
    const ids = get(annotationsStore).annotations.map((a) => a.id);
    const removed = annotationsStore.deleteAnnotation(ids[1]);
    annotationsStore.restoreAnnotation(removed);
    expect(get(annotationsStore).annotations.map((a) => a.id)).toEqual(ids);
  });

  it('deleteAnnotation returns null for an unknown id', () => {
    expect(annotationsStore.deleteAnnotation('does-not-exist')).toBeNull();
  });

  it('restoreAnnotation is a no-op when the annotation is already present (double-undo)', () => {
    const ids = get(annotationsStore).annotations.map((a) => a.id);
    const removed = annotationsStore.deleteAnnotation(ids[0]);
    annotationsStore.restoreAnnotation(removed);
    annotationsStore.restoreAnnotation(removed); // second undo must not duplicate
    expect(get(annotationsStore).annotations.filter((a) => a.id === ids[0])).toHaveLength(1);
  });
});

describe('toast store', () => {
  it('show sets the message + action; dismiss clears it', () => {
    let acted = false;
    toast.show('Comment deleted', { actionLabel: 'Undo', onAction: () => { acted = true; } });
    const t = get(toast);
    expect(t?.message).toBe('Comment deleted');
    expect(t?.actionLabel).toBe('Undo');
    t?.onAction?.();
    expect(acted).toBe(true);
    toast.dismiss();
    expect(get(toast)).toBeNull();
  });

  it('a new toast replaces the previous one', () => {
    const id1 = toast.show('first');
    const id2 = toast.show('second');
    expect(id2).toBeGreaterThan(id1);
    expect(get(toast)?.message).toBe('second');
    toast.dismiss();
  });
});
