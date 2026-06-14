<script lang="ts">
  /** Segmented light / system / dark control, bound to the theme store. */
  import { themeMode, setThemeMode, type ThemeMode } from './stores/theme';

  const modes: { id: ThemeMode; label: string }[] = [
    { id: 'light', label: 'Light theme' },
    { id: 'system', label: 'Match system theme' },
    { id: 'dark', label: 'Dark theme' },
  ];
</script>

<div class="theme-ctl" role="group" aria-label="Theme">
  {#each modes as m (m.id)}
    <button
      type="button"
      aria-pressed={$themeMode === m.id}
      aria-label={m.label}
      title={m.label}
      on:click={() => setThemeMode(m.id)}
    >
      {#if m.id === 'light'}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      {:else if m.id === 'system'}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="12" rx="1.5" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5Z" />
        </svg>
      {/if}
    </button>
  {/each}
</div>

<style>
  .theme-ctl {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: var(--r-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .theme-ctl button {
    width: 30px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--text-faint);
    border-radius: var(--r-sm);
    cursor: pointer;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .theme-ctl button:hover { color: var(--text); }
  .theme-ctl button[aria-pressed="true"] {
    background: var(--surface);
    color: var(--accent-text);
    box-shadow: var(--shadow-sm);
  }
  .theme-ctl svg { width: 15px; height: 15px; }
</style>
