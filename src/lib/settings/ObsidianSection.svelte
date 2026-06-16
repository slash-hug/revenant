<script lang="ts">
  /**
   * ObsidianSection.svelte — Obsidian settings section (C-3).
   *
   * Vault picker, export subfolder, REST API key management, and connection test.
   *
   * Key decisions:
   * - Vault directory chosen via plugin-dialog `open({ directory: true })` (TRAP 2:
   *   `dialog:default` already includes `allow-open` — no new capability needed).
   * - REST key: masked "•••• saved" + Replace/Remove when key is saved; password
   *   input + Save when not yet configured (D6).
   * - Save → `setRestKey`; Remove → inline two-step confirm (D8) → `clearRestKey`.
   * - Test connection (D6): passes the typed (unsaved) password text when non-empty,
   *   else `undefined` so the command uses the saved key from the keychain.
   *   Raw key is used only transiently for the probe — never persisted by this call.
   * - Chip states: pending spinner, ✓ Connected, ⚠ Unauthorised, ✗ Unreachable.
   * - All errors surfaced as toasts; never silently swallowed.
   *
   * Uses Svelte 4 options-API to match the component library.
   */

  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { settings, patchSettings, restKeyConfigured } from '../stores/settings';
  import { toast } from '../stores/toast';

  // IPC wrappers — these will be provided by WS-A's ipc.ts additions.
  // We import them by name; if WS-A hasn't landed yet the TS compiler will
  // flag missing exports, which is the correct integration gate.
  import { setRestKey, clearRestKey, testObsidianConnection } from '../types/ipc';
  import type { ConnStatus } from '../types/ipc';

  // ---------------------------------------------------------------------------
  // Vault picker
  // ---------------------------------------------------------------------------

  async function handleChooseVault() {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return; // cancelled or unexpected array
      await patchSettings({ vaults: [picked] });
    } catch (err) {
      toast.show('Could not open folder picker. Please try again.');
    }
  }

  function handleClearVault() {
    patchSettings({ vaults: [] });
  }

  // ---------------------------------------------------------------------------
  // Subfolder
  // ---------------------------------------------------------------------------

  let subfolderDraft = '';
  $: subfolderDraft = $settings?.default_export_subfolder ?? '';

  function handleSubfolderBlur() {
    if (subfolderDraft !== ($settings?.default_export_subfolder ?? '')) {
      patchSettings({ default_export_subfolder: subfolderDraft });
    }
  }

  // ---------------------------------------------------------------------------
  // REST key — masked vs. entry mode
  // ---------------------------------------------------------------------------

  /** Unsaved password text (only held in memory while the entry field is showing). */
  let keyDraft = '';

  /** Whether the "remove key" confirm step is showing (D8 inline two-step). */
  let removePending = false;

  /** Busy flag to disable buttons during async key ops. */
  let keyBusy = false;

  async function handleSaveKey() {
    if (!keyDraft.trim()) {
      toast.show('Please enter a key before saving.');
      return;
    }
    keyBusy = true;
    try {
      const updated = await setRestKey(keyDraft.trim());
      // setRestKey returns the updated Settings (avoids read-modify-write race).
      settings.set(updated);
      keyDraft = '';
      toast.show('REST key saved to system keychain.');
    } catch {
      toast.show("Couldn't save the key to your system keychain.");
    } finally {
      keyBusy = false;
    }
  }

  function handleReplaceKey() {
    // Switch to entry mode — keep any existing draft.
    keyDraft = '';
    removePending = false;
  }

  function handleRemoveClick() {
    removePending = true;
  }

  function handleRemoveCancel() {
    removePending = false;
  }

  async function handleRemoveConfirm() {
    keyBusy = true;
    try {
      const updated = await clearRestKey();
      settings.set(updated);
      removePending = false;
      keyDraft = '';
    } catch {
      toast.show("Couldn't remove the key from your system keychain.");
    } finally {
      keyBusy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Test connection (D6)
  // ---------------------------------------------------------------------------

  type ChipState = 'idle' | 'testing' | 'ok' | 'unauthorized' | 'unreachable';
  let chipState: ChipState = 'idle';

  /** True when the user has typed an unsaved key in the entry field. */
  $: hasTypedKey = keyDraft.trim().length > 0;

  /** Test is enabled if there is a saved key OR the user has typed one. */
  $: canTest = $restKeyConfigured || hasTypedKey;

  async function handleTestConnection() {
    if (!canTest) return;
    chipState = 'testing';
    try {
      // Pass the typed key when non-empty so the probe uses it in-memory (D6).
      // When empty (entry field not shown or cleared), pass undefined — the
      // command falls back to the saved keychain key.
      const key: string | undefined = hasTypedKey ? keyDraft.trim() : undefined;
      const status: ConnStatus = await testObsidianConnection(key);
      chipState = status as ChipState;
    } catch {
      chipState = 'unreachable';
    }
  }
</script>

<section class="obs-section" aria-label="Obsidian settings">
  <!-- ── Vault ─────────────────────────────────────────────────────────────── -->
  <div class="field-row">
    <label class="field-label" for="obs-vault">Vault folder</label>
    <div class="field-body vault-body">
      {#if $settings?.vaults?.[0]}
        <span class="vault-path" title={$settings.vaults[0]}>{$settings.vaults[0]}</span>
        <div class="vault-actions">
          <button type="button" class="link-btn" on:click={handleChooseVault}>Change…</button>
          <button type="button" class="link-btn danger-link" on:click={handleClearVault}>Clear</button>
        </div>
      {:else}
        <span class="vault-empty text-faint">No vault configured</span>
        <button type="button" class="btn-sm" on:click={handleChooseVault}>Choose…</button>
      {/if}
    </div>
  </div>

  <!-- ── Subfolder ─────────────────────────────────────────────────────────── -->
  <div class="field-row">
    <label class="field-label" for="obs-subfolder">Export subfolder</label>
    <input
      id="obs-subfolder"
      type="text"
      class="text-input"
      placeholder="e.g. reviews"
      bind:value={subfolderDraft}
      on:blur={handleSubfolderBlur}
    />
  </div>

  <!-- ── REST API key ───────────────────────────────────────────────────────── -->
  <div class="field-row key-row">
    <span class="field-label">REST API key</span>
    <div class="key-body">
      {#if $restKeyConfigured && !hasTypedKey}
        <!-- Masked state: key is saved in keychain -->
        <div class="key-masked-row">
          <span class="key-masked" aria-label="REST API key is saved">•••• saved</span>
          <div class="key-actions">
            <button
              type="button"
              class="btn-sm"
              disabled={keyBusy}
              on:click={handleReplaceKey}
            >Replace</button>
            {#if removePending}
              <span class="remove-confirm">
                Remove key?
                <button type="button" class="btn-sm danger-btn" disabled={keyBusy} on:click={handleRemoveConfirm}>Remove</button>
                <button type="button" class="link-btn" on:click={handleRemoveCancel}>Cancel</button>
              </span>
            {:else}
              <button
                type="button"
                class="link-btn danger-link"
                disabled={keyBusy}
                on:click={handleRemoveClick}
              >Remove</button>
            {/if}
          </div>
        </div>
      {:else}
        <!-- Entry state: no saved key or user clicked Replace -->
        <div class="key-entry-row">
          <input
            type="password"
            class="text-input key-input"
            placeholder="Paste REST API key…"
            bind:value={keyDraft}
            autocomplete="new-password"
            aria-label="Obsidian REST API key"
          />
          <button
            type="button"
            class="btn-sm"
            disabled={keyBusy || !keyDraft.trim()}
            on:click={handleSaveKey}
          >Save</button>
        </div>
      {/if}

      <!-- Test connection row -->
      <div class="test-row">
        <button
          type="button"
          class="btn-sm"
          disabled={!canTest || chipState === 'testing'}
          aria-busy={chipState === 'testing'}
          on:click={handleTestConnection}
        >
          {#if chipState === 'testing'}
            <svg class="spinner" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="42 60" />
            </svg>
            Testing…
          {:else}
            Test connection
          {/if}
        </button>

        {#if chipState === 'ok'}
          <span class="chip chip-ok" role="status">✓ Connected</span>
        {:else if chipState === 'unauthorized'}
          <span class="chip chip-warn" role="status">⚠ Unauthorised</span>
        {:else if chipState === 'unreachable'}
          <span class="chip chip-err" role="status">✗ Unreachable</span>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .obs-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--text);
  }

  .field-body {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Vault */
  .vault-body {
    flex-wrap: wrap;
    gap: 6px 10px;
  }
  .vault-path {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    padding: 3px 8px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vault-empty { font-size: var(--fs-sm); }
  .text-faint { color: var(--text-faint); }
  .vault-actions { display: inline-flex; gap: 8px; }

  /* Text input */
  .text-input {
    font: inherit;
    font-size: var(--fs-sm);
    width: 100%;
    padding: 7px 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    transition: border-color var(--dur-fast);
  }
  .text-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }

  /* REST key */
  .key-row { flex-direction: column; gap: 6px; }
  .key-body { display: flex; flex-direction: column; gap: 8px; }
  .key-masked-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .key-masked {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-muted);
    letter-spacing: .1em;
  }
  .key-actions { display: inline-flex; align-items: center; gap: 8px; }
  .key-entry-row { display: flex; align-items: center; gap: 8px; }
  .key-input { flex: 1; }

  /* Remove confirm inline */
  .remove-confirm {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }

  /* Test connection row */
  .test-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* Small button */
  .btn-sm {
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    white-space: nowrap;
    transition: background var(--dur-fast), border-color var(--dur-fast);
  }
  .btn-sm:hover:not(:disabled) {
    background: var(--surface);
    border-color: var(--border-strong);
  }
  .btn-sm:disabled { opacity: 0.6; cursor: default; }
  .btn-sm .spinner { width: 12px; height: 12px; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .btn-sm .spinner { animation-duration: 1.8s; } }

  /* Danger variants */
  .danger-btn { color: var(--danger); border-color: var(--danger); }
  .danger-btn:hover:not(:disabled) { background: var(--danger-soft); }

  /* Link-style button */
  .link-btn {
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--accent-text, var(--accent));
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link-btn:hover { opacity: 0.8; }
  .link-btn:disabled { opacity: 0.5; cursor: default; }
  .danger-link { color: var(--danger); }
</style>
