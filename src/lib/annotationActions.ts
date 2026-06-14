/**
 * annotationActions.ts — shared annotation UI actions used by both the drawer
 * and the in-document popover, so delete behaves identically everywhere.
 */
import { annotationsStore } from './stores/annotations';
import { toast } from './stores/toast';
import type { Annotation } from './types/ipc';

/**
 * Delete an annotation immediately and show an "Undo" toast (UX #11 — replaces
 * the two-step inline confirm). Undo re-inserts it at its original index.
 */
export function deleteAnnotationWithUndo(id: string): void {
  const removed = annotationsStore.deleteAnnotation(id);
  if (!removed) return;
  toast.show('Comment deleted', {
    actionLabel: 'Undo',
    onAction: () => annotationsStore.restoreAnnotation(removed),
  });
}

/**
 * Save an edited comment body (UX #17). Empty/whitespace-only bodies are
 * disallowed — the original text stays (deleting is a separate, undoable
 * action). Returns true if the edit was saved, false if rejected as empty.
 */
export function saveAnnotationEdit(id: string, body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  annotationsStore.updateAnnotationBody(id, trimmed);
  return true;
}

/**
 * Pick the next (`dir: 1`) or previous (`dir: -1`) annotation in document order
 * relative to `activeId`, for keyboard cycling (#16). Only anchored/block_level
 * annotations participate (detached have no document position). Wraps around;
 * with no active annotation, starts at the first (next) or last (prev). Returns
 * null when there are none.
 */
export function cycleAnnotationId(
  annotations: Annotation[],
  activeId: string | null,
  dir: 1 | -1,
): string | null {
  const list = annotations
    .filter((a) => a.status === 'anchored' || a.status === 'block_level')
    .slice()
    .sort((a, b) => a.line_start - b.line_start || a.char_start - b.char_start);
  if (list.length === 0) return null;
  const idx = activeId ? list.findIndex((a) => a.id === activeId) : -1;
  if (idx === -1) return dir === 1 ? list[0].id : list[list.length - 1].id;
  return list[(idx + dir + list.length) % list.length].id;
}
