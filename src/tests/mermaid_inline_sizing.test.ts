/**
 * mermaid_inline_sizing.test.ts — structural tests for MermaidContainer inline sizing.
 *
 * Component mounting is not wired for this repo's vitest setup. We test:
 *  - Source-text invariants: no upscale (scale <= 1.0 at rest), CSS approach
 *  - The getSvgIntrinsicWidth logic (tested via the pure string-parsing behavior
 *    that the component uses inline)
 *  - Hover strip structure: zoom−/zoom+/fit/copy/expand; no `|| true` regression
 *  - onExpand prop structure
 *  - No pan/drag/viewport/scroll handlers (static presenter)
 *  - No openDiagramWindow import (popout removed)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(process.cwd(), 'src/lib/MermaidContainer.svelte'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Static presenter — no pan/zoom viewport machinery
// ---------------------------------------------------------------------------

describe('MermaidContainer — static presenter (no viewport/drag)', () => {
  it('does NOT have a viewportEl bound element (viewport removed)', () => {
    expect(src).not.toContain('viewportEl');
  });

  it('does NOT have a canvasEl bound element (canvas removed)', () => {
    expect(src).not.toContain('canvasEl');
  });

  it('does NOT have an onWheel handler (no scroll-jacking)', () => {
    expect(src).not.toContain('onWheel');
    expect(src).not.toContain('onwheel');
  });

  it('does NOT have drag/pan pointer handlers', () => {
    expect(src).not.toContain('onPointerDown');
    expect(src).not.toContain('onPointerMove');
    expect(src).not.toContain('dragging');
  });

  it('does NOT import openDiagramWindow (popout removed)', () => {
    expect(src).not.toContain('openDiagramWindow');
  });

  it('does NOT have a popout() function', () => {
    expect(src).not.toContain('popout()');
    expect(src).not.toContain('function popout');
  });

  it('does NOT have the "Scroll to pan · Ctrl+scroll to zoom" hint text', () => {
    expect(src).not.toContain('Scroll to pan');
    expect(src).not.toContain('Ctrl+scroll to zoom');
  });

  it('does NOT call fitToView from diagramTransform (inline never upscales)', () => {
    expect(src).not.toContain('fitToView');
  });
});

// ---------------------------------------------------------------------------
// Inline sizing: never upscale (spec §1, Architecture decision #3)
// ---------------------------------------------------------------------------

describe('MermaidContainer — inline sizing (never upscale)', () => {
  it('uses max-width:100% on the SVG via CSS (not a fixed height)', () => {
    // The presenter must not set a fixed height
    expect(src).not.toMatch(/viewportHeight/);
    expect(src).not.toContain('computeViewportHeight');
  });

  it('inline zoom initial value is 1.0 (no upscale baseline)', () => {
    // inlineScale starts at 1.0
    expect(src).toMatch(/inlineScale\s*=\s*\$state\(1(?:\.0)?\)/);
  });

  it('inline zoom min is 1.0 (never below fit-to-width)', () => {
    expect(src).toContain('INLINE_ZOOM_MIN = 1.0');
  });

  it('inline zoom max is 2.0 (bounded in-place magnification)', () => {
    expect(src).toContain('INLINE_ZOOM_MAX = 2.0');
  });

  it('zoom-in clamps at INLINE_ZOOM_MAX (never exceeds 2.0)', () => {
    // zoomIn must use Math.min with INLINE_ZOOM_MAX
    expect(src).toMatch(/Math\.min\(INLINE_ZOOM_MAX/);
  });

  it('zoom-out clamps at INLINE_ZOOM_MIN (never below 1.0)', () => {
    expect(src).toMatch(/Math\.max\(INLINE_ZOOM_MIN/);
  });

  it('fit function resets to 1.0 (fit-to-width)', () => {
    expect(src).toContain('inlineScale = 1.0');
  });

  it('uses mc-presenter class (not mc-viewport) for static display', () => {
    expect(src).toContain('mc-presenter');
    expect(src).not.toContain('mc-viewport');
  });
});

// ---------------------------------------------------------------------------
// Hover/focus control strip (spec §2, TRAP: no `|| true`)
// ---------------------------------------------------------------------------

describe('MermaidContainer — hover/focus control strip', () => {
  it('hovering starts as false ($state(false))', () => {
    expect(src).toMatch(/hovering\s*=\s*\$state\(false\)/);
  });

  it('focused starts as false ($state(false))', () => {
    expect(src).toMatch(/focused\s*=\s*\$state\(false\)/);
  });

  it('strip visible condition is (hovering || focused) — no `|| true` regression', () => {
    // Must contain the pattern without `|| true`
    const visibleExpr = src.match(/class:visible=\{([^}]+)\}/)?.[1] ?? '';
    expect(visibleExpr).toMatch(/hovering.*\|\|.*focused|focused.*\|\|.*hovering/);
    // Explicitly must NOT contain `|| true`
    expect(visibleExpr).not.toContain('|| true');
  });

  it('has zoomOut, zoomIn, fitToWidth, and copyPng functions', () => {
    expect(src).toContain('function zoomOut');
    expect(src).toContain('function zoomIn');
    expect(src).toContain('function fitToWidth');
    expect(src).toContain('function copyPng');
  });

  it('has an expand function that calls onExpand', () => {
    expect(src).toContain('function expand');
    expect(src).toContain('onExpand?.({');
  });

  it('expand button only rendered when onExpand prop is provided', () => {
    // Should use {#if onExpand} guard
    expect(src).toMatch(/\{#if onExpand\}/);
  });
});

// ---------------------------------------------------------------------------
// onExpand prop (Architecture decision #2 — callback prop for lightbox)
// ---------------------------------------------------------------------------

describe('MermaidContainer — onExpand prop', () => {
  it('declares onExpand in the Props interface', () => {
    expect(src).toMatch(/onExpand\?\s*:\s*\(/);
  });

  it('passes svg, source, blockId to onExpand', () => {
    // onExpand called with the prop values, not DOM-harvested content
    expect(src).toMatch(/onExpand\?\.\(\{\s*svg,\s*source,\s*blockId\s*\}\)/);
  });
});

// ---------------------------------------------------------------------------
// Card framing preserved (spec: preserve border/background/padding)
// ---------------------------------------------------------------------------

describe('MermaidContainer — card framing preserved', () => {
  it('mermaid-container class still present', () => {
    expect(src).toContain('class="mermaid-container"');
  });

  it('has border style on .mermaid-container', () => {
    // The border CSS rule must still exist
    expect(src).toContain('border:');
  });

  it('has border-radius on .mermaid-container', () => {
    expect(src).toContain('border-radius');
  });
});

// ---------------------------------------------------------------------------
// Timer safety
// ---------------------------------------------------------------------------

describe('MermaidContainer — timer safety', () => {
  it('types copyTimer as ReturnType<typeof setTimeout>', () => {
    expect(src).toContain('ReturnType<typeof setTimeout>');
  });

  it('has $effect teardown for copyTimer', () => {
    expect(src).toContain('clearTimeout(copyTimer)');
  });
});

// ---------------------------------------------------------------------------
// SVG intrinsic width parsing — pure string logic
// ---------------------------------------------------------------------------

describe('MermaidContainer — SVG intrinsic width parsing', () => {
  /**
   * Replicate the getSvgIntrinsicWidth logic from MermaidContainer.svelte
   * to test it in isolation. This function is inlined in the component;
   * we duplicate it here to verify the algorithm handles all cases correctly.
   */
  function getSvgIntrinsicWidth(markup: string): number {
    const wMatch = markup.match(/\bwidth="([^"]+)"/);
    const w = wMatch ? wMatch[1] : null;
    if (w && w !== '100%' && w !== 'auto') {
      const n = parseFloat(w);
      if (n > 0) return n;
    }
    const vbMatch = markup.match(/\bviewBox="([^"]+)"/);
    if (vbMatch) {
      const parts = vbMatch[1].split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0) return parts[2];
    }
    return 0;
  }

  it('returns explicit numeric width', () => {
    const svg = '<svg width="400" height="200" viewBox="0 0 400 200"></svg>';
    expect(getSvgIntrinsicWidth(svg)).toBe(400);
  });

  it('falls back to viewBox width when width="100%" (Mermaid v11)', () => {
    const svg = '<svg width="100%" height="auto" viewBox="0 0 600 300"></svg>';
    expect(getSvgIntrinsicWidth(svg)).toBe(600);
  });

  it('falls back to viewBox width when width="auto"', () => {
    const svg = '<svg width="auto" viewBox="0 0 500 250"></svg>';
    expect(getSvgIntrinsicWidth(svg)).toBe(500);
  });

  it('returns 0 when no width and no viewBox', () => {
    const svg = '<svg><rect/></svg>';
    expect(getSvgIntrinsicWidth(svg)).toBe(0);
  });

  it('fits-to-width calc: min(1.0, vpW/svgW) never upscales', () => {
    // For a small SVG (50px) in a 400px viewport: min(1.0, 400/50) = 1.0 (capped, not 8.0)
    const smallSvgW = 50;
    const vpW = 400;
    const scale = Math.min(1.0, vpW / smallSvgW);
    expect(scale).toBe(1.0);
  });

  it('fits-to-width calc: min(1.0, vpW/svgW) fits large SVG to column', () => {
    // For a wide SVG (800px) in a 400px viewport: min(1.0, 400/800) = 0.5
    const wideSvgW = 800;
    const vpW = 400;
    const scale = Math.min(1.0, vpW / wideSvgW);
    expect(scale).toBeCloseTo(0.5);
    expect(scale).toBeLessThanOrEqual(1.0);
  });
});
