/**
 * commandFilter.ts — fuzzy subsequence matcher for the ⌘K command palette (#9).
 *
 * Pure, framework-free, and unit-tested so the palette component stays a thin
 * view over it. `fuzzyMatch` scores a query against a single string and returns
 * the matched character indices (for highlighting); `filterCommands` ranks a
 * whole command list, matching the title first (highlightable) and falling back
 * to hidden keyword/section text so e.g. "obsidian" still finds "Export…".
 */

export interface Command {
  /** Stable identity for keyed rendering. */
  id: string;
  /** User-facing label shown in the palette and matched for highlighting. */
  title: string;
  /** Group heading shown when the query is empty (e.g. "View", "Comments"). */
  section: string;
  /** Optional shortcut hint rendered on the right (e.g. "⌘2"). */
  hint?: string;
  /** Extra searchable text that is matched but never highlighted. */
  keywords?: string;
  /** Invoked when the command is chosen. */
  run: () => void;
}

export interface ScoredCommand {
  command: Command;
  score: number;
  /** Indices into `command.title` that matched the query (for <mark>). */
  indices: number[];
}

/**
 * Subsequence-match `query` against `text`. Returns a score (higher is better)
 * and the matched indices, or null if `text` does not contain the query chars
 * in order. Scoring rewards consecutive runs, word-boundary starts, and matches
 * near the front of the string — the heuristics that make Spotlight-style
 * filters feel right.
 */
export function fuzzyMatch(query: string, text: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return { score: 0, indices: [] };
  if (q.length > t.length) return null;

  // Prefer a contiguous substring match — it both scores highest and produces
  // the intuitive highlight ("rev" lights up "review", not scattered letters).
  const sub = t.indexOf(q);
  if (sub !== -1) {
    let score = 12 + q.length * 2;
    const prevChar = sub > 0 ? t[sub - 1] : ' ';
    if (/[^a-z0-9]/.test(prevChar)) score += 6; // word boundary
    if (sub === 0) score += 4;                  // very start
    score += Math.max(0, 8 - (t.length - q.length) * 0.1);
    const indices: number[] = [];
    for (let k = 0; k < q.length; k++) indices.push(sub + k);
    return { score, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2; // index of the previously matched char

  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (let j = from; j < t.length; j++) {
      if (t[j] === q[qi]) { found = j; break; }
    }
    if (found === -1) return null;

    let s = 1;
    if (found === prev + 1) s += 3;                        // consecutive run
    const before = found > 0 ? t[found - 1] : ' ';
    if (/[^a-z0-9]/.test(before)) s += 4;                  // word boundary
    if (found === 0) s += 2;                               // very start

    score += s;
    indices.push(found);
    prev = found;
    from = found + 1;
  }

  // Prefer tighter matches (less slack between query and text length).
  score += Math.max(0, 8 - (t.length - q.length) * 0.1);
  return { score, indices };
}

/**
 * Rank `commands` against `query`. An empty/whitespace query returns every
 * command in its original order (score 0) so the palette can show the full,
 * section-grouped menu. Otherwise commands are matched on title (highlighted)
 * with a keyword/section fallback, then sorted by score (ties broken by
 * original order for stability).
 */
export function filterCommands(commands: Command[], query: string): ScoredCommand[] {
  const q = query.trim();
  if (!q) return commands.map((command) => ({ command, score: 0, indices: [] }));

  const out: Array<ScoredCommand & { order: number }> = [];
  commands.forEach((command, order) => {
    const onTitle = fuzzyMatch(q, command.title);
    if (onTitle) {
      out.push({ command, score: onTitle.score + 6, indices: onTitle.indices, order });
      return;
    }
    const hay = `${command.keywords ?? ''} ${command.section}`.trim();
    const onMeta = fuzzyMatch(q, hay);
    if (onMeta) out.push({ command, score: onMeta.score, indices: [], order });
  });

  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ command, score, indices }) => ({ command, score, indices }));
}
