/**
 * markdown_sanitize.test.ts
 *
 * Security #12: the general document sanitizer (PURIFY_CONFIG) must NOT allow
 * the SVG `foreignObject` tag or the inline `style` attribute on embedded raw
 * HTML/SVG — both are classic SVG sanitizer-bypass / CSS-injection surfaces with
 * no use in document markdown. (Mermaid output is sanitized separately with its
 * own profile-based config, which legitimately keeps them.)
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../lib/render/markdown';

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
