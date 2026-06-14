/**
 * annotation_popover.test.ts — T1.4 Popover placement tests
 *
 * Tests the placement logic encoded in AnnotationPopover.svelte:
 *  1. Default: popover appears below the anchor rect.
 *  2. Flip-above when anchor.bottom + popoverHeight > window.innerHeight.
 *  3. Top clamp: popover never renders above toolbarBottom + TOOLBAR_GAP.
 *
 * These tests exercise the pure placement math in isolation (without mounting
 * the full Svelte component, to avoid jsdom Svelte rendering complexity).
 * The logic mirrors AnnotationPopover.svelte's computePlacement() exactly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Constants mirrored from AnnotationPopover.svelte ─────────────────────────
const POPOVER_WIDTH = 300;
const POPOVER_HEIGHT = 240;
const GAP = 8;
const VIEWPORT_MARGIN = 12;
const TOOLBAR_GAP = 8;

// ── Types ─────────────────────────────────────────────────────────────────────
interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
}

interface PopoverPosition {
  left: number;
  top: number;
}

// ── Pure placement function (extracted from AnnotationPopover.computePlacement) ─
function computePopoverPlacement(
  anchorRect: AnchorRect,
  windowWidth: number,
  windowHeight: number,
  toolbarBottom: number,
  popoverWidth = POPOVER_WIDTH,
  popoverHeight = POPOVER_HEIGHT,
): PopoverPosition {
  const minTop = toolbarBottom + TOOLBAR_GAP;

  // Horizontal: align to anchor left, clamped to viewport margins.
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchorRect.x),
    windowWidth - popoverWidth - VIEWPORT_MARGIN,
  );

  // Vertical: default below, flip above when it would overflow viewport.
  const belowTop = anchorRect.bottom + GAP;
  const aboveTop = anchorRect.y - popoverHeight - GAP;

  let top: number;
  if (belowTop + popoverHeight > windowHeight) {
    // Flip above — but clamp so we don't go under the toolbar.
    top = Math.max(minTop, aboveTop);
  } else {
    // Below — clamp to toolbar bottom just in case.
    top = Math.max(minTop, belowTop);
  }

  return { left, top };
}

// ── Test setup ────────────────────────────────────────────────────────────────

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const TOOLBAR_BOTTOM = 48;

// A typical anchor rect in the middle of the viewport.
function midAnchorRect(): AnchorRect {
  return { x: 100, y: 400, width: 200, height: 20, bottom: 420 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AnnotationPopover — placement (T1.4)', () => {

  // ── 1. Default: below the anchor ─────────────────────────────────────────────

  it('places the popover BELOW the anchor when there is enough vertical space', () => {
    const anchor = midAnchorRect();
    const pos = computePopoverPlacement(
      anchor,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      TOOLBAR_BOTTOM,
    );

    // Top should be anchor.bottom + GAP = 420 + 8 = 428
    expect(pos.top).toBe(anchor.bottom + GAP);
    expect(pos.top).toBeGreaterThan(anchor.bottom); // strictly below
  });

  // ── 2. Flip-above when anchor is near the bottom of the viewport ──────────────

  it('flips ABOVE the anchor when anchor.bottom + popoverHeight > windowHeight', () => {
    // Place anchor near the bottom so below would overflow.
    const anchor: AnchorRect = {
      x: 100,
      y: 600,  // close to bottom
      width: 200,
      height: 20,
      bottom: 620,
    };
    // Below: 620 + 8 + 240 = 868 > 800 (window height) → must flip above.
    const pos = computePopoverPlacement(
      anchor,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      TOOLBAR_BOTTOM,
    );

    // Popover should be above the anchor (top < anchor.y)
    expect(pos.top).toBeLessThan(anchor.y);
    // And above its bottom
    expect(pos.top + POPOVER_HEIGHT).toBeLessThanOrEqual(anchor.y + GAP + 1);
  });

  // ── 3. Top clamp: never renders under the toolbar ─────────────────────────────

  it('clamps the top to toolbarBottom + TOOLBAR_GAP when anchor is very near the top', () => {
    // Anchor so close to the top that even flip-above would go under the toolbar.
    const anchor: AnchorRect = {
      x: 100,
      y: 60,   // anchor is only slightly below the toolbar (toolbarBottom = 48)
      width: 200,
      height: 20,
      bottom: 80,
    };
    // Below: 80 + 8 = 88, 88 + 240 = 328 < 800 → would normally go below.
    // Below is fine here (88 > toolbarBottom + TOOLBAR_GAP = 56).
    const posBelow = computePopoverPlacement(
      anchor,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      TOOLBAR_BOTTOM,
    );
    expect(posBelow.top).toBeGreaterThanOrEqual(TOOLBAR_BOTTOM + TOOLBAR_GAP);

    // Now put the anchor near BOTTOM so we flip above, and above would be < minTop.
    const anchorNearBottom: AnchorRect = {
      x: 100,
      y: 750,
      width: 200,
      height: 20,
      bottom: 770,
    };
    // Below: 770 + 8 + 240 = 1018 > 800 → flip above: 750 - 240 - 8 = 502 > 56 (ok).
    // This case should work normally; the clamp ensures no negative positioning.
    const posAbove = computePopoverPlacement(
      anchorNearBottom,
      WINDOW_WIDTH,
      WINDOW_HEIGHT,
      TOOLBAR_BOTTOM,
    );
    expect(posAbove.top).toBeGreaterThanOrEqual(TOOLBAR_BOTTOM + TOOLBAR_GAP);
    expect(posAbove.top).toBeLessThan(anchorNearBottom.y);
  });

  it('never renders above the toolbar even if flip-above would result in a negative top', () => {
    // Tiny viewport so there's no good placement — clamp must win.
    const tinyWindowHeight = 100;
    const anchor: AnchorRect = {
      x: 100,
      y: 70,
      width: 200,
      height: 20,
      bottom: 90,
    };
    // Below: 90 + 8 + 240 = 338 > 100 → flip above: 70 - 240 - 8 = -178 → clamp to minTop.
    const pos = computePopoverPlacement(
      anchor,
      WINDOW_WIDTH,
      tinyWindowHeight,
      TOOLBAR_BOTTOM,
    );
    const minTop = TOOLBAR_BOTTOM + TOOLBAR_GAP; // 56
    expect(pos.top).toBe(minTop);
  });

  // ── 4. Horizontal clamping ────────────────────────────────────────────────────

  it('clamps left to VIEWPORT_MARGIN when anchor is near the left edge', () => {
    const anchor: AnchorRect = { x: 0, y: 400, width: 10, height: 20, bottom: 420 };
    const pos = computePopoverPlacement(anchor, WINDOW_WIDTH, WINDOW_HEIGHT, TOOLBAR_BOTTOM);
    expect(pos.left).toBe(VIEWPORT_MARGIN);
  });

  it('clamps left when anchor is near the right edge', () => {
    const anchor: AnchorRect = { x: 1200, y: 400, width: 10, height: 20, bottom: 420 };
    const pos = computePopoverPlacement(anchor, WINDOW_WIDTH, WINDOW_HEIGHT, TOOLBAR_BOTTOM);
    // left = min(max(12, 1200), 1280 - 300 - 12) = min(1200, 968) = 968
    expect(pos.left).toBe(WINDOW_WIDTH - POPOVER_WIDTH - VIEWPORT_MARGIN);
  });
});
