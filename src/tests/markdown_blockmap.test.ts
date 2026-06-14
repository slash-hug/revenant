/**
 * markdown_blockmap.test.ts — block-level source-mapping attributes.
 *
 * Regression: tight list items had no data-source-line, so selecting text inside
 * a list item produced no anchor and the "+ Add comment" affordance never
 * appeared. List items must carry their own data-block-id / data-source-line.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../lib/render/markdown';

describe('renderMarkdown — block source mapping', () => {
  it('tight ordered-list items each carry data-source-line and data-block-id', () => {
    const md = [
      '# Title',
      '',
      '1. **Launcher** — first item',
      '2. **Tab manager** — second item',
      '3. Editor pane — third item',
    ].join('\n');

    const html = renderMarkdown(md);
    const lis = [...html.matchAll(/<li\b[^>]*>/g)].map((m) => m[0]);
    expect(lis.length).toBe(3);
    for (const li of lis) {
      expect(li).toMatch(/data-source-line="\d+"/);
      expect(li).toMatch(/data-block-id="blk-\d+"/);
      expect(li).toContain('data-block-type="list"');
    }
    // Source lines are 1-based and strictly increasing down the list.
    const lines = lis.map((li) => Number(/data-source-line="(\d+)"/.exec(li)![1]));
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines[0]).toBeGreaterThan(1); // after the heading
  });

  it('bullet-list items are mapped too', () => {
    const html = renderMarkdown('- one\n- two\n');
    const lis = [...html.matchAll(/<li\b[^>]*>/g)];
    expect(lis.length).toBe(2);
    expect(lis.every((m) => /data-source-line="\d+"/.test(m[0]))).toBe(true);
  });
});
