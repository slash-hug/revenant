// diagram-viewer.js — standalone pan/zoom controller for the diagram popout window.
// Loaded as an external script to comply with the app's CSP (no 'unsafe-inline').

const ZOOM_MIN = 0.25, ZOOM_MAX = 4.0, ZOOM_FACTOR = 1.25, PAN_STEP = 50;
let scale = 1, panX = 0, panY = 0;
let dragging = false, dsx = 0, dsy = 0, dpx = 0, dpy = 0;

const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');
const titleBar = document.getElementById('titleBar');

function clamp(s) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s)); }

function applyTransform() {
  canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

function panDir(dx, dy) { panX += dx; panY += dy; applyTransform(); }

function zoomAt(dir, cx, cy) {
  const f = dir === 1 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const ns = clamp(scale * f);
  if (ns === scale) return;
  const canvasX = (cx - panX) / scale;
  const canvasY = (cy - panY) / scale;
  scale = ns;
  panX = cx - canvasX * scale;
  panY = cy - canvasY * scale;
  applyTransform();
}

function zoomCenter(dir) {
  zoomAt(dir, window.innerWidth / 2, window.innerHeight / 2);
}

function fitView() {
  const svg = canvas.querySelector('svg');
  if (!svg) { scale = 1; panX = 0; panY = 0; applyTransform(); return; }
  const w = svg.width?.baseVal?.value || svg.getBoundingClientRect().width || 400;
  const h = svg.height?.baseVal?.value || svg.getBoundingClientRect().height || 300;
  const vw = window.innerWidth, vh = window.innerHeight - 32;
  scale = Math.min(1.0, vw / w, vh / h);
  panX = (vw - w * scale) / 2;
  panY = 32 + (vh - h * scale) / 2;
  applyTransform();
}

// Drag to pan
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  dragging = true; dsx = e.clientX; dsy = e.clientY; dpx = panX; dpy = panY;
  viewport.classList.add('dragging');
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener('pointermove', e => {
  if (!dragging) return;
  panX = dpx + e.clientX - dsx;
  panY = dpy + e.clientY - dsy;
  applyTransform();
});
viewport.addEventListener('pointerup', () => { dragging = false; viewport.classList.remove('dragging'); });
viewport.addEventListener('pointercancel', () => { dragging = false; viewport.classList.remove('dragging'); });

// Scroll: pan or zoom
viewport.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const rect = viewport.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top);
  } else {
    panX -= e.deltaX; panY -= e.deltaY;
    applyTransform();
  }
}, { passive: false });

// Keyboard
document.addEventListener('keydown', e => {
  switch (e.key) {
    case 'ArrowUp':    e.preventDefault(); panDir(0, PAN_STEP); break;
    case 'ArrowDown':  e.preventDefault(); panDir(0, -PAN_STEP); break;
    case 'ArrowLeft':  e.preventDefault(); panDir(PAN_STEP, 0); break;
    case 'ArrowRight': e.preventDefault(); panDir(-PAN_STEP, 0); break;
    case '+': case '=': e.preventDefault(); zoomCenter(1); break;
    case '-':           e.preventDefault(); zoomCenter(-1); break;
    case '0':           e.preventDefault(); fitView(); break;
    case 'Escape':      window.close(); break;
  }
});

// Toolbar button wiring (no inline onclick — CSP compliance)
document.querySelector('.nav-up').addEventListener('click', () => panDir(0, 50));
document.querySelector('.nav-zin').addEventListener('click', () => zoomCenter(1));
document.querySelector('.nav-left').addEventListener('click', () => panDir(50, 0));
document.querySelector('.nav-fit').addEventListener('click', () => fitView());
document.querySelector('.nav-right').addEventListener('click', () => panDir(-50, 0));
document.querySelector('.nav-down').addEventListener('click', () => panDir(0, -50));
document.querySelector('.nav-zout').addEventListener('click', () => zoomCenter(-1));

// Init from injected globals
// window.__DIAGRAM_SVG__ is set by the Tauri initialization script, which runs
// before DOMContentLoaded. By the time this deferred script executes,
// the global should already be available.
const svg = window.__DIAGRAM_SVG__;
const title = window.__DIAGRAM_TITLE__ || '';
if (svg) {
  canvas.innerHTML = svg;
  titleBar.textContent = title || 'Diagram';
  document.title = title ? `Diagram \u2014 ${title}` : 'Diagram';
  requestAnimationFrame(() => fitView());
} else {
  canvas.innerHTML = '<p style="padding:40px;color:#888;">No diagram data received.</p>';
}
