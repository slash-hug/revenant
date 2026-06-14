/**
 * annotation_cycle.test.ts — keyboard cycle target selection (#16).
 */
import { describe, it, expect } from 'vitest';
import { cycleAnnotationId } from '../lib/annotationActions';
import type { Annotation } from '../lib/types/ipc';

function ann(id: string, line: number, char = 0, status: Annotation['status'] = 'anchored'): Annotation {
  return {
    id, body: id, quoted_text: id,
    line_start: line, line_end: line, char_start: char, char_end: char + 1,
    status, created_at: '', updated_at: '',
  };
}

// Intentionally out of document order to prove sorting.
const list = [ann('b', 10), ann('a', 2), ann('c', 10, 5), ann('d', 40)];

describe('cycleAnnotationId', () => {
  it('returns null when there are no eligible annotations', () => {
    expect(cycleAnnotationId([], null, 1)).toBeNull();
    expect(cycleAnnotationId([ann('x', 1, 0, 'detached')], null, 1)).toBeNull();
  });

  it('with no active: next → first, prev → last (document order)', () => {
    expect(cycleAnnotationId(list, null, 1)).toBe('a');   // line 2
    expect(cycleAnnotationId(list, null, -1)).toBe('d');  // line 40
  });

  it('advances in document order, sorted by line then char', () => {
    expect(cycleAnnotationId(list, 'a', 1)).toBe('b');  // 2 → 10
    expect(cycleAnnotationId(list, 'b', 1)).toBe('c');  // 10 → 10 (char 5)
    expect(cycleAnnotationId(list, 'c', 1)).toBe('d');  // → 40
  });

  it('wraps around at both ends', () => {
    expect(cycleAnnotationId(list, 'd', 1)).toBe('a');  // last → first
    expect(cycleAnnotationId(list, 'a', -1)).toBe('d'); // first → last
  });

  it('excludes detached annotations from the cycle', () => {
    const withDetached = [...list, ann('z', 1, 0, 'detached')];
    expect(cycleAnnotationId(withDetached, null, 1)).toBe('a'); // not 'z'
  });
});
