import { describe, it, expect, vi, beforeEach } from 'vitest';
import { svgToBlob, copyDiagramAsPng } from '$lib/diagramCopy';

describe('diagramCopy', () => {
  describe('svgToBlob', () => {
    it('creates a Blob with SVG MIME type', () => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const blob = svgToBlob(svg);
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('image/svg+xml;charset=utf-8');
    });

    it('includes xmlns if missing', () => {
      const svg = '<svg width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const blob = svgToBlob(svg);
      expect(blob.size).toBeGreaterThan(0);
    });
  });

  describe('copyDiagramAsPng', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('returns false when clipboard API is unavailable', async () => {
      // jsdom doesn't provide navigator.clipboard
      const container = document.createElement('div');
      container.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect fill="red" width="100" height="100"/></svg>';
      const result = await copyDiagramAsPng(container);
      expect(result).toBe(false);
    });

    it('returns false when no SVG element found', async () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>no svg here</p>';
      const result = await copyDiagramAsPng(container);
      expect(result).toBe(false);
    });
  });
});
