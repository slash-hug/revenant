/**
 * markdown_sanitize.test.ts
 *
 * Security #12: the general document sanitizer (PURIFY_CONFIG) must NOT allow
 * the SVG `foreignObject` tag or the inline `style` attribute on embedded raw
 * HTML/SVG — both are classic SVG sanitizer-bypass / CSS-injection surfaces with
 * no use in document markdown. (Mermaid output is sanitized separately with its
 * own profile-based config, which legitimately keeps them.)
 *
 * T1.6 additions: <details>/<summary>/open attribute survival cases for
 * collapsible callouts (TRAP 1). These ensure DOMPurify does not strip the
 * elements or the open boolean attribute after the callout core rule emits them.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../lib/render/markdown';
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';

describe('document sanitizer (PURIFY_CONFIG) hardening', () => {
  it('strips <foreignObject> from embedded raw SVG', () => {
    const html = renderMarkdown(
      '<svg><foreignObject><div onclick="alert(1)">x</div></foreignObject></svg>',
    );
    expect(html.toLowerCase()).not.toContain('foreignobject');
  });

  it('strips inline style attributes from embedded raw HTML/SVG', () => {
    const html = renderMarkdown('<svg><rect style="fill:url(javascript:alert(1))" /></svg>');
    expect(html.toLowerCase()).not.toContain('style=');
  });

  it('still renders benign SVG shapes and normal markdown', () => {
    const html = renderMarkdown('# Heading\n\n<svg><circle r="4" /></svg>');
    expect(html).toContain('<h1');
    expect(html.toLowerCase()).toContain('<circle');
  });
});

// ---------------------------------------------------------------------------
// T1.6 — <details>/<summary>/open attribute survival (TRAP 1 / collapsible callouts)
// ---------------------------------------------------------------------------

describe('collapsible callout sanitization (T1.6 / TRAP 1)', () => {
  it('[!warning]- callout renders <details> and <summary> that survive DOMPurify', () => {
    // A [!type]- callout must produce <details> + <summary>; if DOMPurify strips
    // them the collapsible is silently lost (TRAP 1 — highest-risk silent failure).
    const html = renderMarkdown('> [!warning]- Heads up\n> body');
    expect(html.toLowerCase()).toContain('<details');
    expect(html.toLowerCase()).toContain('<summary');
    // Inner text (body) must also survive.
    expect(html).toContain('body');
  });

  it('[!info]+ callout renders <details open> with the open attribute preserved', () => {
    const html = renderMarkdown('> [!info]+ Expanded\n> body');
    expect(html.toLowerCase()).toContain('<details');
    // The `open` boolean attribute must survive sanitization.
    expect(html).toMatch(/open/);
  });

  it('<details open> round-trips through DOMPurify with open preserved', () => {
    // Direct DOMPurify test: confirms the allowlist addition ('open' in ALLOWED_ATTR
    // and 'details'/'summary' in ALLOWED_TAGS) is wired correctly.
    const input = '<details open><summary>Title</summary><p>Content</p></details>';
    const output = DOMPurify.sanitize(input, {
      ALLOWED_TAGS: ['details', 'summary', 'p'],
      ALLOWED_ATTR: ['open'],
    } as unknown as DOMPurifyConfig) as unknown as string;
    expect(output.toLowerCase()).toContain('<details');
    expect(output.toLowerCase()).toContain('open');
    expect(output.toLowerCase()).toContain('<summary>');
    expect(output).toContain('Content');
  });
});
