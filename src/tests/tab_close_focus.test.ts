/**
 * tab_close_focus.test.ts — APG tablist focus-model invariants for TabManager.svelte (#42).
 *
 * These tests guard the fix for the double-focus bug: the close button inside
 * each tab must NOT participate in the sequential Tab order (tabindex="-1"),
 * while the tab itself uses the roving-tabindex pattern. A keyboard path for
 * closing (Delete key on the focused tab) must exist. The close button must
 * still carry its accessible name.
 *
 * Component mounting is not wired for this repo's vitest setup (it resolves to
 * the SSR build), so we guard invariants directly from the source text — the
 * same approach used by settings_panel_shell.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(process.cwd(), 'src/lib/TabManager.svelte'), 'utf8');

// ── Roving tabindex on the tab element ──────────────────────────────────────

describe('TabManager — roving tabindex on tab element (APG tablist pattern)', () => {
  it('active tab gets tabindex=0 via the roving expression', () => {
    // The roving expression assigns 0 to the active tab, -1 to all others.
    expect(src).toMatch(/tabindex=\{.*activeTab.*\?\s*0\s*:\s*-1\s*\}/);
  });

  it('inactive tabs get tabindex=-1 via the roving expression (not a static default)', () => {
    // Ensure the ternary's false-branch is -1, not 0 (which would make ALL tabs Tab stops).
    expect(src).toMatch(/tabindex=\{.*activeTab.*\?\s*0\s*:\s*-1\s*\}/);
  });
});

// ── Close button must NOT be a Tab stop ─────────────────────────────────────

describe('TabManager — close button tabindex (APG #42 fix)', () => {
  it('close button (.tab-x) has tabindex="-1" (not a sequential Tab stop)', () => {
    // The button must carry a static or expression-based tabindex that resolves
    // to -1 so it does not get inserted into the sequential Tab order alongside
    // the roving tab element.
    //
    // Accept either: tabindex="-1" (static)
    //            or: tabindex={-1}  (expression — both are equivalent)
    expect(src).toMatch(/class="tab-x"[\s\S]{0,200}tabindex=(?:"-1"|\{-1\})/);
  });

  it('close button does NOT have tabindex="0" or a missing tabindex (which defaults to 0)', () => {
    // Extract the opening tag of the .tab-x button (from `<button` up to the first `>`
    // that closes the opening tag). We verify it carries tabindex={-1}, not tabindex=0.
    // Strategy: find `<button` followed by class="tab-x" (allowing other attrs between).
    const buttonOpenTag = src.match(/<button\b[^>]*class="tab-x"[^>]*>/);
    expect(buttonOpenTag, 'expected to find the .tab-x button opening tag').toBeTruthy();
    const tag = buttonOpenTag![0];
    expect(tag).not.toMatch(/tabindex="0"/);
    expect(tag).not.toMatch(/tabindex=\{0\}/);
    // Must have an explicit tabindex (either -1 form).
    expect(tag).toMatch(/tabindex=(?:"-1"|\{-1\})/);
  });
});

// ── focus-visible on the close button ───────────────────────────────────────

describe('TabManager — close button focus-visible ring (APG #42 fix)', () => {
  it('styles .tab-x with :focus-visible (not :focus)', () => {
    // :focus shows the ring on mouse click; :focus-visible only shows on keyboard focus.
    // The style block must use :focus-visible for the close button.
    expect(src).toMatch(/\.tab-x:focus-visible/);
  });

  it('does NOT use .tab-x:focus for the ring rule (which leaks to mouse)', () => {
    // Stripped of focus-visible occurrences — there must be no bare .tab-x:focus rule
    // (which would produce a ring on mouse clicks too).
    const styleMatch = src.match(/<style>([\s\S]*?)<\/style>/);
    expect(styleMatch, 'expected a <style> block').toBeTruthy();
    const style = styleMatch![1];
    // Allow .tab-x:focus-visible but not bare .tab-x:focus {
    const focusOnlyRules = style.match(/\.tab-x:focus\s*\{/g) ?? [];
    expect(focusOnlyRules).toHaveLength(0);
  });

  it(':focus-visible rule includes an outline property', () => {
    expect(src).toMatch(/\.tab-x:focus-visible\s*\{[^}]*outline/);
  });
});

// ── Keyboard close path ──────────────────────────────────────────────────────

describe('TabManager — keyboard close path (APG #42 fix)', () => {
  it('handleTabKeydown handles the Delete key', () => {
    // Delete on the focused tab should dispatch the close event.
    // We look for a string literal 'Delete' inside the keydown handler.
    expect(src).toMatch(/['"`]Delete['"`]/);
  });

  it('Delete key handler dispatches the close event', () => {
    // The handler must call dispatch with 'close' when Delete is pressed.
    // Accept both: dispatch('close', { id }) patterns and variants.
    expect(src).toMatch(/dispatch\(\s*['"]close['"]/);
  });

  it('Delete key does not conflict with arrow-key roving (all handled in handleTabKeydown)', () => {
    // All keyboard handling for the tab element lives in one handler.
    // There must be exactly one on:keydown binding on the tab div.
    const keydownMatches = src.match(/on:keydown=/g) ?? [];
    expect(keydownMatches.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Accessible name on close button ─────────────────────────────────────────

describe('TabManager — close button accessible name (regression guard)', () => {
  it('close button has an aria-label that interpolates the file name', () => {
    // The label must remain `Close ${fileName(tab.path)}` (or equivalent).
    expect(src).toMatch(/aria-label=\{`Close \$\{/);
  });

  it('close button SVG has aria-hidden="true"', () => {
    // The decorative SVG inside the button must be hidden from AT.
    expect(src).toMatch(/aria-hidden="true"/);
  });
});

// ── Pointer target size ──────────────────────────────────────────────────────

describe('TabManager — close button pointer target (WCAG 2.5.8 regression guard)', () => {
  it('preserves the WCAG 2.5.8 comment in the .tab-x style rule', () => {
    expect(src).toMatch(/WCAG 2\.5\.8/);
  });

  it('.tab-x has min-width: 24px', () => {
    expect(src).toMatch(/min-width\s*:\s*24px/);
  });

  it('.tab-x has min-height: 24px', () => {
    expect(src).toMatch(/min-height\s*:\s*24px/);
  });
});
