/**
 * settings_panel_shell.test.ts — SettingsPage full-window shell invariants.
 *
 * Replaces the old SettingsPanel <dialog> invariant test (regression #37).
 * Now guards the full-window page against regressions specific to the new
 * shell design: no <dialog>, no [open]-gated display, per-tab aria-controls
 * uniqueness, and no unconditional visibility-bleed rule.
 *
 * Component mounting is not wired for this repo's vitest setup (it resolves
 * to the SSR build), so we guard invariants directly from the source text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(process.cwd(), 'src/lib/SettingsPage.svelte'), 'utf8');

/** Extract the body of a base class rule `\.name {…}` (not `.name[…]`, not `.name-…`). */
function baseRuleBody(s: string, klass: string): string | null {
  const m = s.match(new RegExp(`\\.${klass}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

describe('SettingsPage — not a dialog (full-window page)', () => {
  it('contains no <dialog> element', () => {
    // The shell must use a <div role="region"> not a native <dialog>.
    expect(src).not.toMatch(/<dialog[\s>]/);
  });

  it('contains no [open] attribute or selector', () => {
    // [open] is the dialog-open attribute — must not appear in the full-page shell.
    expect(src).not.toMatch(/\[open\]/);
  });

  it('has no on:cancel handler (dialog-specific event)', () => {
    expect(src).not.toMatch(/on:cancel/);
  });

  it('has no open prop', () => {
    // The old SettingsPanel had `export let open: boolean`. SettingsPage uses
    // `category` instead — App.svelte controls visibility via conditional rendering.
    expect(src).not.toMatch(/export\s+let\s+open\s*[=:]/);
  });
});

describe('SettingsPage — root element visibility', () => {
  it('root .sp rule does NOT set display:none (no unconditional visibility bleed)', () => {
    const body = baseRuleBody(src, 'sp');
    expect(body, 'expected a base .sp { ... } rule').toBeTruthy();
    // display:none or visibility:hidden would cause the page to never render.
    expect(body!).not.toMatch(/display\s*:\s*none/);
    expect(body!).not.toMatch(/visibility\s*:\s*hidden/);
  });

  it('root .sp rule sets display:flex (always visible when rendered)', () => {
    const body = baseRuleBody(src, 'sp');
    expect(body!).toMatch(/display\s*:\s*flex/);
  });
});

describe('SettingsPage — per-tab aria-controls uniqueness', () => {
  it('uses aria-controls="sp-panel-{id}" pattern (not a shared id)', () => {
    // Must contain the template interpolation for unique per-tab ids.
    expect(src).toMatch(/aria-controls=\{`sp-panel-\$\{/);
  });

  it('panel id uses the same sp-panel-{id} pattern', () => {
    // The detail pane must have id="sp-panel-{activeId}" to match the tab control.
    expect(src).toMatch(/id=\{`sp-panel-\$\{/);
  });

  it('does NOT use a static shared aria-controls="sp-panel" (the old defect)', () => {
    // The old SettingsPanel used aria-controls="sp-panel" for all tabs — that was
    // the a11y defect. The new pattern must be unique per tab.
    expect(src).not.toMatch(/aria-controls="sp-panel"/);
  });
});

describe('SettingsPage — component API', () => {
  it('accepts a category prop', () => {
    expect(src).toMatch(/export\s+let\s+category/);
  });

  it('dispatches on:close event', () => {
    expect(src).toMatch(/dispatch\('close'\)/);
  });

  it('has a Back-to-document button', () => {
    expect(src).toMatch(/Back to document/);
  });

  it('has role="region" on the root element (not role="dialog")', () => {
    expect(src).toMatch(/role="region"/);
    expect(src).not.toMatch(/role="dialog"/);
  });
});

describe('SettingsPage — master-detail sidebar (preserved from SettingsPanel)', () => {
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

  it('section components carry no top-level section-title heading', () => {
    for (const f of ['AppearanceSection', 'ObsidianSection', 'AboutSection']) {
      const s = readFileSync(resolve(process.cwd(), `src/lib/settings/${f}.svelte`), 'utf8');
      expect(s, `${f} should not declare a section-title`).not.toMatch(/class="section-title"/);
    }
  });
});
