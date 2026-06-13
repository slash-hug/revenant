/**
 * path.ts — tiny cross-platform path helpers for the frontend.
 *
 * Paths returned by the Rust core are canonical for the host OS, so they use
 * `/` on macOS/Linux and `\` on Windows. Display logic must handle both
 * separators or Windows users see the full path where a filename is expected
 * (Windows is a co-equal v1 target — spec §8).
 */

/**
 * Return the final path segment (filename) of a path, handling both `/` and
 * `\` separators. Falls back to the original string if there is no separator.
 */
export function basename(path: string): string {
  if (!path) return path;
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}
