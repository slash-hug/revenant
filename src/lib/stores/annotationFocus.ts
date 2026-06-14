/**
 * annotationFocus.ts — Single source of truth for annotation hover/focus state.
 *
 * Shape: { activeId, hoverId, scrollNonce, anchorRect }
 *
 * The plan §4 WS-0 pre-step listed three fields (activeId, hoverId, scrollNonce)
 * as the "frozen" contract, but the implementation added a 4th field `anchorRect`
 * (D4 — coordinate-driven popover placement) and extended `focusAnnotation` with
 * an optional `rect?` parameter.  All consumers were updated consistently at the
 * time of that change.  This comment supersedes the plan text so readers don't
 * treat the 3-field shape as authoritative.
 *
 * WS-1/WS-2/WS-3 all consume this store; WS-2 owns it (but it is created here
 * as a pre-step so WS-1/WS-3 can import it without a worktree dependency).
 *
 * Not tab-scoped — App.svelte resets on tab switch (D11/TRAP 4).
 */
import { writable } from 'svelte/store';

/** Viewport-coordinate rect for the active annotation's anchor element.
 *  Passed to AnnotationPopover for placement (D4 — coordinate-driven). */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
}

export interface AnnotationFocusState {
  /** ID of the annotation currently displayed in the shared popover (or null). */
  activeId: string | null;
  /** ID of the annotation currently hovered in any surface (or null). */
  hoverId: string | null;
  /** Monotonically-increasing nonce; bumped on every focusAnnotation call.
   *  Subscribers (preview + editor) scroll into view on any change. */
  scrollNonce: number;
  /** Viewport rect of the seal/gutter marker that opened the popover.
   *  Set by whichever pane owns the active seal; null when no popover is open. */
  anchorRect: AnchorRect | null;
}

const INITIAL_STATE: AnnotationFocusState = {
  activeId: null,
  hoverId: null,
  scrollNonce: 0,
  anchorRect: null,
};

export const annotationFocus = writable<AnnotationFocusState>(INITIAL_STATE);

/**
 * Set the active annotation and bump the scroll nonce so all subscribers
 * scroll the anchor into view. Re-clicking the same id still bumps nonce
 * (D5 — fresh-open and re-center are the same code path).
 *
 * @param id       - The annotation id to focus.
 * @param rect     - Optional viewport rect of the anchor element that triggered
 *                   the focus (used by AnnotationPopover for placement). Pass
 *                   null/undefined when triggered from the drawer (no visual anchor).
 */
export function focusAnnotation(id: string, rect?: AnchorRect | null): void {
  annotationFocus.update((s) => ({
    ...s,
    activeId: id,
    scrollNonce: s.scrollNonce + 1,
    anchorRect: rect ?? null,
  }));
}

/**
 * Update only the anchor rect for the currently-active annotation, without
 * bumping scrollNonce or changing activeId. Called by whichever surface owns the
 * visible annotation (PreviewPane / EditorPane) once it has measured the real
 * span/line rect — so the popover anchors under the actual words, not the seal.
 */
export function setAnchorRect(rect: AnchorRect | null): void {
  annotationFocus.update((s) => ({ ...s, anchorRect: rect }));
}

/**
 * Clear focus state (called on Esc, outside-click, and tab switch).
 * scrollNonce is intentionally left unchanged.
 */
export function clearFocus(): void {
  annotationFocus.update((s) => ({ ...s, activeId: null, hoverId: null, anchorRect: null }));
}

/**
 * Set or clear the hovered annotation id.
 */
export function hoverAnnotation(id: string | null): void {
  annotationFocus.update((s) => ({ ...s, hoverId: id }));
}
