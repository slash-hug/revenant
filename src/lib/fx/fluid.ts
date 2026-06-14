/**
 * fluid.ts — a compact GPU fluid solver (WebGL2), the Navier-Stokes "stable
 * fluids" method: advection + curl/vorticity confinement + pressure projection
 * on ping-pong float framebuffers. Used to dye ink into water for the
 * suminagashi (墨流し) open transition.
 *
 * Self-contained, dependency-free. Adapted from the well-known GPU fluid
 * technique (Stam 1999 "Stable Fluids" / GPU Gems), trimmed for a one-shot
 * decorative transition rather than an interactive toy.
 */

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  attach(id: number): number;
}
interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap(): void;
}

const BASE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const F_HEADER = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
`;

const SPLAT = F_HEADER + `
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
uniform float amount;     // dye amount deposited into the alpha channel (0 for velocity)
void main () {
  vec2 p = vUv - point.xy;
  p.x *= aspectRatio;
  float gauss = exp(-dot(p, p) / radius);
  vec4 base = texture(uTarget, vUv);
  // RGB accumulates color*amount (premultiplied), A accumulates the amount.
  fragColor = vec4(base.rgb + gauss * color, base.a + gauss * amount);
}`;

const ADVECTION = F_HEADER + `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  vec4 result = texture(uSource, coord);
  float decay = 1.0 + dissipation * dt;
  fragColor = result / decay;
}`;

const DIVERGENCE = F_HEADER + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const CURL = F_HEADER + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}`;

const VORTICITY = F_HEADER + `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity += force * dt;
  velocity = clamp(velocity, -1000.0, 1000.0);
  fragColor = vec4(velocity, 0.0, 1.0);
}`;

const PRESSURE = F_HEADER + `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  fragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`;

const GRADIENT_SUBTRACT = F_HEADER + `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  fragColor = vec4(velocity, 0.0, 1.0);
}`;

const CLEAR = F_HEADER + `
uniform sampler2D uTexture;
uniform float value;
void main () {
  fragColor = value * texture(uTexture, vUv);
}`;

// Separable Gaussian (5-tap, linear-sampled) used to diffuse the dye each frame
// so the ink bleeds and feathers softly instead of keeping hard advection fronts.
const BLUR = F_HEADER + `
uniform sampler2D uTex;
uniform vec2 dir;
void main () {
  vec4 sum = texture(uTex, vUv) * 0.2270270270;
  sum += texture(uTex, vUv + dir * 1.3846153846) * 0.3162162162;
  sum += texture(uTex, vUv - dir * 1.3846153846) * 0.3162162162;
  sum += texture(uTex, vUv + dir * 3.2307692308) * 0.0702702703;
  sum += texture(uTex, vUv - dir * 3.2307692308) * 0.0702702703;
  fragColor = sum;
}`;

// Coverage: a monotonic record of where the ink has ever reached (max-accumulate
// of the dye amount). Drives the focus reveal so the document stays sharp once a
// stroke has passed, even after the ink there dissolves.
const COVER = F_HEADER + `
uniform sampler2D uPrev;
uniform sampler2D uDye;
void main () {
  float prev = texture(uPrev, vUv).r;
  float cur = clamp(texture(uDye, vUv).a, 0.0, 1.0);
  fragColor = vec4(max(prev, cur), 0.0, 0.0, 1.0);
}`;

