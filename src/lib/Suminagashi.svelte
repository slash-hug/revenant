<script lang="ts">
  /**
   * Suminagashi.svelte — one-shot ink-marbling "bloom" overlay (墨流し).
   *
   * On mount it paints a full-screen ink marble in the current theme's colors,
   * then fades the canvas away to reveal the workspace beneath — "the document
   * returns out of the ink." Decorative + non-blocking (pointer-events: none),
   * reduced-motion-safe, and backed by a hard timeout so it can NEVER leave the
   * overlay up (e.g. if rAF is throttled in a background/headless renderer).
   *
   * The engine (fx/suminagashi.ts) is generic, so ambient / pointer-ripple modes
   * can be layered on later without touching it.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Marble, bloomPlan } from './fx/suminagashi';

  /** Preview mode: render the full marble and hold it (no fade, no `done`). */
  export let hold = false;

  const dispatch = createEventDispatcher<{ done: void }>();
  let canvas: HTMLCanvasElement;
  let raf = 0;
  let backstop: ReturnType<typeof setTimeout> | null = null;

  const reduce =
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
  }

  function finish() {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
    raf = 0;
    backstop = null;
    dispatch('done');
  }

  onMount(() => {
    if (reduce && !hold) { finish(); return; }
    runBloom();
    if (!hold) backstop = setTimeout(finish, 1400); // safety: never stay up
  });

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    if (backstop) clearTimeout(backstop);
  });

  function runBloom() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) { finish(); return; }
    ctx.scale(dpr, dpr);

    const paper = cssVar('--bg');
    const plan = bloomPlan(w, h, {
      ink: cssVar('--text'),
      paper,
      accent: cssVar('--accent'),
      muted: cssVar('--text-muted'),
    });

    const marble = new Marble();
    const STEP = 16; // ms between drops
    const addEnd = plan.drops.length * STEP + 40;
    const FADE = 340;

    const start = performance.now();
    let idx = 0;
    const frame = (now: number) => {
      const t = now - start;
      while (idx < plan.drops.length && t >= idx * STEP) {
        const s = plan.drops[idx++];
        marble.addDrop(s.x, s.y, s.r, s.color);
        for (const tn of plan.tines) {
          if (tn.afterIndex === idx) marble.tine(tn.x1, tn.y1, tn.x2, tn.y2, tn.shift);
        }
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, w, h);
      marble.render(ctx);

      if (hold) { raf = requestAnimationFrame(frame); return; }

      const alpha = t <= addEnd ? 1 : Math.max(0, 1 - (t - addEnd) / FADE);
      canvas.style.opacity = String(alpha);
      if (t > addEnd + FADE) { finish(); return; }
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
