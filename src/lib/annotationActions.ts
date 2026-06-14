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