// Display: render a SNAPSHOT of the document — blurred by default, sharp wherever
// the ink coverage (or the end-of-transition global ramp) has reached — so the
// strokes literally "draw" the page into focus. The live ink is painted on top
// as a translucent wash that trails off, leaving the focused page behind. The
// canvas is opaque (it IS the document) and cross-faded to the live DOM at the end.
const DISPLAY = F_HEADER + `
uniform sampler2D uDoc;
uniform sampler2D uDocBlur;
uniform sampler2D uCoverage;
uniform sampler2D uDye;
uniform float uGlobalFocus;
uniform float uInk;
uniform float uEndSoften;
void main () {
  float cov = texture(uCoverage, vUv).r;
  // The snapshot is a faithful capture of the live render (native WKWebView
  // snapshot on macOS, html-to-image on Chromium/WebView2), so the strokes draw
  // the page all the way into focus.
  float focus = smoothstep(0.04, 0.55, max(cov, uGlobalFocus));
  // At the very end the canvas dissolves to the live DOM underneath. Soften the
  // snapshot as it fades (uEndSoften 0→1) so its edges go blurry: a soft, fading
  // layer can't ghost or "jump" against the live DOM even if the captured texture
  // is off by a sub-pixel, and the live DOM (emerging sharp underneath) keeps the
  // page from ever looking re-blurred.
  focus *= (1.0 - uEndSoften);
  vec3 sharp = texture(uDoc, vUv).rgb;
  vec3 soft = texture(uDocBlur, vUv).rgb;
  vec3 docCol = mix(soft, sharp, focus);
  vec4 d = texture(uDye, vUv);
  float ink = clamp(d.a, 0.0, 1.0) * uInk;
  vec3 inkColor = d.rgb / max(d.a, 0.0015);
  vec3 col = mix(docCol, inkColor, ink);
  fragColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

class Program {
  prog: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation> = {};
  constructor(private gl: WebGL2RenderingContext, vs: WebGLShader, fsSrc: string) {
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, vs);
    gl.attachShader(this.prog, fs);
    gl.linkProgram(this.prog);
    if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(this.prog));
    }
    const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(this.prog, i)!.name;
      this.uniforms[name] = gl.getUniformLocation(this.prog, name)!;
    }
  }
  bind() { this.gl.useProgram(this.prog); }
}

export interface FluidOptions {
  simRes?: number;
  dyeRes?: number;
  curl?: number;
  pressureIters?: number;
  velocityDissipation?: number;
  densityDissipation?: number;
  /** Per-frame dye blur radius (texels) — softens/feathers the ink edges. */
  dyeDiffuse?: number;
}

export class FluidSim {
  private gl: WebGL2RenderingContext;
  private quadVao: WebGLVertexArrayObject;
  private programs: Record<string, Program> = {};
  private velocity!: DoubleFBO;
  private dye!: DoubleFBO;
  private divergence!: FBO;
  private curlFbo!: FBO;
  private pressure!: DoubleFBO;
  private coverage!: DoubleFBO;
  private docTex: WebGLTexture | null = null;
  private docBlur: DoubleFBO | null = null;
  private opts: Required<FluidOptions>;
  private texHalf: number;

  constructor(private canvas: HTMLCanvasElement, options: FluidOptions = {}) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    const linear = gl.getExtension('OES_texture_float_linear');
    this.texHalf = gl.HALF_FLOAT;

    this.opts = {
      simRes: options.simRes ?? 160,
      dyeRes: options.dyeRes ?? 640,
      curl: options.curl ?? 28,
      pressureIters: options.pressureIters ?? 22,
      velocityDissipation: options.velocityDissipation ?? 0.9,
      densityDissipation: options.densityDissipation ?? 0.6,
      dyeDiffuse: options.dyeDiffuse ?? 0.42,
    };

    // full-screen triangle
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quadVao = vao;

    const vs = compile(gl, gl.VERTEX_SHADER, BASE_VERTEX);
    const mk = (src: string) => new Program(gl, vs, src);
    this.programs = {
      splat: mk(SPLAT), advection: mk(ADVECTION), divergence: mk(DIVERGENCE),
      curl: mk(CURL), vorticity: mk(VORTICITY), pressure: mk(PRESSURE),
      gradient: mk(GRADIENT_SUBTRACT), clear: mk(CLEAR), display: mk(DISPLAY),
      blur: mk(BLUR), cover: mk(COVER),
    };

    this.filter = linear ? gl.LINEAR : gl.NEAREST;
    this.initFramebuffers();
  }

  private filter: number;

  private createFBO(w: number, h: number, internal: number, format: number, type: number): FBO {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const self = this;
    return {
      texture, fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id: number) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; },
    };
  }

  private createDouble(w: number, h: number, internal: number, format: number, type: number): DoubleFBO {
    let r = this.createFBO(w, h, internal, format, type);
    let wr = this.createFBO(w, h, internal, format, type);
    return {
      width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
      get read() { return r; }, set read(v) { r = v; },
      get write() { return wr; }, set write(v) { wr = v; },
      swap() { const t = r; r = wr; wr = t; },
    } as DoubleFBO;
  }

  private initFramebuffers() {
    const gl = this.gl;
    const s = this.opts.simRes;
    const d = this.opts.dyeRes;
    const ar = this.canvas.width / this.canvas.height;
    const simW = ar >= 1 ? Math.round(s * ar) : s;
    const simH = ar >= 1 ? s : Math.round(s / ar);
    const dyeW = ar >= 1 ? Math.round(d * ar) : d;
    const dyeH = ar >= 1 ? d : Math.round(d / ar);
    const rgba = gl.RGBA16F, rg = gl.RG16F, r = gl.R16F;
    const t = this.texHalf;
    this.dye = this.createDouble(dyeW, dyeH, rgba, gl.RGBA, t);
    this.velocity = this.createDouble(simW, simH, rg, gl.RG, t);
    this.divergence = this.createFBO(simW, simH, r, gl.RED, t);
    this.curlFbo = this.createFBO(simW, simH, r, gl.RED, t);
    this.pressure = this.createDouble(simW, simH, r, gl.RED, t);
    this.coverage = this.createDouble(dyeW, dyeH, r, gl.RED, t);
  }

  /**
   * Provide the document snapshot the transition reveals: upload it as the sharp
   * texture and build a blurred copy. Call once before stepping.
   */
  setDocument(source: TexImageSource, w: number, h: number, blurRadius = 7) {
    const gl = this.gl;
    if (this.docTex) gl.deleteTexture(this.docTex);
    this.docTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.docTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // match the fluid's bottom-left origin
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.docBlur = this.createDouble(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const B = this.programs.blur;
    B.bind();
    const passes = 7;
    for (let i = 0; i < passes; i++) {
      // first horizontal pass reads the sharp docTex; later passes ping-pong.
      if (i === 0) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.docTex);
        gl.uniform1i(B.uniforms['uTex'], 0);
      } else {
        gl.uniform1i(B.uniforms['uTex'], this.docBlur.read.attach(0));
      }
      gl.uniform2f(B.uniforms['dir'], blurRadius / w, 0);
      this.blit(this.docBlur.write); this.docBlur.swap();
      gl.uniform1i(B.uniforms['uTex'], this.docBlur.read.attach(0));
      gl.uniform2f(B.uniforms['dir'], 0, blurRadius / h);
      this.blit(this.docBlur.write); this.docBlur.swap();
    }
  }

  private blit(target: FBO | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : this.canvas.width, target ? target.height : this.canvas.height);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Inject ink + velocity at normalized (0..1) point with direction (dx,dy). */
  splat(x: number, y: number, dx: number, dy: number, color: [number, number, number], radius = 0.0025) {
    const gl = this.gl;
    const ar = this.canvas.width / this.canvas.height;
    const sp = this.programs.splat;
    sp.bind();
    gl.uniform1i(sp.uniforms['uTarget'], this.velocity.read.attach(0));
    gl.uniform1f(sp.uniforms['aspectRatio'], ar);
    gl.uniform2f(sp.uniforms['point'], x, y);
    gl.uniform3f(sp.uniforms['color'], dx, dy, 0);
    gl.uniform1f(sp.uniforms['radius'], radius);
    gl.uniform1f(sp.uniforms['amount'], 0); // velocity carries no dye amount
    this.blit(this.velocity.write); this.velocity.swap();

    gl.uniform1i(sp.uniforms['uTarget'], this.dye.read.attach(0));
    gl.uniform3f(sp.uniforms['color'], color[0], color[1], color[2]);
    gl.uniform1f(sp.uniforms['amount'], 1); // deposit ink density into alpha
    this.blit(this.dye.write); this.dye.swap();
  }

  step(dt: number) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const vel = this.velocity;
    const P = this.programs;

    P.curl.bind();
    gl.uniform2f(P.curl.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.curl.uniforms['uVelocity'], vel.read.attach(0));
    this.blit(this.curlFbo);

    P.vorticity.bind();
    gl.uniform2f(P.vorticity.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.vorticity.uniforms['uVelocity'], vel.read.attach(0));
    gl.uniform1i(P.vorticity.uniforms['uCurl'], this.curlFbo.attach(1));
    gl.uniform1f(P.vorticity.uniforms['curl'], this.opts.curl);
    gl.uniform1f(P.vorticity.uniforms['dt'], dt);
    this.blit(vel.write); vel.swap();

    P.divergence.bind();
    gl.uniform2f(P.divergence.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.divergence.uniforms['uVelocity'], vel.read.attach(0));
    this.blit(this.divergence);

    P.clear.bind();
    gl.uniform1i(P.clear.uniforms['uTexture'], this.pressure.read.attach(0));
    gl.uniform1f(P.clear.uniforms['value'], 0.8);
    this.blit(this.pressure.write); this.pressure.swap();

    P.pressure.bind();
    gl.uniform2f(P.pressure.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.pressure.uniforms['uDivergence'], this.divergence.attach(0));
    for (let i = 0; i < this.opts.pressureIters; i++) {
      gl.uniform1i(P.pressure.uniforms['uPressure'], this.pressure.read.attach(1));
      this.blit(this.pressure.write); this.pressure.swap();
    }

    P.gradient.bind();
    gl.uniform2f(P.gradient.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.gradient.uniforms['uPressure'], this.pressure.read.attach(0));
    gl.uniform1i(P.gradient.uniforms['uVelocity'], vel.read.attach(1));
    this.blit(vel.write); vel.swap();

    P.advection.bind();
    gl.uniform2f(P.advection.uniforms['texelSize'], vel.texelSizeX, vel.texelSizeY);
    gl.uniform1i(P.advection.uniforms['uVelocity'], vel.read.attach(0));
    gl.uniform1i(P.advection.uniforms['uSource'], vel.read.attach(0));
    gl.uniform1f(P.advection.uniforms['dt'], dt);
    gl.uniform1f(P.advection.uniforms['dissipation'], this.opts.velocityDissipation);
    this.blit(vel.write); vel.swap();

    P.advection.bind();
    gl.uniform1i(P.advection.uniforms['uVelocity'], vel.read.attach(0));
    gl.uniform1i(P.advection.uniforms['uSource'], this.dye.read.attach(1));
    gl.uniform2f(P.advection.uniforms['texelSize'], this.dye.texelSizeX, this.dye.texelSizeY);
    gl.uniform1f(P.advection.uniforms['dissipation'], this.opts.densityDissipation);
    this.blit(this.dye.write); this.dye.swap();

    // Diffuse the dye so the ink bleeds and feathers instead of keeping hard
    // advection fronts (the "opaque cloud cutout" look).
    this.blurDye(this.opts.dyeDiffuse);

    // Accumulate monotonic ink coverage for the focus reveal.
    const C = this.programs.cover;
    C.bind();
    gl.uniform1i(C.uniforms['uPrev'], this.coverage.read.attach(0));
    gl.uniform1i(C.uniforms['uDye'], this.dye.read.attach(1));
    this.blit(this.coverage.write); this.coverage.swap();
  }

  private blurDye(radius: number) {
    if (radius <= 0) return;
    const gl = this.gl;
    const B = this.programs.blur;
    B.bind();
    gl.uniform1i(B.uniforms['uTex'], this.dye.read.attach(0));
    gl.uniform2f(B.uniforms['dir'], radius * this.dye.texelSizeX, 0);
    this.blit(this.dye.write); this.dye.swap();
    gl.uniform1i(B.uniforms['uTex'], this.dye.read.attach(0));
    gl.uniform2f(B.uniforms['dir'], 0, radius * this.dye.texelSizeY);
    this.blit(this.dye.write); this.dye.swap();
  }

  /**
   * Paint the canvas opaque so it covers the live document. The blurred snapshot
   * is mostly this same color, so the hand-off into the reveal is seamless.
   *
   * Call timing depends on the capture method (see Suminagashi.run): with the DOM
   * reader (html-to-image) this runs first to prevent any flash; with the native
   * WKWebView snapshot it must run *after* capture, since the snapshot reads the
   * on-screen pixels and the canvas has to stay transparent until then.
   */
  fillBackground(color: [number, number, number]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(color[0], color[1], color[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.canvas.style.opacity = '1';
  }

  /** True once a document snapshot has been provided. */
  get hasDocument() { return !!this.docTex && !!this.docBlur; }

  /**
   * Render the document snapshot — blurred, sharpened along the ink coverage and
   * the global-focus ramp — with the live ink painted on top.
   * globalFocus: 0..1 end ramp that brings any unreached areas into focus;
   * ink: opacity of the visible ink strokes; fade: canvas CSS opacity;
   * endSoften: 0..1 blur-out of the snapshot during the final dissolve.
   */
  render(fade: number, globalFocus: number, ink: number, endSoften = 0) {
    const gl = this.gl;
    if (!this.docTex || !this.docBlur) { this.canvas.style.opacity = String(fade); return; }
    const D = this.programs.display;
    D.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.docTex);
    gl.uniform1i(D.uniforms['uDoc'], 0);
    gl.uniform1i(D.uniforms['uDocBlur'], this.docBlur.read.attach(1));
    gl.uniform1i(D.uniforms['uCoverage'], this.coverage.read.attach(2));
    gl.uniform1i(D.uniforms['uDye'], this.dye.read.attach(3));
    gl.uniform1f(D.uniforms['uGlobalFocus'], globalFocus);
    gl.uniform1f(D.uniforms['uInk'], ink);
    gl.uniform1f(D.uniforms['uEndSoften'], endSoften);
    this.blit(null);
    this.canvas.style.opacity = String(fade);
  }

  dispose() {
    const gl = this.gl;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
}
