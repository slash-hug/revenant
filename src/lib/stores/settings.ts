/**
 * settings.ts — client-side settings store.
 *
 * Single source of truth for Settings on the frontend. Eager-loaded at app
 * start (D5) via `loadSettings()` so the panel never shows a null-state
 * skeleton, and `handleExportObsidian` can read from the store rather than
 * issuing its own IPC call.
 *
 * `patchSettings(partial)` applies optimistic updates: it snapshots the prior
 * value, sets the new value immediately, and reverts + toasts on IPC failure so
 * the UI never stays stuck in a broken state.
 *
 * `restKeyConfigured` is a derived store that avoids a second `has_rest_key()`
 * IPC call by reading `rest_key_ref != null` from the loaded settings (D5).
 */

import { writable, derived, get } from 'svelte/store';
import type { Settings } from '../types/ipc';
import { getSettings, setSettings } from '../types/ipc';
import { toast } from './toast';

// ---------------------------------------------------------------------------
// Core store
// ---------------------------------------------------------------------------

export const settings = writable<Settings | null>(null);

/**
 * Load (or reload) settings from the Rust core and populate the store.
 * Called once at app start (D5 — eager load).
 */
export async function loadSettings(): Promise<void> {
  const loaded = await getSettings();
  settings.set(loaded);
}

/**
 * Apply a partial settings update optimistically.
 *
 * 1. Snapshot the prior value.
 * 2. Merge `partial` into the current store value and set immediately.
 * 3. Persist via `setSettings`. On failure: revert to the snapshot and show a
 *    toast so the user knows the change did not land.
 *
 * Note: `setSettings` accepts a full `Settings` object. We call it with the
 * merged value that already includes `schema_version: 1` from the original
 * loaded settings, so the schema version is never silently dropped.
 */
export async function patchSettings(partial: Partial<Settings>): Promise<void> {
  const prior = get(settings);
  if (!prior) {
    // Store has not loaded yet — this is a programming error; surface it.
    toast.show('Settings not loaded yet. Please try again.');
    return;
  }

  const next: Settings = { ...prior, ...partial };
  settings.set(next);

  try {
    await setSettings(next);
    // On success `setSettings` returns void — keep `next` in the store.
  } catch {
    // Revert to the snapshot and let the user know.
    settings.set(prior);
    toast.show("Couldn't save settings. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Derived convenience stores
// ---------------------------------------------------------------------------

/**
 * True when the Obsidian REST key has been stored in the OS keychain
 * (i.e. `rest_key_ref` is non-null in the loaded settings).
 *
 * Reading this avoids a separate `has_rest_key()` IPC round-trip on load (D5).
 */
export const restKeyConfigured = derived(
  settings,
  ($settings) => $settings?.rest_key_ref != null,
);
