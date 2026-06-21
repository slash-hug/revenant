/**
 * Opening-animation gating logic, extracted as a pure function so the decision
 * is unit-testable in isolation from App.svelte's open flow.
 *
 * The ink-bloom splash (Suminagashi) only ever plays when entering the workspace
 * from the empty welcome screen (`wasEmpty`). Two user settings further gate it:
 *
 *  - `opening_animation` (master): when false, never animate — open straight in.
 *  - `opening_animation_first_launch_only`: when true, play only once per session;
 *    after the first play, returning to the welcome screen and reopening is silent.
 *
 * Both settings default to preserving the historical behavior (animate, replay
 * every time) when settings have not loaded yet.
 */
import type { Settings } from './types/ipc';

export interface OpeningAnimationContext {
  /** True when the workspace had zero tabs before this open (welcome → doc). */
  wasEmpty: boolean;
  /** The current settings, or null if not yet loaded. */
  settings: Settings | null;
  /** True if the splash has already played at least once this session. */
  alreadyPlayed: boolean;
}

export function shouldPlayOpeningAnimation(ctx: OpeningAnimationContext): boolean {
  // The splash is exclusively a welcome-screen → workspace transition.
  if (!ctx.wasEmpty) return false;

  // Master toggle off → never animate (defaults on when settings unloaded).
  const enabled = ctx.settings?.opening_animation ?? true;
  if (!enabled) return false;

  // First-launch-only → suppress once we've played it this session.
  const firstLaunchOnly = ctx.settings?.opening_animation_first_launch_only ?? false;
  if (firstLaunchOnly && ctx.alreadyPlayed) return false;

  return true;
}
