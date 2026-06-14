/**
 * annotationFocus.ts — Annotation focus / navigation store.
 *
 * Single source of truth for which annotation is currently "active"
 * (highlighted in both panes + shown in the popover) and which is
 * hovered. The `scrollNonce` field is bumped on every `focusAnnotation`
 * call — even re-focusing the same id — so subscribers can unconditionally
 * scroll the active annotation into view (D5).
 *
 * Shape is frozen: WS-1, WS-2, and WS-3 all import this; do not add fields
 * without updating all consumers.
 *
 * Frozen shape (per plan §4):
 *   activeId:    string | null  — id of the active annotation (popover open)
 *   hoverId:     string | null  — id of the hovered annotation (highlight-only)
 *   scrollNonce: number         — bumped on every focusAnnotation() to trigger scroll
 */
import { writable } from 'svelte/store';

interface AnnotationFocusState {
  activeId: string | null;
  hoverId: string | null;
  scrollNonce: number;
}

const INITIAL_FOCUS_STATE: AnnotationFocusState = {
  activeId: null,
  hoverId: null,
  scrollNonce: 0,
};

const { subscribe, update, set } = writable<AnnotationFocusState>(INITIAL_FOCUS_STATE);

/** The focus store (read-only subscribe surface; mutate via the helpers below). */
export const annotationFocus = { subscribe };

/**
 * Focus an annotation by id.
 * Always sets `activeId` to `id` and bumps `scrollNonce` — whether the id
 * is already active or not — so subscribers can unconditionally scroll (D5).
 */
export function focusAnnotation(id: string): void {
  update((s) => ({ ...s, activeId: id, scrollNonce: s.scrollNonce + 1 }));
}

/**
 * Clear active + hover focus (Esc / outside-click / tab switch).
 * `scrollNonce` is left unchanged — there is nothing to scroll to.
 */
export function clearFocus(): void {
  update((s) => ({ ...s, activeId: null, hoverId: null }));
}

/**
 * Set or clear the hover annotation.
 * Pass `null` to clear. Does not affect `activeId` or `scrollNonce`.
 */
export function hoverAnnotation(id: string | null): void {
  update((s) => ({ ...s, hoverId: id }));
}

/** Reset to initial state (called on session reset / all tabs closed). */
export function resetFocus(): void {
  set(INITIAL_FOCUS_STATE);
}
