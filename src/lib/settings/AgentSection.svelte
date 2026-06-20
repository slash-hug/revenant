<script lang="ts">
  /**
   * AgentSection.svelte — "Send to agent" handback settings.
   * Lets the user edit the clipboard nudge template and choose whether paths
   * are repo-relative or absolute. Agent-agnostic (TRAP 2). See issue #97.
   */
  import SettingGroup from './SettingGroup.svelte';
  import SettingRow from './SettingRow.svelte';
  import { settings, patchSettings } from '../stores/settings';
  import { DEFAULT_NUDGE_TEMPLATE } from '../agentNudge';

  function onTemplateChange(e: Event) {
    const value = (e.target as HTMLTextAreaElement).value;
    patchSettings({ agent_nudge_template: value });
  }

  function onStyleChange(style: 'relative' | 'absolute') {
    patchSettings({ agent_nudge_path_style: style });
  }

  function resetTemplate() {
    patchSettings({ agent_nudge_template: DEFAULT_NUDGE_TEMPLATE });
  }
</script>

<SettingGroup label="Agent handback">
  <SettingRow
    label="Clipboard nudge"
    helper="Copied to your clipboard when you Send to agent. Placeholders: {'{review_path}'} and {'{doc_path}'}."
  >
    <div class="nudge-field">
      <textarea
        class="nudge-template"
        rows="3"
        value={$settings?.agent_nudge_template ?? DEFAULT_NUDGE_TEMPLATE}
        on:change={onTemplateChange}
        aria-label="Clipboard nudge template"
      ></textarea>
      <button type="button" class="reset-btn" on:click={resetTemplate}>
        Reset to default
      </button>
    </div>
  </SettingRow>

  <SettingRow
    label="Path style"
    helper="How file paths appear in the nudge. Relative keeps them repo-portable."
  >
    <div class="seg" role="group" aria-label="Nudge path style">
      <button
        type="button"
        class:active={($settings?.agent_nudge_path_style ?? 'relative') === 'relative'}
        aria-pressed={($settings?.agent_nudge_path_style ?? 'relative') === 'relative'}
        on:click={() => onStyleChange('relative')}
      >Relative</button>
      <button
        type="button"
        class:active={$settings?.agent_nudge_path_style === 'absolute'}
        aria-pressed={$settings?.agent_nudge_path_style === 'absolute'}
        on:click={() => onStyleChange('absolute')}
      >Absolute</button>
    </div>
  </SettingRow>
</SettingGroup>

<style>
  .nudge-field { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .nudge-template {
    width: 360px; max-width: 100%;
    font: inherit; font-size: var(--fs-sm); font-family: var(--font-mono);
    padding: 8px 10px; border-radius: var(--r-md);
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text);
    resize: vertical;
  }
  .reset-btn {
    font: inherit; font-size: var(--fs-sm); cursor: pointer;
    background: transparent; border: none; color: var(--accent-text); padding: 0;
  }
  .reset-btn:hover { text-decoration: underline; }
  .seg {
    display: inline-flex; gap: 2px; padding: 3px;
    border-radius: var(--r-md); background: var(--surface-2); border: 1px solid var(--border);
  }
  .seg button {
    font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-medium);
    cursor: pointer; padding: 5px 13px; border-radius: var(--r-sm);
    border: none; background: transparent; color: var(--text-muted);
  }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
</style>
