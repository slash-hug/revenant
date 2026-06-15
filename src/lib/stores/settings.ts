/**
 * Settings store — WS-C implements the full version.
 *
 * This stub is created by WS-A so that App.svelte (a WS-A file) can import
 * `loadSettings` and the `settings` store without waiting for WS-C to land.
 * WS-C will replace this file with the full writable store + `patchSettings`
 * + optimistic rollback.
 *
 * Exports (matching the signatures WS-C will provide):
 *   - `settings`: Svelte readable store of `Settings | null`
 *   - `loadSettings()`: eager-loads settings via IPC and populates the store
 *   - `patchSettings(partial)`: optimistic update with rollback on failure (WS-C stub — no-op here)
 *   - `restKeyConfigured`: derived boolean store (`rest_key_ref !== null`)
 */

import { writable, derived } from "svelte/store";
import type { Readable } from "svelte/store";
import { getSettings } from "$lib/types/ipc";
import type { Settings } from "$lib/types/ipc";

/** Single client-side source of truth for persisted settings. */
export const settings = writable<Settings | null>(null);

/**
 * Derived store: `true` when a REST key reference is present in settings
 * (avoids a second `has_rest_key()` IPC round-trip on panel open; D5).
 */
export const restKeyConfigured: Readable<boolean> = derived(
  settings,
  ($s) => $s?.rest_key_ref != null,
);

/**
 * Eager-load settings at app start (D5).
 * Populates the `settings` store with the current persisted values.
 * Call once from App.svelte `onMount` (or equivalent).
 */
export async function loadSettings(): Promise<void> {
  try {
    const s = await getSettings();
    settings.set(s);
  } catch {
    // Non-fatal: store stays null; UI falls back to defaults.
  }
}

/**
 * Apply a partial settings update optimistically (stub — WS-C provides full impl).
 * WS-C will add prior-value snapshot + revert-on-failure + toast.
 */
export async function patchSettings(
  _partial: Partial<Settings>,
): Promise<void> {
  // WS-C stub: no-op until full implementation lands.
}
