/**
 * annotationFocus.ts — Single source of truth for annotation focus state.
 *
 * Keeps PreviewPane, EditorPane, and AnnotationDrawer decoupled:
 * each reads focus and renders independently; none reaches into another.
 *
 * Frozen shape (all workstreams depend on this — do not change):
 *   activeId    — the currently focused annotation id, or null.
 *   hoverId     — the currently hovered annotation id, or null.
 *   scrollNonce — bumped on every focusAnnotation call (incl. re-click of same id)
 *                 so subscribers scroll even when activeId doesn't change (D5).
 */

import { writable } from 'svelte/store';

export interface AnnotationFocusState {
  activeId: string | null;
  hoverId: string | null;
  scrollNonce: number;
}

const INITIAL_STATE: AnnotationFocusState = {
  activeId: null,
  hoverId: null,
  scrollNonce: 0,
};

export const annotationFocus = writable<AnnotationFocusState>(INITIAL_STATE);

/**
 * Set the active annotation and bump scrollNonce.
 * Always bumps scrollNonce — even for a re-click of the same id (D5).
 * This is the single entry point for card-click and seal-click navigation.
 */
export function focusAnnotation(id: string): void {
  annotationFocus.update((s) => ({
    ...s,
    activeId: id,
    scrollNonce: s.scrollNonce + 1,
  }));
}

/**
 * Clear focus (Esc / outside-click / tab switch).
 * Resets activeId and hoverId; leaves scrollNonce unchanged.
 */
export function clearFocus(): void {
  annotationFocus.update((s) => ({
    ...s,
    activeId: null,
    hoverId: null,
  }));
}

/**
 * Set the hover annotation (null to clear).
 * Used by seals/drawer cards for cross-surface hover preview.
 */
export function hoverAnnotation(id: string | null): void {
  annotationFocus.update((s) => ({
    ...s,
    hoverId: id,
  }));
}
