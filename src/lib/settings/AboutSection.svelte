<script lang="ts">
  /**
   * AboutSection.svelte — About settings section (WS-C / C2).
   *
   * Shows the current app version (loaded on mount via `get_app_version`) and
   * provides a "Check for updates" button that probes the GitHub Releases API
   * via `check_for_updates` (WS-D engine, WS-A IPC command).
   *
   * Key decisions:
   * - Svelte 4 options-API to match ObsidianSection / AppearanceSection.
   * - Version loaded on mount with `aria-live="polite"` placeholder while
   *   resolving (UX gap fix per plan §C2).
   * - Chip state driven by the pure `aboutChipState` helper (C1) so it is
   *   unit-testable without rendering.
   * - "Download" button opens the release page via `open_release_page`; shown
   *   only when `showDownload` is true.
   * - "Check for updates" button stays ENABLED after error so the user can retry.
   * - chip-info uses accent tokens to distinguish update notification from
   *   warning (amber) or success (green) — semantic correctness.
   * - Spinner SVG + @keyframes spin lifted from ObsidianSection pattern.
   *
   * IPC note: calls `get_app_version`, `check_for_updates`, `open_release_page`
   * via `invoke` directly (WS-A will add typed wrappers to ipc.ts; this
   * component uses invoke to remain buildable before WS-A merges).
   */

  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { aboutChipState } from './aboutChipState';
  import type { AboutStatus, UpdateCheckResult } from './aboutChipState';

  // ---------------------------------------------------------------------------
  // Version
  // ---------------------------------------------------------------------------

  /** Current app version string; null while loading. */
  let version: string | null = null;

  onMount(async () => {
    try {
      version = await invoke<string>('get_app_version');
    } catch {
      version = '—';
    }
  });

  // ---------------------------------------------------------------------------
  // Check for updates
  // ---------------------------------------------------------------------------

  let status: AboutStatus = 'idle';
  let lastCheck: UpdateCheckResult | undefined = undefined;

  /** Whether the "Download" button aria-busy state is active. */
  let downloadBusy = false;

  $: chipOutput = aboutChipState({ status, check: lastCheck });

  async function handleCheckForUpdates() {
    status = 'checking';
    lastCheck = undefined;
    try {
      const check = await invoke<UpdateCheckResult>('check_for_updates');
      lastCheck = check;
      status = check.update_available ? 'update-available' : 'up-to-date';
    } catch {
      status = 'error';
    }
  }

  async function handleDownload() {
    if (!lastCheck) return;
    downloadBusy = true;
    try {
      await invoke<void>('open_release_page', { url: lastCheck.release_url });
    } catch {
      // Best-effort — open_release_page validates the URL; if it rejects,
      // silently ignore rather than showing a confusing error for a button click.
    } finally {
      downloadBusy = false;
    }
  }
</script>

<section class="about-section" aria-label="About">
  <h4 class="section-title">About</h4>

  <!-- ── Version ───────────────────────────────────────────────────────────── -->
  <div class="field-row">
    <span class="field-label">Version</span>
    <span class="version-value" aria-live="polite">
      {#if version === null}
        <span class="text-faint">Loading…</span>
      {:else}
        {version}
      {/if}
    </span>
  </div>

  <!-- ── Updates ───────────────────────────────────────────────────────────── -->
  <div class="field-row update-row">
    <span class="field-label">Updates</span>
    <div class="update-body">
      <button
        type="button"
        class="btn-sm"
        disabled={status === 'checking'}
        aria-busy={status === 'checking'}
        on:click={handleCheckForUpdates}
      >
        {#if status === 'checking'}
          <svg class="spinner" viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-dasharray="42 60"
            />
          </svg>
          Checking…
        {:else}
          Check for updates
        {/if}
      </button>

      {#if chipOutput.chipClass}
        <span class={chipOutput.chipClass} role="status">{chipOutput.chipText}</span>
      {/if}

      {#if chipOutput.showDownload}
        <button
          type="button"
          class="btn-sm"
          disabled={downloadBusy}
          aria-busy={downloadBusy}
          on:click={handleDownload}
        >
          Download
        </button>
      {/if}
    </div>
  </div>
</section>

<style>
  .about-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .section-title {
    margin: 0 0 4px;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--text-faint);
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

  .text-faint {
    color: var(--text-faint);
  }

  .version-value {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text-muted);
  }

  /* Update row body: horizontal flex wrapping button + chip + download */
  .update-body {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  /* Small button — matches ObsidianSection */
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
  .btn-sm:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn-sm .spinner {
    width: 12px;
    height: 12px;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .btn-sm .spinner { animation-duration: 1.8s; }
  }

  /* Chip base */
  .chip {
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid transparent;
  }

  /* Chip variants */
  .chip-ok {
    color: #166534;
    background: #dcfce7;
    border-color: #bbf7d0;
  }
  .chip-info {
    color: #1e3a5f;
    background: var(--accent-soft, #dbeafe);
    border-color: var(--accent-border, #bfdbfe);
  }
  .chip-err {
    color: #991b1b;
    background: #fee2e2;
    border-color: #fecaca;
  }

  /* Dark-mode chip variants */
  :global([data-theme="dark"]) .chip-ok {
    color: #86efac;
    background: #14532d;
    border-color: #166534;
  }
  :global([data-theme="dark"]) .chip-info {
    color: var(--accent-text, #93c5fd);
    background: #1e3a5f;
    border-color: #1d4ed8;
  }
  :global([data-theme="dark"]) .chip-err {
    color: #fca5a5;
    background: #450a0a;
    border-color: #7f1d1d;
  }
</style>
