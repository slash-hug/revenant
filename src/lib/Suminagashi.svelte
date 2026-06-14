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
  import { toCanvas } from 'html-to-image';

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
  function cssRaw(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
    raf = 0; backstop = null;
    sim?.dispose(); sim = null;
    dispatch('done');
  }

  onMount(() => {
    if (reduce && !hold) { finish(); return; }
    void run();
    if (!hold) backstop = setTimeout(finish, 3200); // generous: snapshot latency + transition
  });
  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
    sim?.dispose();
  });

  async function run() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    const densityDissipation = 0.5 + Math.random() * 0.4;
    const velocityDissipation = 0.9 + Math.random() * 0.25;
    try {
      sim = new FluidSim(canvas, {
        simRes: 160, dyeRes: 640, curl: 44, pressureIters: 20,
        densityDissipation, velocityDissipation,
      });
    } catch {
      finish(); // no WebGL2 → skip the effect gracefully
      return;
    }

    // Cover the document immediately (opaque bg) so the live sharp doc never
    // flashes during the async snapshot below.
    sim.fillBackground(cssColor('--bg'));

    // Snapshot the freshly-opened workspace — the transition reveals THIS, sharp,
    // along the ink's path. The fluid canvas is a sibling, so it isn't captured.
    const wsEl = document.querySelector('.ws') as HTMLElement | null;
    let docCanvas: HTMLCanvasElement | null = null;
    if (wsEl) {
      try {
        // Ensure the web fonts are loaded so the snapshot embeds them (otherwise
        // it falls back to system fonts and the cross-fade "snaps" the type).
        if (document.fonts?.ready) await document.fonts.ready;
        docCanvas = await toCanvas(wsEl, { pixelRatio: dpr, backgroundColor: cssRaw('--bg') || undefined, cacheBust: false });
      } catch { docCanvas = null; }
    }
    if (!sim) return; // disposed/finished while awaiting the snapshot
    if (!docCanvas) { finish(); return; }
    sim.setDocument(docCanvas, canvas.width, canvas.height);

    const inks: RGB[] = [
      cssColor('--text'), cssColor('--accent'), cssColor('--detached'),
      cssColor('--success'), cssColor('--text'), cssColor('--accent'),
    ];

    // Seed ink drops spread around the center, each flung in its own randomized
    // direction so the brushstrokes feather out non-uniformly.
    const FORCE = 740;
    const cx = 0.5, cy = 0.46;
    inks.forEach((c) => {
      const pAng = Math.random() * Math.PI * 2;
      const rad = 0.15 + 0.11 * Math.random();
      const x = cx + Math.cos(pAng) * rad;
      const y = cy + Math.sin(pAng) * rad * 0.85;
      const vAng = Math.random() * Math.PI * 2;
      const vMag = FORCE * (0.55 + 0.75 * Math.random());
      sim!.splat(x, y, Math.cos(vAng) * vMag, Math.sin(vAng) * vMag, c, 0.0065);
    });
    const aAng = Math.random() * Math.PI * 2;
    sim!.splat(cx, cy, Math.cos(aAng) * FORCE * 0.5, Math.sin(aAng) * FORCE * 0.5, cssColor('--text'), 0.009);

    const SIM_MS = 760, FADE_MS = 560; // soft reveal, then a long dissolve to the crisp live DOM
    const start = performance.now();
    const frame = (now: number) => {
      if (!sim) return;
      const t = now - start;
      sim.step(0.016);
      // strokes draw focus first; a global ramp brings any unreached areas in by the end.
      const globalFocus = hold ? 0 : Math.max(0, Math.min(1, (t - SIM_MS * 0.58) / (SIM_MS * 0.42)));
      const fade = hold ? 1 : t < SIM_MS ? 1 : Math.max(0, 1 - (t - SIM_MS) / FADE_MS);
      sim.render(fade, globalFocus, 0.8);
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
