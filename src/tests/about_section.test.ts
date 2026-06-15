/**
 * about_section.test.ts — Unit tests for aboutChipState.ts (WS-C / C1).
 *
 * Tests every branch of the pure chip-state mapping function.
 * No component rendering needed — the helper is purely functional and can be
 * tested directly (component mounting is not wired for this repo's vitest
 * setup — it resolves to the SSR build).
 */

import { describe, it, expect } from 'vitest';
import { aboutChipState } from '../lib/settings/aboutChipState';
import type { AboutChipInput, UpdateCheckResult } from '../lib/settings/aboutChipState';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeCheck(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    current: '0.1.0',
    latest: '0.2.0',
    update_available: true,
    release_url: 'https://github.com/slash-hug/revenant/releases/tag/v0.2.0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------

describe('aboutChipState — idle', () => {
  it('returns empty chipClass and chipText with showDownload false', () => {
    const result = aboutChipState({ status: 'idle' });
    expect(result.chipClass).toBe('');
    expect(result.chipText).toBe('');
    expect(result.showDownload).toBe(false);
  });

  it('ignores a check payload when idle', () => {
    const result = aboutChipState({ status: 'idle', check: makeCheck() });
    expect(result.chipClass).toBe('');
    expect(result.showDownload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checking
// ---------------------------------------------------------------------------

describe('aboutChipState — checking', () => {
  it('returns empty chipClass and chipText with showDownload false', () => {
    const result = aboutChipState({ status: 'checking' });
    expect(result.chipClass).toBe('');
    expect(result.chipText).toBe('');
    expect(result.showDownload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// up-to-date
// ---------------------------------------------------------------------------

describe('aboutChipState — up-to-date', () => {
  it('returns chip-ok class', () => {
    const result = aboutChipState({ status: 'up-to-date' });
    expect(result.chipClass).toContain('chip-ok');
    expect(result.chipClass).toContain('chip');
  });

  it('returns "Up to date" text', () => {
    const result = aboutChipState({ status: 'up-to-date' });
    expect(result.chipText).toBe('Up to date');
  });

  it('does not show Download button', () => {
    const result = aboutChipState({ status: 'up-to-date' });
    expect(result.showDownload).toBe(false);
  });

  it('works with or without a check payload', () => {
    const withCheck = aboutChipState({
      status: 'up-to-date',
      check: makeCheck({ update_available: false, latest: '0.1.0' }),
    });
    const withoutCheck = aboutChipState({ status: 'up-to-date' });
    expect(withCheck.chipClass).toBe(withoutCheck.chipClass);
  });
});

// ---------------------------------------------------------------------------
// update-available
// ---------------------------------------------------------------------------

describe('aboutChipState — update-available', () => {
  it('returns chip-info class', () => {
    const result = aboutChipState({ status: 'update-available', check: makeCheck() });
    expect(result.chipClass).toContain('chip-info');
    expect(result.chipClass).toContain('chip');
  });

  it('does NOT use chip-warn (semantic correctness — an update is informational)', () => {
    const result = aboutChipState({ status: 'update-available', check: makeCheck() });
    expect(result.chipClass).not.toContain('chip-warn');
  });

  it('returns "Update available" text', () => {
    const result = aboutChipState({ status: 'update-available', check: makeCheck() });
    expect(result.chipText).toBe('Update available');
  });

  it('shows Download button', () => {
    const result = aboutChipState({ status: 'update-available', check: makeCheck() });
    expect(result.showDownload).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error
// ---------------------------------------------------------------------------

describe('aboutChipState — error', () => {
  it('returns chip-err class', () => {
    const result = aboutChipState({ status: 'error' });
    expect(result.chipClass).toContain('chip-err');
    expect(result.chipClass).toContain('chip');
  });

  it('returns the generic error text', () => {
    const result = aboutChipState({ status: 'error' });
    expect(result.chipText).toBe("Couldn't check for updates");
  });

  it('does not show Download button', () => {
    const result = aboutChipState({ status: 'error' });
    expect(result.showDownload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Return-type shape invariants
// ---------------------------------------------------------------------------

describe('aboutChipState — return type invariants', () => {
  const allStatuses: Array<AboutChipInput['status']> = [
    'idle',
    'checking',
    'up-to-date',
    'update-available',
    'error',
  ];

  it.each(allStatuses)('returns all three fields for status=%s', (status) => {
    const result = aboutChipState({ status });
    expect(typeof result.chipClass).toBe('string');
    expect(typeof result.chipText).toBe('string');
    expect(typeof result.showDownload).toBe('boolean');
  });

  it('showDownload is only true for update-available', () => {
    for (const status of allStatuses) {
      const { showDownload } = aboutChipState({ status });
      if (status === 'update-available') {
        expect(showDownload, `expected showDownload=true for ${status}`).toBe(true);
      } else {
        expect(showDownload, `expected showDownload=false for ${status}`).toBe(false);
      }
    }
  });
});
