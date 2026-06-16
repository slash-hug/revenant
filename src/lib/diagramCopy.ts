/**
 * diagramCopy.ts — SVG→PNG clipboard pipeline for Mermaid diagram containers.
 *
 * Converts an SVG element to a PNG blob via an offscreen canvas, then writes
 * it to the clipboard. Uses 2× resolution for retina sharpness.
 *
 * foreignObject fallback: Mermaid SVGs may use <foreignObject> with HTML labels.
 * The canvas drawImage approach can fail with cross-origin taint errors for such
 * SVGs. In that case, copyDiagramAsPng returns false and the caller can show a
 * notification. A dom-to-image fallback can be added later if needed.
 */

/** Serialize an SVG string into a Blob suitable for loading into an Image. */
export function svgToBlob(svgMarkup: string): Blob {
  let markup = svgMarkup;
  if (!markup.includes('xmlns=')) {
    markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
}

/**
 * Extract the intrinsic size of an SVG from its width/height or viewBox.
 * Returns [width, height] in pixels. Falls back to bounding rect if attributes
 * are missing.
 */
function getSvgDimensions(svg: SVGSVGElement): [number, number] {
  const w = svg.width?.baseVal?.value;
  const h = svg.height?.baseVal?.value;
  if (w && h && w > 0 && h > 0) return [w, h];

  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return [parts[2], parts[3]];
    }
  }

  const rect = svg.getBoundingClientRect();
  return [rect.width || 400, rect.height || 300];
}

/**
 * Copy the first SVG found inside `container` as a PNG to the clipboard.
 *
 * Returns true on success, false on failure (no SVG, no clipboard API,
 * canvas tainted by foreignObject, etc.).
 */
export async function copyDiagramAsPng(container: HTMLElement): Promise<boolean> {
  const svg = container.querySelector('svg');
  if (!svg) return false;

  if (!navigator.clipboard?.write) return false;

  try {
    const [w, h] = getSvgDimensions(svg);
    const scale = 2; // retina

    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));

    const blob = svgToBlob(clone.outerHTML);
    const url = URL.createObjectURL(blob);

    try {
      const img = new Image();
      img.width = w;
      img.height = h;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;

      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);

      const pngBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );
      if (!pngBlob) return false;

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ]);
      return true;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return false;
  }
}
