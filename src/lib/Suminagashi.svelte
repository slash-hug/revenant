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
  import { snapshotWebview } from './types/ipc';

  // macOS uses the native WKWebView snapshot (real renderer → fonts match the
  // live DOM exactly). WebKit can't render @font-face inside html-to-image's
  // SVG-foreignObject rasteriser, so on macOS that path drops the editor font and
  // the transition "snaps" on hand-off. Chromium / WebView2 (Windows) render it
  // correctly, so html-to-image stays the fallback there.
  const isMac =
    typeof navigator !== 'undefined' &&
    (/Mac/i.test(navigator.platform || '') || /Mac OS X/i.test(navigator.userAgent || ''));

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

  /** Resolve after `n` animation frames (lets the DOM lay out and paint). */
  function nextPaint(n = 1): Promise<void> {
    return new Promise((resolve) => {
      const tick = (left: number) =>
        left <= 0 ? resolve() : requestAnimationFrame(() => tick(left - 1));
      tick(n);
    });
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
    // Render at the native device-pixel-ratio so the snapshot shown on the canvas
    // is exactly as crisp as the live DOM underneath — otherwise the hard cut
    // "pops" as the page sharpens by the cap's worth of resolution. The per-frame
    // fluid sim runs at its own fixed internal resolution (simRes/dyeRes), so this
    // only enlarges the final display blit. Capped at 2 to bound cost on 3x panels.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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

    // Capture a faithful bitmap of the freshly-opened workspace — the transition
    // reveals THIS, sharp, along the ink's path.
    //
    // Ordering differs by capture method:
    //  - Native (macOS): the snapshot reads the on-screen pixels, so the fluid
    //    canvas must stay transparent (it's a sibling on top of .ws) until AFTER
    //    the capture — only then do we fillBackground() to cover. There's an
    //    unavoidable brief moment of the sharp doc while WKWebView renders the
    //    snapshot.
    //  - html-to-image (Chromium/WebView2): reads the DOM directly, so occlusion
    //    is irrelevant — cover FIRST to avoid any flash, then capture.
    const wsEl = document.querySelector('.ws') as HTMLElement | null;
    let docSource: TexImageSource | null = null;

    // Let the just-opened workspace fully lay out + paint before capturing it.
    // This matters for a clean hand-off: the snapshot must match the FINAL live
    // layout, or the end cut visibly settles (the preview's prose reflows as
    // Literata applies, drifting the lower lines).
    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* ignore */ } }
    await nextPaint(4);
    if (!sim) return; // disposed/finished while awaiting

    const htmlToImageCapture = async (): Promise<TexImageSource | null> => {
      if (!wsEl) return null;
      try {
        return await toCanvas(wsEl, { pixelRatio: dpr, backgroundColor: cssRaw('--bg') || undefined, cacheBust: false });
      } catch { return null; }
    };

    if (isMac) {
      try {
        const dataUrl = await snapshotWebview();
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        docSource = img;
      } catch { docSource = null; }
      if (!sim) return;
      sim.fillBackground(cssColor('--bg')); // cover now that the capture is done
      if (!docSource) docSource = await htmlToImageCapture(); // native unavailable → fall back
    } else {
      sim.fillBackground(cssColor('--bg')); // cover first — no flash on Chromium/WebView2
      docSource = await htmlToImageCapture();
    }

    if (!sim) return; // disposed/finished while awaiting the snapshot
    if (!docSource) { finish(); return; }
    sim.setDocument(docSource, canvas.width, canvas.height);

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

    // The snapshot is a faithful capture of the live render, so we DON'T cross-fade
    // the canvas out over the live DOM — that overlaps two layers and ghosts
    // wherever they aren't pixel-aligned. Instead the canvas stays fully opaque
    // through the whole reveal, then we hard-cut to the live DOM (unmount). Because
    // the pixels match, the cut is seamless.
    const SIM_MS = 820;  // ink blooms + draws the page into focus
    const HOLD_MS = 90;  // hold the fully-focused page a beat, then cut
    const start = performance.now();
    const frame = (now: number) => {
      if (!sim) return;
      const t = now - start;
      sim.step(0.016);
      // Strokes draw focus first; a global ramp brings any unreached areas in by SIM_MS.
      const globalFocus = hold ? 0 : Math.max(0, Math.min(1, (t - SIM_MS * 0.5) / (SIM_MS * 0.5)));
      // Ink blooms, then trails off so the page is clean by the time it's focused.
      const ink = hold ? 0.85 : 0.85 * (1 - Math.max(0, Math.min(1, (t - SIM_MS * 0.45) / (SIM_MS * 0.5))));
      sim.render(1, globalFocus, ink); // fade=1: canvas opaque until the hard cut
      if (!hold && t > SIM_MS + HOLD_MS) { finish(); return; }
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
