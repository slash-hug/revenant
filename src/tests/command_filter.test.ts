/**
 * command_filter.test.ts — fuzzy ranking for the ⌘K command palette (#9).
 */
import { describe, it, expect } from 'vitest';
import { fuzzyMatch, filterCommands, type Command } from '../lib/commandFilter';

function cmd(id: string, title: string, section = 'General', keywords?: string): Command {
  return { id, title, section, keywords, run: () => {} };
}

const COMMANDS: Command[] = [
  cmd('open', 'Open file…', 'File', 'document markdown'),
  cmd('view-source', 'View: Source', 'View', 'editor'),
  cmd('view-split', 'View: Split', 'View'),
  cmd('view-preview', 'View: Preview', 'View', 'rendered'),
  cmd('generate-review', 'Generate review', 'Review', 'export comments'),
  cmd('export-obsidian', 'Export to Obsidian', 'Review', 'vault publish'),
];

describe('fuzzyMatch', () => {
  it('matches a contiguous substring and reports its indices', () => {
    const m = fuzzyMatch('rev', 'Generate review');
    expect(m).not.toBeNull();
    expect('Generate review'.slice(m!.indices[0], m!.indices[0] + 3).toLowerCase()).toBe('rev');
  });

  it('matches a non-contiguous subsequence', () => {
    expect(fuzzyMatch('gr', 'Generate review')).not.toBeNull(); // G…r
  });

  it('returns null when the chars are not all present in order', () => {
    expect(fuzzyMatch('xyz', 'Open file')).toBeNull();
    expect(fuzzyMatch('eo', 'Open')).toBeNull(); // 'e' then 'o' — wrong order
  });

  it('an empty query matches anything with no indices', () => {
    expect(fuzzyMatch('', 'Whatever')).toEqual({ score: 0, indices: [] });
  });

  it('scores a word-boundary / prefix match higher than a buried one', () => {
    const prefix = fuzzyMatch('op', 'Open page')!;   // boundary start
    const buried = fuzzyMatch('op', 'stop loop')!;   // mid-word
    expect(prefix.score).toBeGreaterThan(buried.score);
  });
});

describe('filterCommands', () => {
  it('returns every command in original order for an empty query', () => {
    const r = filterCommands(COMMANDS, '   ');
    expect(r.map((x) => x.command.id)).toEqual(COMMANDS.map((c) => c.id));
    expect(r.every((x) => x.indices.length === 0)).toBe(true);
  });

  it('ranks the closest title match first', () => {
    const r = filterCommands(COMMANDS, 'preview');
    expect(r[0].command.id).toBe('view-preview');
  });

  it('falls back to keywords with no title highlight', () => {
    const r = filterCommands(COMMANDS, 'obsidian');
    expect(r[0].command.id).toBe('export-obsidian');

    const byKeyword = filterCommands(COMMANDS, 'publish');
    expect(byKeyword[0].command.id).toBe('export-obsidian');
    expect(byKeyword[0].indices).toEqual([]); // matched keyword, not title
  });

  it('drops commands that do not match at all', () => {
    expect(filterCommands(COMMANDS, 'zzzz')).toEqual([]);
  });

  it('title matches outrank keyword-only matches', () => {
    // "view" is in three titles and zero keywords — all three should come first.
    const r = filterCommands(COMMANDS, 'view');
    expect(r.slice(0, 3).every((x) => x.command.title.startsWith('View'))).toBe(true);
  });
});
