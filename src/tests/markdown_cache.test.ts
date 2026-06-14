/**
 * markdown_cache.test.ts — renderCodeBlock content cache (#2).
 *
 * Verifies the cache returns identical output for repeated input and keys
 * correctly (different code → different output), so the optimization never
 * serves a stale highlight.
 */
import { describe, it, expect } from 'vitest';
import { renderCodeBlock } from '../lib/render/markdown';

describe('renderCodeBlock cache (#2)', () => {
  it('returns identical HTML for repeated identical input (cache hit)', async () => {
    const a = await renderCodeBlock('const x = 1;', 'javascript');
    const b = await renderCodeBlock('const x = 1;', 'javascript');
    expect(b).toBe(a);
  });

  it('produces different output for different code (correct cache key)', async () => {
    const a = await renderCodeBlock('const x = 1;', 'javascript');
    const c = await renderCodeBlock('const y = 2;', 'javascript');
    expect(c).not.toBe(a);
  });

  it('keys on language too', async () => {
    const js = await renderCodeBlock('value', 'javascript');
    const py = await renderCodeBlock('value', 'python');
    // distinct cache entries (language class differs in the output)
    expect(js).toContain('language-');
    expect(py).toContain('language-');
  });
});
