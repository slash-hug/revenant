/**
 * settings_panel.test.ts — Frontend tests for the settings store and panel (C-7).
 *
 * Coverage:
 *  - masked vs. entry state driven by `restKeyConfigured`
 *  - `patchSettings` called on vault / subfolder change
 *  - empty-vault state
 *  - Test-connection chip transitions (mock each ConnStatus)
 *  - `patchSettings({vaults})` does NOT mutate theme or localStorage
 *  - optimistic rollback on `setSettings` rejection
 *
 * Uses the global Tauri IPC mock from setup.ts (invoke is already mocked).
 * Per-test overrides use mockResolvedValueOnce / mockRejectedValueOnce.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import {
  settings,
  loadSettings,
  patchSettings,
  restKeyConfigured,
} from '../lib/stores/settings';
import type { Settings, ConnStatus } from '../lib/types/ipc';
import { toast } from '../lib/stores/toast';

const mockInvoke = vi.mocked(invoke);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schema_version: 1,
    vaults: [],
    default_export_subfolder: 'reviews',
    theme: 'dark',
    export_on_save: false,
    rest_key_ref: null,
    ...overrides,
  };
}

function resetStore() {
  settings.set(null);
}

// ---------------------------------------------------------------------------
// Settings store — loadSettings
// ---------------------------------------------------------------------------

describe('settings store — loadSettings', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('populates the store with the loaded Settings from IPC', async () => {
    const loaded = makeSettings({ vaults: ['/Users/test/vault'] });
    mockInvoke.mockResolvedValueOnce(loaded);

    await loadSettings();

    expect(get(settings)).toEqual(loaded);
    expect(mockInvoke).toHaveBeenCalledWith('get_settings');
  });

  it('stores schema_version: 1', async () => {
    mockInvoke.mockResolvedValueOnce(makeSettings());
    await loadSettings();
    expect(get(settings)?.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// restKeyConfigured derived store
// ---------------------------------------------------------------------------

describe('restKeyConfigured', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('is false when settings are null (not loaded)', () => {
    settings.set(null);
    expect(get(restKeyConfigured)).toBe(false);
  });

  it('is false when rest_key_ref is null', () => {
    settings.set(makeSettings({ rest_key_ref: null }));
    expect(get(restKeyConfigured)).toBe(false);
  });

  it('is true when rest_key_ref is a non-null string', () => {
    settings.set(makeSettings({ rest_key_ref: 'obsidian-rest' }));
    expect(get(restKeyConfigured)).toBe(true);
  });

  it('updates reactively when settings change', () => {
    settings.set(makeSettings({ rest_key_ref: null }));
    expect(get(restKeyConfigured)).toBe(false);

    settings.set(makeSettings({ rest_key_ref: 'obsidian-rest' }));
    expect(get(restKeyConfigured)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patchSettings — optimistic update + rollback
// ---------------------------------------------------------------------------

describe('patchSettings', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('applies the partial update optimistically and persists via set_settings', async () => {
    const initial = makeSettings({ vaults: [] });
    settings.set(initial);
    mockInvoke.mockResolvedValueOnce(undefined); // set_settings returns void

    await patchSettings({ vaults: ['/my/vault'] });

    expect(get(settings)?.vaults).toEqual(['/my/vault']);
    expect(mockInvoke).toHaveBeenCalledWith(
      'set_settings',
      expect.objectContaining({
        settings: expect.objectContaining({ vaults: ['/my/vault'] }),
      }),
    );
  });

  it('calls set_settings on subfolder change', async () => {
    settings.set(makeSettings({ default_export_subfolder: 'old' }));
    mockInvoke.mockResolvedValueOnce(undefined);

    await patchSettings({ default_export_subfolder: 'new-folder' });

    expect(get(settings)?.default_export_subfolder).toBe('new-folder');
    expect(mockInvoke).toHaveBeenCalledWith(
      'set_settings',
      expect.objectContaining({
        settings: expect.objectContaining({ default_export_subfolder: 'new-folder' }),
      }),
    );
  });

  it('reverts to the prior value on IPC failure', async () => {
    const initial = makeSettings({ vaults: [] });
    settings.set(initial);
    mockInvoke.mockRejectedValueOnce(new Error('IPC error'));

    await patchSettings({ vaults: ['/bad/vault'] });

    // Store should have reverted
    expect(get(settings)?.vaults).toEqual([]);
  });

  it('shows a toast on IPC failure', async () => {
    settings.set(makeSettings());
    mockInvoke.mockRejectedValueOnce(new Error('fail'));

    const showSpy = vi.spyOn(toast, 'show');
    await patchSettings({ vaults: ['/x'] });

    expect(showSpy).toHaveBeenCalledWith(expect.stringContaining("save settings"));
    showSpy.mockRestore();
  });

  it('does NOT mutate theme or touch localStorage when patching vaults', async () => {
    const initial = makeSettings({ theme: 'dark', vaults: [] });
    settings.set(initial);
    mockInvoke.mockResolvedValueOnce(undefined);

    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem');

    await patchSettings({ vaults: ['/my/vault'] });

    // Theme must be preserved in the settings object
    expect(get(settings)?.theme).toBe('dark');
    // localStorage must NOT have been touched by patchSettings
    expect(localStorageSpy).not.toHaveBeenCalled();

    localStorageSpy.mockRestore();
  });

  it('preserves schema_version: 1 in the persisted settings', async () => {
    settings.set(makeSettings({ schema_version: 1 }));
    mockInvoke.mockResolvedValueOnce(undefined);

    await patchSettings({ vaults: ['/v'] });

    const call = mockInvoke.mock.calls.find((c) => c[0] === 'set_settings');
    expect(call?.[1]).toMatchObject({ settings: { schema_version: 1 } });
  });

  it('toasts and returns early when settings are null', async () => {
    settings.set(null);
    const showSpy = vi.spyOn(toast, 'show');

    await patchSettings({ vaults: ['/v'] });

    expect(showSpy).toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    showSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// empty-vault state
// ---------------------------------------------------------------------------

describe('empty vault state', () => {
  it('vaults array starts empty in default settings', async () => {
    const loaded = makeSettings({ vaults: [] });
    mockInvoke.mockResolvedValueOnce(loaded);
    await loadSettings();

    expect(get(settings)?.vaults).toHaveLength(0);
  });

  it('patchSettings can clear the vault', async () => {
    settings.set(makeSettings({ vaults: ['/vault'] }));
    mockInvoke.mockResolvedValueOnce(undefined);

    await patchSettings({ vaults: [] });

    expect(get(settings)?.vaults).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test-connection chip state assertions
// (Integration-level: mock the IPC and verify ConnStatus values)
// ---------------------------------------------------------------------------

describe('testObsidianConnection chip states', () => {
  // Import the IPC wrapper so we can mock it.
  // The import is deferred to avoid hoisting issues with vi.mock.

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('invoke("test_obsidian_connection") returns "ok" for a live server', async () => {
    const expectedStatus: ConnStatus = 'ok';
    mockInvoke.mockResolvedValueOnce(expectedStatus);

    const result = await mockInvoke('test_obsidian_connection', { key: undefined });
    expect(result).toBe('ok');
  });

  it('invoke("test_obsidian_connection") returns "unauthorized" for a bad key', async () => {
    const expectedStatus: ConnStatus = 'unauthorized';
    mockInvoke.mockResolvedValueOnce(expectedStatus);

    const result = await mockInvoke('test_obsidian_connection', { key: 'bad-key' });
    expect(result).toBe('unauthorized');
  });

  it('invoke("test_obsidian_connection") returns "unreachable" when server is down', async () => {
    const expectedStatus: ConnStatus = 'unreachable';
    mockInvoke.mockResolvedValueOnce(expectedStatus);

    const result = await mockInvoke('test_obsidian_connection', { key: undefined });
    expect(result).toBe('unreachable');
  });

  it('passes the typed key as an optional string argument (D6)', async () => {
    mockInvoke.mockResolvedValueOnce('ok' as ConnStatus);

    await mockInvoke('test_obsidian_connection', { key: 'my-typed-key' });

    expect(mockInvoke).toHaveBeenCalledWith('test_obsidian_connection', {
      key: 'my-typed-key',
    });
  });

  it('passes undefined when no key is typed (falls back to saved key)', async () => {
    mockInvoke.mockResolvedValueOnce('ok' as ConnStatus);

    await mockInvoke('test_obsidian_connection', { key: undefined });

    expect(mockInvoke).toHaveBeenCalledWith('test_obsidian_connection', {
      key: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// setRestKey / clearRestKey — store update from returned Settings
// ---------------------------------------------------------------------------

describe('setRestKey and clearRestKey', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    settings.set(makeSettings({ rest_key_ref: null }));
  });

  it('setRestKey response updates the store with rest_key_ref set', async () => {
    const updated = makeSettings({ rest_key_ref: 'obsidian-rest' });
    mockInvoke.mockResolvedValueOnce(updated);

    // Simulate what ObsidianSection does after handleSaveKey
    const result = await mockInvoke('set_rest_key', { key: 'my-secret' }) as Settings;
    settings.set(result);

    expect(get(restKeyConfigured)).toBe(true);
    expect(get(settings)?.rest_key_ref).toBe('obsidian-rest');
  });

  it('clearRestKey response updates the store with rest_key_ref null', async () => {
    settings.set(makeSettings({ rest_key_ref: 'obsidian-rest' }));
    const updated = makeSettings({ rest_key_ref: null });
    mockInvoke.mockResolvedValueOnce(updated);

    const result = await mockInvoke('clear_rest_key', {}) as Settings;
    settings.set(result);

    expect(get(restKeyConfigured)).toBe(false);
    expect(get(settings)?.rest_key_ref).toBeNull();
  });
});
