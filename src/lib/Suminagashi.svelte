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
      sim = new FluidSim(canvas, { simRes: 160, dyeRes: 640, curl: 44, pressureIters: 20 });
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

    // Seed a tight cluster of ink drops near the center, each flung in its own
    // randomized direction so the brushstrokes feather out non-uniformly.
    const FORCE = 740;
    const cx = 0.5, cy = 0.46;
    inks.forEach((c) => {
      const pAng = Math.random() * Math.PI * 2;
      const rad = 0.05 + 0.09 * Math.random(); // tight: 0.05–0.14 from center
      const x = cx + Math.cos(pAng) * rad;
      const y = cy + Math.sin(pAng) * rad * 0.85;
      // each stroke flies a different direction + magnitude → no uniform swirl
      const vAng = Math.random() * Math.PI * 2;
      const vMag = FORCE * (0.55 + 0.75 * Math.random());
      sim!.splat(x, y, Math.cos(vAng) * vMag, Math.sin(vAng) * vMag, c, 0.0055);
    });
    // a couple of denser ink drops right at the heart of the bloom
    for (let k = 0; k < 2; k++) {
      const vAng = Math.random() * Math.PI * 2;
      sim!.splat(
        cx + (Math.random() - 0.5) * 0.05,
        cy + (Math.random() - 0.5) * 0.05,
        Math.cos(vAng) * FORCE * 0.6,
        Math.sin(vAng) * FORCE * 0.6,
        sub(cssColor('--text'), bg),
        0.007,
      );
    }

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
