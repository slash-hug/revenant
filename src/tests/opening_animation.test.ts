import { describe, it, expect } from 'vitest';
import { shouldPlayOpeningAnimation } from '../lib/openingAnimation';
import type { Settings } from '../lib/types/ipc';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    schema_version: 1,
    vaults: [],
    default_export_subfolder: '',
    theme: 'system',
    export_on_save: false,
    rest_key_ref: null,
    preview_zoom: 100,
    agent_nudge_template: '',
    agent_nudge_path_style: 'relative',
    opening_animation: true,
    opening_animation_first_launch_only: false,
    ...overrides,
  };
}

describe('shouldPlayOpeningAnimation', () => {
  it('never plays when a doc was already open (not a welcome→workspace transition)', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: false,
        settings: makeSettings(),
        alreadyPlayed: false,
      }),
    ).toBe(false);
  });

  it('plays on first open with default settings (animate, replay each time)', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: makeSettings(),
        alreadyPlayed: false,
      }),
    ).toBe(true);
  });

  it('replays on subsequent welcome→workspace transitions by default', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: makeSettings(),
        alreadyPlayed: true,
      }),
    ).toBe(true);
  });

  it('never plays when the master toggle is off — even on first open', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: makeSettings({ opening_animation: false }),
        alreadyPlayed: false,
      }),
    ).toBe(false);
  });

  it('first-launch-only: plays the first time this session', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: makeSettings({ opening_animation_first_launch_only: true }),
        alreadyPlayed: false,
      }),
    ).toBe(true);
  });

  it('first-launch-only: suppressed after it has already played this session', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: makeSettings({ opening_animation_first_launch_only: true }),
        alreadyPlayed: true,
      }),
    ).toBe(false);
  });

  it('defaults to animating when settings have not loaded yet', () => {
    expect(
      shouldPlayOpeningAnimation({
        wasEmpty: true,
        settings: null,
        alreadyPlayed: false,
      }),
    ).toBe(true);
  });
});
