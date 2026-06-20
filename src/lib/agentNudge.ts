/**
 * agentNudge.ts — builds the one-line clipboard "nudge" copied on "Send to
 * agent". The user pastes it into a running CLI agent session; the agent reads
 * the referenced <doc>.md.review.md and applies the comments.
 *
 * Agent-agnostic (TRAP 2): no assistant name appears here or in the default
 * template. Approach B (autonomous MCP pull) is tracked in issue #97.
 */

export type NudgePathStyle = 'relative' | 'absolute';

export interface NudgePaths {
  reviewAbs: string;
  reviewRel: string | null;
  docAbs: string;
  docRel: string | null;
}

/**
 * Default nudge template. MUST stay byte-identical to
 * `default_agent_nudge_template` in src-tauri/src/settings.rs.
 */
export const DEFAULT_NUDGE_TEMPLATE =
  'Apply the review comments in `{review_path}` to `{doc_path}`, then summarize what you changed.';

/**
 * Fill `{review_path}` / `{doc_path}` in `template`, choosing the path form per
 * `style`. Falls back to the absolute path when the relative form is null
 * (document not inside a git repo).
 */
export function buildNudge(
  template: string,
  style: NudgePathStyle,
  paths: NudgePaths,
): string {
  const review = style === 'relative' ? paths.reviewRel ?? paths.reviewAbs : paths.reviewAbs;
  const doc = style === 'relative' ? paths.docRel ?? paths.docAbs : paths.docAbs;
  return template.replaceAll('{review_path}', review).replaceAll('{doc_path}', doc);
}
