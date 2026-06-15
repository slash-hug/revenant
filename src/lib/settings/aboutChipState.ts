/**
 * aboutChipState.ts — pure chip-state mapping helper for AboutSection.
 *
 * Maps the current update-check status into display properties.
 * Extracted as a pure function so it can be unit-tested without rendering
 * the Svelte component (component mounting is not wired in this repo's vitest
 * setup — it resolves to the SSR build).
 */

// Import then re-export the canonical type from the frozen IPC contract so
// callers get a single source of truth. The previous local mirror is removed
// to prevent it diverging from ipc.ts if the IPC surface is ever updated.
import type { UpdateCheck } from '../types/ipc';
export type UpdateCheckResult = UpdateCheck;

/** The set of states the About section can be in. */
export type AboutStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'error';

export interface AboutChipInput {
  status: AboutStatus;
  check?: UpdateCheckResult;
}

export interface AboutChipOutput {
  /** CSS class to apply to the chip element (e.g. "chip chip-ok"). */
  chipClass: string;
  /** Text to display inside the chip. */
  chipText: string;
  /** Whether the "Download" button should be visible. */
  showDownload: boolean;
}

/**
 * Map the current update-check status to chip display properties.
 *
 * Status semantics:
 * - idle          → no chip shown (chipClass/chipText are empty, showDownload false)
 * - checking      → no chip shown (spinner is shown by the button instead)
 * - up-to-date    → green chip "Up to date"
 * - update-available → accent/info chip "Update available" + Download button shown
 * - error         → red chip "Couldn't check for updates"
 */
export function aboutChipState(input: AboutChipInput): AboutChipOutput {
  const { status } = input;

  switch (status) {
    case 'idle':
    case 'checking':
      return { chipClass: '', chipText: '', showDownload: false };

    case 'up-to-date':
      return {
        chipClass: 'chip chip-ok',
        chipText: 'Up to date',
        showDownload: false,
      };

    case 'update-available':
      return {
        chipClass: 'chip chip-info',
        chipText: 'Update available',
        showDownload: true,
      };

    case 'error':
      return {
        chipClass: 'chip chip-err',
        chipText: "Couldn't check for updates",
        showDownload: false,
      };

    default: {
      // Exhaustive check — TypeScript will flag any unhandled status at compile time.
      const _exhaustive: never = status;
      return { chipClass: '', chipText: '', showDownload: false };
    }
  }
}
