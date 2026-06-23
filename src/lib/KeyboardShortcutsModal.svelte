<script lang="ts">
  /**
   * KeyboardShortcutsModal.svelte — in-app keyboard-shortcut reference (#25).
   * Opened from the ⌘K palette ("Keyboard shortcuts") and the toolbar "?" button.
   * The app is keyboard-rich but the bindings previously lived only in per-control
   * tooltips; this is the single discoverable cheat-sheet.
   *
   * Native <dialog> via showModal() for focus-trap / Esc / inert background.
   */
  import { createEventDispatcher } from 'svelte';

  export let open: boolean = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
  const mod = isMac ? '⌘' : 'Ctrl';
  const alt = isMac ? '⌥' : 'Alt';
  const shift = isMac ? '⇧' : 'Shift';
  const enter = isMac ? '↩' : 'Enter';

  const groups: { title: string; items: { keys: string[]; label: string }[] }[] = [
    {
      title: 'View',
      items: [
        { keys: [mod, '1'], label: 'Source' },
        { keys: [mod, '2'], label: 'Split' },
        { keys: [mod, '3'], label: 'Preview' },
        { keys: [mod, '\\'], label: 'Toggle annotation panel' },
        { keys: [mod, '='], label: 'Zoom in' },
        { keys: [mod, '-'], label: 'Zoom out' },
        { keys: [mod, '0'], label: 'Reset zoom' },
      ],
    },
    {
      title: 'Comments',
      items: [
        { keys: [mod, alt, 'M'], label: 'Add comment on selection' },
        { keys: [alt, '↓'], label: 'Next comment' },
        { keys: [alt, '↑'], label: 'Previous comment' },
        { keys: [mod, enter], label: 'Save comment edit (in drawer)' },
      ],
    },
    {
      title: 'File & review',
      items: [
        { keys: [mod, 'O'], label: 'Open file' },
        { keys: [mod, 'S'], label: 'Save document' },
        { keys: [mod, shift, 'R'], label: 'Generate review' },
      ],
    },
    {
      title: 'Find & Replace',
      items: [
        { keys: [mod, 'F'], label: 'Find' },
        { keys: [mod, 'H'], label: 'Find & Replace' },
        { keys: [enter], label: 'Next match' },
        { keys: [shift, enter], label: 'Previous match' },
        { keys: [alt, enter], label: 'Replace current' },
        { keys: [mod, alt, enter], label: 'Replace all' },
      ],
    },
    {
      title: 'General',
      items: [
        { keys: [mod, 'K'], label: 'Command palette' },
        { keys: [mod, ','], label: 'Settings' },
        { keys: ['Esc'], label: 'Close dialog / popover' },
      ],
    },
  ];

  let dialog: HTMLDialogElement | undefined;
  $: if (dialog) {
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }

  function close() { dispatch('close'); }
  function handleCancel(e: Event) { e.preventDefault(); close(); }
</script>

<dialog bind:this={dialog} class="ks" aria-labelledby="ks-title" on:cancel={handleCancel}>
  <div class="ks-head">
    <h3 id="ks-title">Keyboard shortcuts</h3>
    <button type="button" class="ks-x" on:click={close} aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  </div>

  <div class="ks-grid">
    {#each groups as g}
      <section class="ks-group" aria-label={g.title}>
        <h4 class="ks-group-title">{g.title}</h4>
        <dl>
          {#each g.items as item}
            <div class="ks-row">
              <dt>{item.label}</dt>
              <dd>
                {#each item.keys as k}<kbd>{k}</kbd>{/each}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>

  <p class="ks-foot">Docs &amp; issues: <span class="ks-url">github.com/slash-hug/revenant</span> · <kbd>Esc</kbd> to close</p>
</dialog>

<style>
  .ks {
    margin: auto;
    width: 560px;
    max-width: 92vw;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-lg);
    padding: 20px 24px 18px;
  }
  .ks[open] { display: block; animation: ks-in var(--dur-slow) var(--ease-out); }
  .ks::backdrop {
    background: color-mix(in srgb, var(--bg) 35%, rgba(0, 0, 0, .45));
    backdrop-filter: blur(2px);
  }
  @keyframes ks-in { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ks[open] { animation: none; } }

  .ks-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .ks-head h3 { margin: 0; font-size: var(--fs-xl); font-weight: var(--fw-semibold); letter-spacing: -.01em; }
  .ks-x {
    display: inline-flex; padding: 5px; border-radius: var(--r-md);
    border: none; background: transparent; color: var(--text-muted); cursor: pointer;
  }
  .ks-x svg { width: 16px; height: 16px; }
  .ks-x:hover { color: var(--text); background: var(--surface-2); }

  .ks-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 32px; }
  @media (max-width: 560px) { .ks-grid { grid-template-columns: 1fr; } }

  .ks-group-title {
    margin: 8px 0 6px;
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .ks-group dl { margin: 0; }
  .ks-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
  .ks-row dt { font-size: var(--fs-base); color: var(--text); min-width: 0; }
  .ks-row dd { margin: 0; display: inline-flex; gap: 3px; flex: none; }

  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.6;
    min-width: 18px;
    text-align: center;
    color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-xs);
    padding: 1px 5px;
  }

  .ks-foot {
    margin: 16px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: var(--fs-xs);
    color: var(--text-faint);
  }
  .ks-url { font-family: var(--font-mono); }
</style>
