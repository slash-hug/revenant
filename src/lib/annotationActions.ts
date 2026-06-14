/**
 * annotationActions.ts — shared annotation UI actions used by both the drawer
 * and the in-document popover, so delete behaves identically everywhere.
 */
import { annotationsStore } from './stores/annotations';
import { toast } from './stores/toast';

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
