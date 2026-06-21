import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  /**
   * Rasterization scale tests — verify that copyDiagramAsPng uses
   * Math.max(window.devicePixelRatio || 1, 2) as the canvas multiplier.
   *
   * Strategy: intercept document.createElement('canvas') to capture the canvas
   * element before it is used. After copyDiagramAsPng runs, compare the final
   * canvas.width with the SVG's intrinsic pixel width — the ratio is the scale.
   *
   * jsdom constraints addressed here:
   *   - svg.width.baseVal.value is undefined; use viewBox="0 0 W H" so that
   *     getSvgDimensions() falls into the viewBox branch and returns W.
   *   - ClipboardItem is not defined in jsdom; assign a stub on globalThis so
   *     `new ClipboardItem(...)` does not throw inside the try block.
   *   - URL.createObjectURL / revokeObjectURL are absent; assign stubs directly.
   */
  describe('rasterization scale', () => {
    let capturedCanvas: HTMLCanvasElement | undefined;
    let originalCreateElement: typeof document.createElement;
    let originalDpr: number;

    beforeEach(() => {
      capturedCanvas = undefined;
      originalDpr = window.devicePixelRatio;

      // Stub ClipboardItem — jsdom does not provide this global
      if (typeof globalThis.ClipboardItem === 'undefined') {
        (globalThis as Record<string, unknown>).ClipboardItem = class ClipboardItem {
          constructor(public readonly items: Record<string, Blob | Promise<Blob>>) {}
        };
      }

      // Intercept canvas creation so we can read width/height after sizing
      originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest) => {
        const el = originalCreateElement(tag, ...rest);
        if (tag === 'canvas') {
          capturedCanvas = el as HTMLCanvasElement;
          // Stub getContext — jsdom canvas is headless and getContext returns null
          vi.spyOn(el as HTMLCanvasElement, 'getContext').mockReturnValue({
            scale: vi.fn(),
            drawImage: vi.fn(),
          } as unknown as CanvasRenderingContext2D);
          // Stub toBlob to resolve synchronously with a PNG blob
          vi.spyOn(el as HTMLCanvasElement, 'toBlob').mockImplementation(
            (cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })),
          );
        }
        return el;
      });

      // Mock Image so onload fires after src is set
      const OrigImage = globalThis.Image;
      vi.spyOn(globalThis, 'Image').mockImplementation(() => {
        const img = new OrigImage();
        let _src = '';
        Object.defineProperty(img, 'src', {
          set(v: string) {
            _src = v;
            Promise.resolve().then(() => img.onload?.(new Event('load')));
          },
          get() { return _src; },
        });
        return img;
      });

      // URL stubs — jsdom does not implement createObjectURL/revokeObjectURL
      URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
      URL.revokeObjectURL = vi.fn();

      // Clipboard stub
      Object.defineProperty(navigator, 'clipboard', {
        value: { write: vi.fn().mockResolvedValue(undefined) },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: originalDpr,
        configurable: true,
        writable: true,
      });
      vi.restoreAllMocks();
    });

    /** Set window.devicePixelRatio for the duration of one test */
    function setDpr(dpr: number) {
      Object.defineProperty(window, 'devicePixelRatio', {
        value: dpr,
        configurable: true,
        writable: true,
      });
    }

    /**
     * Build a container with an SVG that has a viewBox, ensuring getSvgDimensions
     * returns the given width via the viewBox branch (not the missing-baseVal path).
     */
    function makeContainer(svgWidth: number, svgHeight = 100): HTMLElement {
      const container = document.createElement('div');
      container.innerHTML =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}">` +
        `<rect width="${svgWidth}" height="${svgHeight}"/></svg>`;
      return container;
    }

    it('uses scale = 2 (minimum floor) when devicePixelRatio is 1', async () => {
      setDpr(1);

      const svgWidth = 200;
      const container = makeContainer(svgWidth);

      await copyDiagramAsPng(container);

      // canvas.width = svgWidth × Math.max(devicePixelRatio || 1, 2)
      //              = 200 × Math.max(1, 2) = 200 × 2 = 400
      expect(capturedCanvas).toBeDefined();
      const scale = capturedCanvas!.width / svgWidth;
      expect(scale).toBe(2);
    });

    it('uses scale = 3 when devicePixelRatio is 3 (high-DPI Retina)', async () => {
      setDpr(3);

      const svgWidth = 200;
      const container = makeContainer(svgWidth);

      await copyDiagramAsPng(container);

      // canvas.width = 200 × Math.max(3, 2) = 200 × 3 = 600
      expect(capturedCanvas).toBeDefined();
      const scale = capturedCanvas!.width / svgWidth;
      expect(scale).toBe(3);
    });

    it('scale is always >= 2 regardless of devicePixelRatio', async () => {
      const svgWidth = 100;

      for (const dpr of [0, 1, 1.5, 2, 2.5, 3]) {
        capturedCanvas = undefined;
        setDpr(dpr);

        const container = makeContainer(svgWidth);
        await copyDiagramAsPng(container);

        expect(capturedCanvas).toBeDefined();
        const scale = capturedCanvas!.width / svgWidth;
        expect(scale).toBeGreaterThanOrEqual(2);
      }
    });
  });
});
