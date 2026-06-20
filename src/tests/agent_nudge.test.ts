import { describe, it, expect } from 'vitest';
import { buildNudge, DEFAULT_NUDGE_TEMPLATE } from '../lib/agentNudge';

const paths = {
  reviewAbs: '/home/u/repo/docs/spec.md.review.md',
  reviewRel: 'docs/spec.md.review.md',
  docAbs: '/home/u/repo/docs/spec.md',
  docRel: 'docs/spec.md',
};

describe('buildNudge', () => {
  it('substitutes both placeholders with relative paths', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'relative', paths);
    expect(out).toContain('docs/spec.md.review.md');
    expect(out).toContain('docs/spec.md');
    expect(out).not.toContain('/home/u/repo');
  });

  it('uses absolute paths when style is absolute', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'absolute', paths);
    expect(out).toContain('/home/u/repo/docs/spec.md.review.md');
  });

  it('falls back to absolute when the relative form is null', () => {
    const out = buildNudge(DEFAULT_NUDGE_TEMPLATE, 'relative', {
      ...paths,
      reviewRel: null,
      docRel: null,
    });
    expect(out).toContain('/home/u/repo/docs/spec.md');
  });

  it('replaces every occurrence of a placeholder', () => {
    const out = buildNudge('{doc_path} and again {doc_path}', 'relative', paths);
    expect(out).toBe('docs/spec.md and again docs/spec.md');
  });

  it('default template names no AI assistant (agent-agnostic)', () => {
    expect(DEFAULT_NUDGE_TEMPLATE.toLowerCase()).not.toMatch(/claude|copilot|gpt|gemini/);
  });
});
