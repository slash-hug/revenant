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
   * IPC note: uses typed wrappers from ipc.ts (getAppVersion, checkForUpdates,
   * openReleasePage) as the single source of truth for the IPC surface.
   */

  import { onMount } from 'svelte';
  import { getAppVersion, checkForUpdates, openReleasePage } from '../types/ipc';
  import type { UpdateCheck } from '../types/ipc';
  import { aboutChipState } from './aboutChipState';
  import type { AboutStatus } from './aboutChipState';

  // UpdateCheckResult is re-exported from ipc.ts as UpdateCheck — use the
  // canonical alias so this component stays in sync with the IPC contract.
  type UpdateCheckResult = UpdateCheck;

  // ---------------------------------------------------------------------------
  // Version
  // ---------------------------------------------------------------------------

  /** Current app version string; null while loading. */
  let version: string | null = null;

  onMount(async () => {
    try {
      version = await getAppVersion();
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
      const check = await checkForUpdates();
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
      await openReleasePage(lastCheck.release_url);
    } catch {
      // Best-effort — open_release_page validates the URL; if it rejects,
      // silently ignore rather than showing a confusing error for a button click.
    } finally {
      downloadBusy = false;
    }
  }
</script>

<section class="about-section" aria-label="About">
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

  /* Chip variants are defined in global.css — no local overrides needed. */
</style>
