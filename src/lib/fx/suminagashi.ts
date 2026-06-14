/**
 * suminagashi.ts — incompressible-displacement ink marbling (墨流し).
 *
 * The classic "mathematical marbling" technique: each ink drop is a closed
 * ring of points; adding a new drop displaces every existing point radially
 * outward (area-preserving, like ink on water), producing nested marble bands.
 *
 * Pure + dependency-free + canvas-2D. The engine only models geometry; the
 * animation/rendering cadence lives in the component, so the same engine can
 * back a one-shot bloom now and an ambient loop or pointer ripples later.
 */

export interface Point { x: number; y: number; }
export interface Drop { pts: Point[]; color: string; }

export class Marble {
  drops: Drop[] = [];

  /**
   * Drop ink of radius `r` at (cx, cy). Existing ink is pushed outward by the
   * incompressible-fluid map  z' = c + (z - c) · sqrt(1 + r²/|z - c|²).
   */
  addDrop(cx: number, cy: number, r: number, color: string, segments = 120): void {
    const r2 = r * r;
    for (const d of this.drops) {
      for (const p of d.pts) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const m2 = Math.max(dx * dx + dy * dy, 1); // floor avoids blow-up at the center
        const f = Math.sqrt(1 + r2 / m2);
        p.x = cx + dx * f;
        p.y = cy + dy * f;
      }
    }

    const pts: Point[] = new Array(segments);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts[i] = { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
    }
    this.drops.push({ pts, color });
  }

  /**
   * Draw a "tine" comb: shift every point along the (perpendicular) direction
   * of the line through (x1,y1)-(x2,y2), with a 1/d falloff. Optional combing
   * pass for richer marble; unused by the bloom but kept for later modes.
   */
  tine(x1: number, y1: number, x2: number, y2: number, shift: number, sharp = 12): void {
    const ux = x2 - x1;
    const uy = y2 - y1;
    const len = Math.hypot(ux, uy) || 1;
    const nx = ux / len;
    const ny = uy / len;
    for (const d of this.drops) {
      for (const p of d.pts) {
        const dist = (p.x - x1) * -ny + (p.y - y1) * nx; // signed distance to line
        const f = shift * (sharp / (Math.abs(dist) + sharp));
        p.x += nx * f;
        p.y += ny * f;
      }
    }
  }

  /** Fill every drop as a closed path, oldest first (newer ink sits on top). */
  render(ctx: CanvasRenderingContext2D): void {
    for (const d of this.drops) {
      const pts = d.pts;
      if (pts.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.fillStyle = d.color;
      ctx.fill();
    }
  }

  clear(): void {
    this.drops = [];
  }
}

export interface BloomColors { ink: string; paper: string; accent: string; muted: string; }
export interface BloomStep { x: number; y: number; r: number; color: string; }
export interface BloomTine { afterIndex: number; x1: number; y1: number; x2: number; y2: number; shift: number; }
export interface BloomPlan { drops: BloomStep[]; tines: BloomTine[]; }

/**
 * The drop schedule for the open-transition bloom. Many fine, alternating
 * ink/paper rings drifting off a center, with one rake (tine) for the feathered
 * suminagashi flow — delicate concentric marbling rather than bold bands.
 * Shared by the component and the visual verification harness so they stay in
 * sync. Deterministic (no randomness): the transition feels the same each time.
 */
export function bloomPlan(w: number, h: number, c: BloomColors): BloomPlan {
  const cx = w / 2;
  const cy = h * 0.46;
  const base = Math.min(w, h);
  const N = 30;
  const r = base * 0.085;

  const drops: BloomStep[] = [];
  for (let i = 0; i < N; i++) {
    const color = i % 9 === 8 ? c.accent : i % 2 === 0 ? c.ink : c.paper;
    drops.push({
      x: cx + (i - N / 2) * base * 0.004,
      y: cy + Math.sin(i * 0.55) * base * 0.01,
      r,
      color,
    });
  }

  const tines: BloomTine[] = [
    { afterIndex: Math.floor(N * 0.62), x1: cx - base * 0.5, y1: cy - base * 0.04, x2: cx + base * 0.5, y2: cy + base * 0.06, shift: base * 0.05 },
    { afterIndex: Math.floor(N * 0.86), x1: cx, y1: cy - base * 0.5, x2: cx + base * 0.04, y2: cy + base * 0.5, shift: base * 0.035 },
  ];

  return { drops, tines };
}
