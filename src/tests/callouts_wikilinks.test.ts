/**
 * callouts_wikilinks.test.ts
 *
 * Tests for the callout core rule (T1.3) and wikilink inline rule (T1.4)
 * implemented in src/lib/render/markdown.ts.
 *
 * Known v1 limits (B-6, B-8 — accepted, not bugs):
 *  - B-6: Ink-wash annotation highlight does not paint inside a closed <details>
 *    element (Range geometry is zero). Annotations still resolve; the wash
 *    repaints once the user expands the callout. No code fix; documented here.
 *  - B-8 (Unicode slug strip): Unicode/CJK/accented heading text is stripped by
 *    slugify() (e.g. "Héading" → "hading"). [[#Héading]] therefore does NOT
 *    produce a working href in v1. This is the same behavior as the heading id
 *    itself; no change was made to avoid altering existing anchor ids.
 *  - B-8 (Duplicate heading collision): Two "## Introduction" headings both get
 *    id="introduction". [[#Introduction]] lands on the first. Ambiguity is not
 *    signalled. Accepted as a documented v1 limitation.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown, slugify } from '../lib/render/markdown';

// ---------------------------------------------------------------------------
// DOM helper (jsdom is available via vitest config)
// ---------------------------------------------------------------------------

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

// ---------------------------------------------------------------------------
// Callout rendering
// ---------------------------------------------------------------------------

describe('callout core rule — family detection', () => {
  const families: Array<[string, string]> = [
    ['info',    'callout-accent'],
    ['tip',     'callout-accent'],
    ['note',    'callout-accent'],
    ['success', 'callout-success'],
    ['check',   'callout-success'],
    ['done',    'callout-success'],
    ['warning', 'callout-warn'],
    ['caution', 'callout-warn'],
    ['attention','callout-warn'],
    ['danger',  'callout-danger'],
    ['error',   'callout-danger'],
    ['example', 'callout-neutral'],
    ['quote',   'callout-neutral'],
  ];

  for (const [type, cssClass] of families) {
    it(`[!${type}] maps to ${cssClass}`, () => {
      const html = renderMarkdown(`> [!${type}]\n> Body.`);
      const doc = parse(html);
      const el = doc.querySelector(`.callout.${cssClass}`);
      expect(el).not.toBeNull();
    });
  }
});

describe('callout core rule — unknown type defaults to neutral', () => {
  it('maps [!xyzzy] to callout-neutral', () => {
    const html = renderMarkdown('> [!xyzzy]\n> Body.');
    const doc = parse(html);
    expect(doc.querySelector('.callout.callout-neutral')).not.toBeNull();
  });
});

describe('callout core rule — title rendering', () => {
  it('uses capitalized type as default title when none supplied', () => {
    const html = renderMarkdown('> [!info]\n> Body.');
    const doc = parse(html);
    const title = doc.querySelector('.callout-title');
    expect(title?.textContent?.trim()).toBe('Info');
  });

  it('uses custom title text when supplied', () => {
    const html = renderMarkdown('> [!warning] Watch out!\n> Body.');
    const doc = parse(html);
    const title = doc.querySelector('.callout-title');
    expect(title?.textContent?.trim()).toBe('Watch out!');
  });

  it('uses alias alias when title has spaces', () => {
    const html = renderMarkdown('> [!danger] Do not do this\n> Body.');
    const doc = parse(html);
    const title = doc.querySelector('.callout-title');
    expect(title?.textContent?.trim()).toBe('Do not do this');
  });
});

describe('callout core rule — collapsible variants', () => {
  it('static callout (no +/-) renders as <div class="callout">', () => {
    const html = renderMarkdown('> [!info] Static\n> Body.');
    const doc = parse(html);
    const el = doc.querySelector('div.callout');
    expect(el).not.toBeNull();
    // Must NOT be a <details> element.
    expect(doc.querySelector('details.callout')).toBeNull();
  });

  it('[!type]+ collapsible open renders as <details open>', () => {
    const html = renderMarkdown('> [!info]+ Open\n> Body.');
    const doc = parse(html);
    const details = doc.querySelector('details.callout');
    expect(details).not.toBeNull();
    // jsdom preserves the boolean attribute as an attribute (not interactive).
    expect(details?.hasAttribute('open')).toBe(true);
  });

  it('[!type]- collapsible closed renders as <details> without open', () => {
    const html = renderMarkdown('> [!info]- Closed\n> Body.');
    const doc = parse(html);
    const details = doc.querySelector('details.callout');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('collapsible uses <summary class="callout-title">', () => {
    const html = renderMarkdown('> [!note]+ Expandable\n> Content.');
    const doc = parse(html);
    expect(doc.querySelector('summary.callout-title')).not.toBeNull();
    // Static variant uses <div class="callout-title">, not <summary>.
    const staticHtml = renderMarkdown('> [!note] Static\n> Content.');
    const staticDoc = parse(staticHtml);
    expect(staticDoc.querySelector('div.callout-title')).not.toBeNull();
    expect(staticDoc.querySelector('summary.callout-title')).toBeNull();
  });
});

describe('callout core rule — data attributes (TRAP 4 / B-4)', () => {
  it('outer element carries data-block-id, data-source-line, data-block-type="callout"', () => {
    const html = renderMarkdown('> [!info] Title\n> Body.');
    const doc = parse(html);
    const outer = doc.querySelector('.callout') as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.dataset.blockId).toMatch(/^blk-\d+$/);
    expect(Number(outer?.dataset.sourceLine)).toBeGreaterThan(0);
    expect(outer?.dataset.blockType).toBe('callout');
  });

  it('data-callout carries the raw callout type', () => {
    const html = renderMarkdown('> [!warning] Title\n> Body.');
    const doc = parse(html);
    const outer = doc.querySelector('.callout') as HTMLElement | null;
    expect(outer?.dataset.callout).toBe('warning');
  });

  it('collapsible callout outer element also carries all three data-attrs', () => {
    const html = renderMarkdown('> [!success]- Closed\n> Body.');
    const doc = parse(html);
    const details = doc.querySelector('details.callout') as HTMLElement | null;
    expect(details).not.toBeNull();
    expect(details?.dataset.blockId).toMatch(/^blk-\d+$/);
    expect(Number(details?.dataset.sourceLine)).toBeGreaterThan(0);
    expect(details?.dataset.blockType).toBe('callout');
  });
});

describe('callout core rule — callout is NOT rendered as <blockquote> (TRAP 10)', () => {
  it('a callout block emits no <blockquote> element', () => {
    const html = renderMarkdown('> [!info] Test\n> Body.');
    const doc = parse(html);
    expect(doc.querySelector('blockquote')).toBeNull();
  });

  it('a normal blockquote (no marker) still emits <blockquote>', () => {
    const html = renderMarkdown('> Normal quote.');
    const doc = parse(html);
    expect(doc.querySelector('blockquote')).not.toBeNull();
  });
});

describe('callout core rule — multi-line body (TRAP 6)', () => {
  it('renders bold, inline code, and list items inside callout body', () => {
    const src = [
      '> [!note] Complex',
      '> **Bold text** and `inline code`.',
      '> - list item one',
    ].join('\n');
    const html = renderMarkdown(src);
    const doc = parse(html);
    // Callout container is present.
    expect(doc.querySelector('.callout')).not.toBeNull();
    // Bold survives inside the body.
    const body = doc.querySelector('.callout-body');
    expect(body).not.toBeNull();
    expect(body?.querySelector('strong')).not.toBeNull();
    // Inline code survives.
    expect(body?.querySelector('code')).not.toBeNull();
    // List item survives.
    expect(body?.querySelector('li')).not.toBeNull();
  });
});

describe('callout core rule — nested callouts (B-5)', () => {
  it('each nested callout carries its own data-block-id and data-source-line', () => {
    const src = [
      '> [!info] Outer',
      '> Outer body.',
      '> ',
      '> > [!success] Inner',
      '> > Inner body.',
    ].join('\n');
    const html = renderMarkdown(src);
    const doc = parse(html);
    const callouts = doc.querySelectorAll<HTMLElement>('.callout');
    // At least two callout elements (outer + inner).
    expect(callouts.length).toBeGreaterThanOrEqual(2);
    const ids = Array.from(callouts).map((el) => el.dataset.blockId);
    // All block ids are distinct.
    expect(new Set(ids).size).toBe(ids.length);
    // Every callout has all three required attrs.
    for (const el of callouts) {
      expect(el.dataset.blockId).toMatch(/^blk-\d+$/);
      expect(Number(el.dataset.sourceLine)).toBeGreaterThan(0);
      expect(el.dataset.blockType).toBe('callout');
    }
  });
});

// ---------------------------------------------------------------------------
// Wikilink rendering
// ---------------------------------------------------------------------------

describe('wikilink inline rule — in-doc anchors', () => {
  it('[[#H]] produces <a href="#slug"> with correct slug (TRAP 2 / slug cross-check)', () => {
    // Render both a heading and a wikilink in the same doc to cross-check slugs.
    const src = '## My Heading\n\nSee [[#My Heading]].';
    const html = renderMarkdown(src);
    const doc = parse(html);

    const h2 = doc.querySelector('h2');
    const a = doc.querySelector('a.wikilink-anchor');

    expect(h2).not.toBeNull();
    expect(a).not.toBeNull();

    // The link href must match the heading id.
    const headingId = h2!.id;
    const linkHref = a!.getAttribute('href');
    expect(linkHref).toBe('#' + headingId);
    // Both must equal the expected slug.
    expect(headingId).toBe(slugify('My Heading'));
    expect(linkHref).toBe('#' + slugify('My Heading'));
  });

  it('[[#H|Alias]] uses alias as link text', () => {
    const html = renderMarkdown('## Section\n\nLink: [[#Section|Go there]].');
    const doc = parse(html);
    const a = doc.querySelector('a.wikilink-anchor');
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe('Go there');
    expect(a?.getAttribute('href')).toBe('#' + slugify('Section'));
  });

  it('[[#H]] uses heading text as link text when no alias', () => {
    const html = renderMarkdown('## Section\n\nLink: [[#Section]].');
    const doc = parse(html);
    const a = doc.querySelector('a.wikilink-anchor');
    expect(a?.textContent).toBe('Section');
  });
});

describe('wikilink inline rule — cross-file / inert spans', () => {
  it('[[Page]] renders as inert .wikilink-unresolved span with title', () => {
    const html = renderMarkdown('See [[Some Page]].');
    const doc = parse(html);
    const span = doc.querySelector('span.wikilink.wikilink-unresolved');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('title')).toBe('Some Page');
    expect(span?.textContent).toBe('Some Page');
  });

  it('[[Page|Alias]] uses alias text', () => {
    const html = renderMarkdown('See [[Some Page|the page]].');
    const doc = parse(html);
    const span = doc.querySelector('span.wikilink-unresolved');
    expect(span?.textContent).toBe('the page');
    expect(span?.getAttribute('title')).toBe('Some Page');
  });

  it('[[Page#Heading]] renders as inert span (cross-file anchor not resolved)', () => {
    const html = renderMarkdown('See [[Other Doc#Section]].');
    const doc = parse(html);
    const span = doc.querySelector('span.wikilink-unresolved');
    expect(span).not.toBeNull();
  });
});

describe('wikilink inline rule — embed / transclusion (![[…]]) (TRAP 9)', () => {
  it('![[Page]] renders as inert .wikilink-unresolved span, not raw text', () => {
    const html = renderMarkdown('Embed: ![[Page]].');
    const doc = parse(html);
    // Must produce an inert span, never literal "![[Page]]" text.
    const span = doc.querySelector('span.wikilink-unresolved');
    expect(span).not.toBeNull();
    expect(span?.getAttribute('title')).toBe('Page');
    // The "!" prefix must NOT appear as literal text in the output.
    expect(html).not.toContain('![[');
  });

  it('![[Page]] is NOT consumed by the image rule (B-3)', () => {
    // If this fails (no span, no img, just raw text), switch inline rule to
    // before('image', ...) per plan B-3.
    const html = renderMarkdown('![[ImageFile]]');
    const doc = parse(html);
    const span = doc.querySelector('span.wikilink-unresolved');
    expect(span).not.toBeNull();
    // Must not produce an <img> element.
    expect(doc.querySelector('img')).toBeNull();
  });
});

describe('wikilink inline rule — escaping and code spans', () => {
  it('\\\\[[Page]] is NOT parsed as a wikilink (escape rule)', () => {
    // markdown-it escape rule turns \[[ into literal [[
    const html = renderMarkdown('\\[[Page]]');
    expect(html).not.toContain('wikilink');
    expect(html).toContain('[[Page]]');
  });

  it('[[…]] inside a code span is untouched', () => {
    const html = renderMarkdown('`[[code span content]]`');
    const doc = parse(html);
    // No wikilink CSS class should appear — the brackets stay literal inside <code>.
    expect(doc.querySelector('.wikilink')).toBeNull();
    expect(html).toContain('[[code span content]]');
  });

  it('[[…]] inside a fenced code block is untouched', () => {
    const html = renderMarkdown('```\n[[not parsed]]\n```');
    const doc = parse(html);
    // No wikilink CSS class should appear — content inside fences is literal.
    expect(doc.querySelector('.wikilink')).toBeNull();
    expect(html).toContain('[[not parsed]]');
  });

  it('*[[Page]]* — wikilink inside emphasis renders (TRAP 8)', () => {
    const html = renderMarkdown('*[[Page]]*');
    const doc = parse(html);
    // The wikilink span must exist inside an <em>.
    const em = doc.querySelector('em');
    expect(em).not.toBeNull();
    const span = em?.querySelector('span.wikilink-unresolved');
    expect(span).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// slugify helper (re-exported; cross-check tests)
// ---------------------------------------------------------------------------

describe('slugify (T1.1)', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('My Heading')).toBe('my-heading');
  });

  it('strips special characters', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('trims leading/trailing whitespace', () => {
    expect(slugify('  padded  ')).toBe('padded');
  });

  it('collapses multiple spaces', () => {
    expect(slugify('a  b   c')).toBe('a-b-c');
  });

  it('preserves hyphens already present', () => {
    expect(slugify('my-heading')).toBe('my-heading');
  });

  // Known v1 limitation (B-8): Unicode chars are stripped.
  it('strips accented characters (v1 known limitation B-8)', () => {
    const result = slugify('Héading');
    // Asserts current behavior (stripping), not the desired future behavior.
    expect(result).not.toContain('é');
  });
});
