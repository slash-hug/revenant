/**
 * settings_panel_shell.test.ts — SettingsPanel <dialog> shell regression (#37).
 *
 * Regression: the base `.sp { display: flex }` rule overrode the UA
 * `dialog:not([open]) { display: none }`, so the panel rendered VISIBLE on the
 * splash screen at launch and could not be dismissed — it never opened modally,
 * so `dialog.open` stayed false and the close reactive's `dialog.close()` branch
 * was never reached. Display must be gated on `[open]` only, matching
 * ConflictModal / KeyboardShortcutsModal.
 *
 * This guards the CSS invariant directly from the component source. (Mounting
 * Svelte components is not wired for this repo's vitest setup — it resolves to
 * the SSR build — so a render-based test isn't feasible here; the source
 * invariant is the reliable guard for this specific bug.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Extract the body of a base class rule `\.name {…}` (not `.name[…]`, not `.name-…`). */
function baseRuleBody(src: string, klass: string): string | null {
  const m = src.match(new RegExp(`\\.${klass}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

describe('SettingsPanel — CSS display invariant (regression #37)', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/SettingsPanel.svelte'), 'utf8');

  it('base `.sp` rule declares no `display` (display must be gated on [open])', () => {
    const body = baseRuleBody(src, 'sp');
    expect(body, 'expected a base `.sp { ... }` rule in SettingsPanel.svelte').toBeTruthy();
    // A base `display` would override the UA `dialog:not([open]) { display: none }`,
    // leaving the panel stuck visible on the splash screen and undismissable.
    expect(body!).not.toMatch(/display\s*:/);
  });

  it('`.sp[open]` rule sets `display`', () => {
    const m = src.match(/\.sp\[open\]\s*\{([^}]*)\}/);
    expect(m, 'expected a `.sp[open] { ... }` rule').toBeTruthy();
    expect(m![1]).toMatch(/display\s*:\s*flex/);
  });
});

describe('SettingsPanel — master-detail sidebar (settings redesign)', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/lib/SettingsPanel.svelte'), 'utf8');

  it('renders a vertical tablist sidebar', () => {
    expect(src).toMatch(/role="tablist"/);
    expect(src).toMatch(/aria-orientation="vertical"/);
    expect(src).toMatch(/role="tabpanel"/);
  });

  it('defines the three categories (General / Integrations / About)', () => {
    for (const label of ['General', 'Integrations', 'About']) {
      expect(src, `expected category "${label}"`).toMatch(new RegExp(`label:\\s*'${label}'`));
    }
  });

  it('section components carry no top-level section-title heading (the pane title names them)', () => {
    for (const f of ['AppearanceSection', 'ObsidianSection', 'AboutSection']) {
      const s = readFileSync(resolve(process.cwd(), `src/lib/settings/${f}.svelte`), 'utf8');
      expect(s, `${f} should not declare a section-title`).not.toMatch(/class="section-title"/);
    }
  });
});
