/**
 * scrollSync.ts — pure helper for the preview scroll-sync index (#3).
 */

/**
 * Binary-search an ascending-sorted `lines` array for the index of the value
 * nearest `target`. On a tie the earlier (smaller-index) line wins, matching the
 * previous linear-scan behaviour. Returns -1 for an empty array.
 */
export function nearestLineIndex(lines: number[], target: number): number {
  if (lines.length === 0) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index with lines[lo] >= target; compare it with its left
  // neighbour and keep the closer (<= → earlier block on a tie).
  let best = lo;
  if (lo > 0 && Math.abs(lines[lo - 1] - target) <= Math.abs(lines[best] - target)) {
    best = lo - 1;
  }
  return best;
}
