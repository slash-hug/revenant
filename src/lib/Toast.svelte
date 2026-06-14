<script lang="ts">
  /**
   * Toast.svelte — renders the single transient toast from the toast store,
   * portal-style at the app root (position: fixed, bottom-centre). Carries an
   * optional action (e.g. "Undo"). Dismisses on action or auto-timeout.
   */
  import { toast } from './stores/toast';

  function runAction() {
    const current = $toast;
    if (current?.onAction) current.onAction();
    toast.dismiss();
  }
</script>

{#if $toast}
  {#key $toast.id}
    <div class="toast" role="status" aria-live="polite">
      <span class="toast-msg">{$toast.message}</span>
      {#if $toast.actionLabel}
        <button class="toast-action" type="button" on:click={runAction}>{$toast.actionLabel}</button>
      {/if}
      <button class="toast-close" type="button" aria-label="Dismiss" on:click={() => toast.dismiss()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  {/key}
{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: var(--z-toast);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px 10px 16px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-pop);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    max-width: min(420px, calc(100vw - 32px));
    animation: toast-in var(--dur-fast) var(--ease-out);
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }
  @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }

  .toast-msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .toast-action {
    font: inherit;
    font-weight: var(--fw-semibold);
    color: var(--accent-text);
    background: var(--accent-soft);
    border: none;
    border-radius: var(--r-sm);
    padding: 4px 10px;
    cursor: pointer;
    flex: none;
    transition: background var(--dur-fast);
  }
  .toast-action:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); }

  .toast-close {
    display: inline-flex;
    color: var(--text-faint);
    background: transparent;
    border: none;
    border-radius: var(--r-xs);
    padding: 3px;
    cursor: pointer;
    flex: none;
    transition: color var(--dur-fast), background var(--dur-fast);
  }
  .toast-close svg { width: 13px; height: 13px; }
  .toast-close:hover { color: var(--text); background: var(--surface-2); }
</style>
