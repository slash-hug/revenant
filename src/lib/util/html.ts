/**
 * html.ts — tiny HTML utilities shared across the frontend.
 */

/**
 * Escape the five HTML-significant characters so a string can be safely
 * interpolated into HTML text or attribute contexts.
 *
 * Order matters: `&` is escaped first so the entities introduced by the other
 * replacements are not double-escaped.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
