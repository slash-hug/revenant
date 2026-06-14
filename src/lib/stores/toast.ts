/**
 * toast.ts — a single, transient status toast (e.g. "Comment deleted · Undo").
 *
 * Only one toast is shown at a time; a new toast replaces the current one. Each
 * toast auto-dismisses after `duration` ms unless dismissed/acted on first.
 * Used for undoable actions (annotation delete) so the action is immediate but
 * reversible — no blocking confirm dialog.
 */
import { writable } from 'svelte/store';

export interface ToastState {
  /** Monotonic id so the component can key/animate distinct toasts. */
  id: number;
  message: string;
  /** Optional action button label (e.g. "Undo"). */
  actionLabel?: string;
  /** Invoked when the action button is clicked. */
  onAction?: () => void;
}

function createToastStore() {
  const { subscribe, set } = writable<ToastState | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let counter = 0;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Show a toast, replacing any current one. Returns the toast id. */
  function show(
    message: string,
    opts: { actionLabel?: string; onAction?: () => void; duration?: number } = {},
  ): number {
    clearTimer();
    const id = ++counter;
    set({ id, message, actionLabel: opts.actionLabel, onAction: opts.onAction });
    timer = setTimeout(() => {
      timer = null;
      set(null);
    }, opts.duration ?? 6000);
    return id;
  }

  /** Dismiss the current toast immediately. */
  function dismiss(): void {
    clearTimer();
    set(null);
  }

  return { subscribe, show, dismiss };
}

export const toast = createToastStore();
