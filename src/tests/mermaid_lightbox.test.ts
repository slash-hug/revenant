/**
 * mermaid_lightbox.test.ts — structural tests for MermaidLightbox.svelte.
 *
 * Component mounting is not wired for this repo's vitest setup (it resolves
 * to the SSR build). We guard the key invariants via source-text inspection
 * and import of pure helpers — the same approach used by tab_close_focus.test.ts,
 * annotation_drawer_destroy.test.ts, etc.
 *
 * Invariants verified:
 *  - Uses native <dialog> with showModal() (top-layer, escapes .prose scaling)
 *  - SVG is injected once via {@html svg} from the prop — never re-sanitized,
 *    never re-run through Mermaid, never harvested from div.innerHTML
 *  - onClose is called on cancel (Esc) and on close button click
 *  - Copy-PNG calls copyDiagramAsPng and shows toast on failure
 *  - Timers typed as ReturnType<typeof setTimeout> (not raw number)
 *  - No literal closing script or style tags in JSDoc (svelte2tsx safety)
 *  - No AI assistant names hardcoded in labels
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(process.cwd(), 'src/lib/MermaidLightbox.svelte'),
  'utf8',
);

describe('MermaidLightbox — native dialog top-layer', () => {
  it('uses a native <dialog> element', () => {
    expect(src).toContain('<dialog');
  });

  it('opens via showModal() not a class toggle', () => {
    expect(src).toContain('showModal()');
  });

  it('does not use a fixed-position div as the overlay', () => {
    expect(src).not.toMatch(/position:\s*fixed/);
  });
});

describe('MermaidLightbox — SVG injection (DOMPurify invariant)', () => {
  it('injects svg via {@html svg} in the template (not via JS)', () => {
    // Must contain {@html svg} at least in the template portion
    expect(src).toContain('{@html svg}');
  });

  it('does NOT harvest innerHTML from the DOM', () => {
    // innerHTML must not appear in JavaScript (only in JSDoc comments is acceptable)
    // Strip JSDoc/comments and check the script body
    const scriptBody = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(scriptBody).not.toContain('innerHTML');
  });

  it('does NOT call renderMermaid() in runtime code (only in comments)', () => {
    // renderMermaid must not appear in a function call context — only in JSDoc
    // Strip block and line comments, then check
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toContain('renderMermaid');
    expect(codeOnly).not.toContain('mermaid.render');
  });

  it('does NOT call DOMPurify.sanitize() in runtime code (only in comments)', () => {
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(codeOnly).not.toContain('DOMPurify');
    expect(codeOnly).not.toContain('.sanitize(');
  });

  it('accepts svg as a prop (pre-sanitized from PreviewPane)', () => {
    // The Props interface must include svg: string
    expect(src).toMatch(/svg\s*:\s*string/);
  });
});

describe('MermaidLightbox — close behavior', () => {
  it('has a handleCancel function that calls onClose (Esc handler)', () => {
    expect(src).toContain('handleCancel');
    expect(src).toContain('onClose');
  });

  it('binds the cancel event to handleCancel on the dialog', () => {
    expect(src).toMatch(/oncancel=\{handleCancel\}/);
  });

  it('has a close button with lb-close class', () => {
    expect(src).toContain('lb-close');
  });

  it('close button invokes onClose', () => {
    // The close button should call onClose directly
    const closeButtonSection = src.substring(
      src.indexOf('lb-close'),
      src.indexOf('lb-close') + 200,
    );
    expect(closeButtonSection).toContain('onClose');
  });

  it('backdrop click (dialog target) calls onClose', () => {
    expect(src).toContain('handleBackdropClick');
    expect(src).toContain('e.target === dialog');
  });
});

describe('MermaidLightbox — zoom/pan interaction', () => {
  it('uses diagramTransform.ts (fitToView for lightbox 2x upscale)', () => {
    expect(src).toContain('fitToView');
    expect(src).toContain('zoomAtPoint');
  });

  it('handles pointer events for pan (drag)', () => {
    expect(src).toContain('onPointerDown');
    expect(src).toContain('onPointerMove');
    expect(src).toContain('onPointerUp');
  });

  it('handles wheel for cursor-anchored zoom', () => {
    expect(src).toContain('onWheel');
    expect(src).toContain('e.preventDefault()');
  });

  it('has zoom-in, zoom-out, and fit buttons', () => {
    expect(src).toContain('zoomIn');
    expect(src).toContain('zoomOut');
    expect(src).toContain('function fit()');
  });
});

describe('MermaidLightbox — copy PNG', () => {
  it('calls copyDiagramAsPng from diagramCopy', () => {
    expect(src).toContain('copyDiagramAsPng');
  });

  it('shows a toast on copy failure (false return)', () => {
    expect(src).toContain('toast.show');
  });
});

describe('MermaidLightbox — timer safety', () => {
  it('types copyTimer as ReturnType<typeof setTimeout>', () => {
    expect(src).toContain('ReturnType<typeof setTimeout>');
  });

  it('has $effect teardown for timers and rAFs', () => {
    expect(src).toContain('clearTimeout(copyTimer)');
    expect(src).toContain('cancelAnimationFrame');
  });
});

describe('MermaidLightbox — svelte2tsx safety', () => {
  it('has no literal closing script tag in JSDoc comments', () => {
    // svelte2tsx mis-parses literal </script> inside comments
    // Allow split forms like '</'+'script>' but not the literal token
    const scriptClose = /<\/script>/g;
    // Only one closing script tag is expected — the real closing tag of the script block
    const matches = src.match(scriptClose) ?? [];
    // The component's own closing </script> tag is expected
    expect(matches.length).toBeLessThanOrEqual(1);
  });

  it('has no literal closing style tag in JSDoc comments', () => {
    const styleClose = /<\/style>/g;
    const matches = src.match(styleClose) ?? [];
    // Only the real closing </style> tag
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

describe('MermaidLightbox — no hardcoded AI names', () => {
  it('does not hardcode any AI assistant names in UI labels', () => {
    expect(src).not.toMatch(/\bClaude\b/);
    expect(src).not.toMatch(/\bCopilot\b/);
    expect(src).not.toMatch(/\bGPT\b/);
    expect(src).not.toMatch(/\bGemini\b/);
  });
});
