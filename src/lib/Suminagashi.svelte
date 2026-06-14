<script lang="ts">
  /**
   * Suminagashi.svelte — GPU ink-in-water "dissolution" overlay (墨流し).
   *
   * On mount it seeds a handful of ink drops with velocity into a WebGL2 fluid
   * simulation (advection + curl + pressure), lets the ink flow and swirl for a
   * beat, then fades the canvas to reveal the workspace — "the document returns
   * out of the ink." Decorative + non-blocking (pointer-events: none),
   * reduced-motion-safe, with a hard backstop so it can never stay up.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { FluidSim } from './fx/fluid';

  /** Preview mode: keep simulating, no fade / no `done`. */
  export let hold = false;

  const dispatch = createEventDispatcher<{ done: void }>();
  let canvas: HTMLCanvasElement;
  let raf = 0;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  let sim: FluidSim | null = null;

  const reduce =
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  type RGB = [number, number, number];
  function cssColor(name: string): RGB {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const h = v.replace('#', '');
    if (h.length >= 6) {
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
    }
    const m = v.match(/(\d+\.?\d*)/g);
    return m ? [(+m[0]) / 255, (+m[1]) / 255, (+m[2]) / 255] : [0, 0, 0];
  }
  const sub = (a: RGB, b: RGB, k = 0.78): RGB => [(a[0] - b[0]) * k, (a[1] - b[1]) * k, (a[2] - b[2]) * k];

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
    raf = 0; backstop = null;
    sim?.dispose(); sim = null;
    dispatch('done');
  }

  onMount(() => {
    if (reduce && !hold) { finish(); return; }
    run();
    if (!hold) backstop = setTimeout(finish, 2600);
  });
  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
    sim?.dispose();
  });

  function run() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    try {
      sim = new FluidSim(canvas, { simRes: 160, dyeRes: 640, curl: 30, pressureIters: 20 });
    } catch {
      finish(); // no WebGL2 → skip the effect gracefully
      return;
    }

    const bg = cssColor('--bg');
    const inks: RGB[] = [
      sub(cssColor('--text'), bg),
      sub(cssColor('--accent'), bg),
      sub(cssColor('--detached'), bg),
      sub(cssColor('--success'), bg),
      sub(cssColor('--text'), bg),
      sub(cssColor('--accent'), bg),
    ];

    // Seed ink drops across the canvas with outward/swirling velocity.
    const FORCE = 620;
    const cx = 0.5, cy = 0.46;
    inks.forEach((c, i) => {
      const ang = (i / inks.length) * Math.PI * 2 + 0.6;
      const rad = 0.16 + 0.1 * Math.random();
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad * 0.82;
      // velocity: a tangential swirl + a little outward push
      const vx = (-Math.sin(ang) * 0.8 + Math.cos(ang) * 0.5) * FORCE;
      const vy = (Math.cos(ang) * 0.8 + Math.sin(ang) * 0.5) * FORCE;
      sim!.splat(x, y, vx, vy, c, 0.009);
    });
    // a calm central drop to anchor the bloom
    sim!.splat(cx, cy, 0, -FORCE * 0.4, sub(cssColor('--text'), bg), 0.012);

    const SIM_MS = 1100, FADE_MS = 520;
    const start = performance.now();
    const frame = (now: number) => {
      const t = now - start;
      sim!.step(0.016);
      const fade = hold ? 1 : t < SIM_MS ? 1 : Math.max(0, 1 - (t - SIM_MS) / FADE_MS);
      sim!.render(bg, fade);
      if (!hold && t > SIM_MS + FADE_MS) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
</script>

<canvas bind:this={canvas} class="sumi" aria-hidden="true"></canvas>

<style>
  .sumi {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: var(--z-toast);
    pointer-events: none;
  }
</style>
