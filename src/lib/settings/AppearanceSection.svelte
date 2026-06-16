<script lang="ts">
  /**
   * AppearanceSection.svelte — Appearance settings section.
   *
   * Embeds <ThemeToggle> which is self-managed via the `theme.ts` store
   * (localStorage → `<html data-theme>`). This component MUST NOT call
   * `patchSettings` or touch `settings.theme` — the `settings.theme` field is
   * orphaned; `theme.ts` is the canonical source of truth (TRAP 3).
   *
   * Svelte 4 options-API to match the component library.
   */

  import ThemeToggle from '../ThemeToggle.svelte';
  import SettingGroup from './SettingGroup.svelte';
  import SettingRow from './SettingRow.svelte';
</script>

<SettingGroup label="Appearance">
  <SettingRow
    label="Theme"
    helper="Choose between light (Paper) and dark (Graphite) mode."
  >
    <ThemeToggle />
  </SettingRow>
</SettingGroup>
