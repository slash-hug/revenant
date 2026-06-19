import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock the heavy mermaid package: we only need to observe how the module's
// theme handling drives mermaid.initialize() and mermaid.render().
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"><text>diagram</text></svg>` })),
  },
}));

import { renderMermaid, renderMermaidForExport } from '../lib/render/markdown';
import mermaid from 'mermaid';

const initialize = (mermaid as unknown as { initialize: Mock }).initialize;
const themeOf = (call: unknown[]) => (call[0] as { theme: string }).theme;

function setLiveTheme(mode: 'dark' | 'light') {
  if (mode === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

describe('Mermaid export theme isolation (#35)', () => {
  beforeEach(() => {
    initialize.mockClear();
  });

  it('restores the live (dark) theme after a forced-light export render', async () => {
    setLiveTheme('dark');
    // Establish the live dark theme via a normal preview render.
    await renderMermaid('graph TD; A-->B', 'live-1');
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));

    // Export forces light. The pre-fix bug left the singleton on 'default' (the
    // export theme) afterwards; the fix restores 'dark' before the lock releases.
    await renderMermaidForExport('graph TD; A-->B', 'exp-1', 'default');

    const themes = initialize.mock.calls.map(themeOf);
    expect(themes).toContain('default'); // export forced light for its own render
    expect(themes.at(-1)).toBe('dark'); // ...then restored the live theme
  });

  it('serializes a concurrent live + export render and ends on the live theme', async () => {
    setLiveTheme('dark');
    await renderMermaid('graph TD; A-->B', 'warm'); // warm singleton to dark
    initialize.mockClear();

    // Fire a forced-light export and a dark live render at the same time. With
    // the lock they cannot interleave; without restore the singleton could be
    // left light. Both must resolve and the singleton must end on the live theme.
    const [exportSvg, liveSvg] = await Promise.all([
      renderMermaidForExport('graph TD; A-->B', 'exp-2', 'default'),
      renderMermaid('graph TD; C-->D', 'live-2'),
    ]);

    expect(exportSvg).toContain('<svg');
    expect(liveSvg).toContain('<svg');
    expect(initialize.mock.calls.map(themeOf).at(-1)).toBe('dark');
  });
});
