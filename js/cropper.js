/**
 * cropper.js — Recorte interactivo con tiradores.
 *
 * Muestra la foto con un cuadrilátero encima. Se pueden arrastrar las
 * cuatro esquinas, los cuatro lados o el bloque completo. Sirve de red de
 * seguridad cuando la detección automática no acierta.
 */

import { rectify } from './detect.js';

const HANDLE_R = 11; // radio de acierto en píxeles de pantalla
const HIT = 18;

export class Cropper {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{title?: string, applyLabel?: string}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.corners = null;
    this.source = null;
    this.drag = null;
    this.onApply = null;
    this.onCancel = null;

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);
  }

  destroy() {
    const { canvas } = this;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onUp);
    this.onApply = this.onCancel = null;
  }

  /**
   * @param {HTMLCanvasElement|HTMLImageElement} source
   * @param {Array<{x:number,y:number}>} corners en píxeles de la imagen
   */
  open(source, corners) {
    this.source = source;
    this.corners = corners.map((p) => ({ ...p }));
    this.resize();
    this.draw();
  }

  resize() {
    const host = this.canvas.parentElement;
    const rect = host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(rect.width));
    const ch = Math.max(1, Math.round(rect.height));

    this.canvas.width = cw * dpr;
    this.canvas.height = ch * dpr;
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sw = this.source.naturalWidth || this.source.width;
    const sh = this.source.naturalHeight || this.source.height;
    const k = Math.min(cw / sw, ch / sh) * 0.94;
    this.scale = k;
    this.ox = (cw - sw * k) / 2;
    this.oy = (ch - sh * k) / 2;
    this.viewW = cw;
    this.viewH = ch;
    this.draw();
  }

  // imagen → pantalla y pantalla → imagen
  toScreen(p) {
    return { x: this.ox + p.x * this.scale, y: this.oy + p.y * this.scale };
  }
  toImage(p) {
    return { x: (p.x - this.ox) / this.scale, y: (p.y - this.oy) / this.scale };
  }

  draw() {
    const { ctx } = this;
    const sw = this.source.naturalWidth || this.source.width;
    const sh = this.source.naturalHeight || this.source.height;

    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.drawImage(this.source, this.ox, this.oy, sw * this.scale, sh * this.scale);

    const pts = this.corners.map((p) => this.toScreen(p));

    // velo fuera del cuadrilátero
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.viewW, this.viewH);
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = pts.length - 1; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(9, 12, 20, 0.62)';
    ctx.fill('evenodd');
    ctx.restore();

    // contorno + guías
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // tiradores: esquinas primero, luego puntos medios de lado
    const handles = pts.map((p) => ({ p, corner: true }));
    for (const m of midpoints(pts)) handles.push({ p: m, corner: false });

    for (const { p, corner } of handles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = corner ? '#ffffff' : '#4f8cff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#12161f';
      ctx.stroke();
    }
  }

  hitTest(pt) {
    const pts = this.corners.map((p) => this.toScreen(p));
    for (let i = 0; i < 4; i++) {
      if (dist(pt, pts[i]) <= HIT) return { type: 'corner', index: i };
    }
    const mids = midpoints(pts);
    for (let i = 0; i < 4; i++) {
      if (distToSegment(pt, mids[i], pts[i], pts[(i + 1) % 4]) <= HIT) {
        return { type: 'edge', index: i };
      }
    }
    if (inQuad(pt, pts)) return { type: 'move' };
    return null;
  }

  onDown = (e) => {
    if (!this.corners) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const hit = this.hitTest(pt);
    if (!hit) return;

    this.canvas.setPointerCapture(e.pointerId);
    this.drag = {
      ...hit,
      start: pt,
      origin: this.corners.map((c) => ({ ...c })),
    };
    e.preventDefault();
  };

  onMove = (e) => {
    if (!this.corners) return;
    const rect = this.canvas.getBoundingClientRect();
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    if (!this.drag) {
      this.canvas.style.cursor = this.hitTest(pt)
        ? 'grab'
        : 'default';
      return;
    }

    const img = this.toImage(pt);
    const start = this.toImage(this.drag.start);
    const d = this.drag;
    const sw = this.source.naturalWidth || this.source.width;
    const sh = this.source.naturalHeight || this.source.height;
    const next = this.drag.origin.map((c) => ({ ...c }));

    if (d.type === 'move') {
      for (const c of next) {
        c.x = clamp(c.x + img.x - start.x, 0, sw);
        c.y = clamp(c.y + img.y - start.y, 0, sh);
      }
    } else if (d.type === 'corner') {
      next[d.index] = { x: clamp(img.x, 0, sw), y: clamp(img.y, 0, sh) };
    } else {
      const i = d.index, j = (d.index + 1) % 4;
      const a = next[i], b = next[j];
      let nx = 0, ny = 0;
      const l1 = Math.hypot(b.x - a.x, b.y - a.y);
      const l2 = Math.hypot(next[j].x - next[(j + 1) % 4].x, next[j].y - next[(j + 1) % 4].y);
      if (l1 >= l2) nx = img.x - start.x; else ny = img.y - start.y;
      a.x = clamp(a.x + nx, 0, sw); a.y = clamp(a.y + ny, 0, sh);
      b.x = clamp(b.x + nx, 0, sw); b.y = clamp(b.y + ny, 0, sh);
    }
    this.corners = next;
    this.canvas.style.cursor = 'grabbing';
    this.draw();
  };

  onUp = (e) => {
    if (!this.drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }
  };

  /** Devuelve el canvas ya rectificado, o null si el quad es inválido. */
  apply(maxDim = 2000) {
    const sw = this.source.naturalWidth || this.source.width;
    const sh = this.source.naturalHeight || this.source.height;
    const outW = Math.min(maxDim, Math.max(
      320,
      Math.round(Math.hypot(
        this.corners[1].x - this.corners[0].x,
        this.corners[1].y - this.corners[0].y,
      )),
    ));
    if (polyArea(this.corners) < sw * sh * 0.01) return null;
    return rectify(this.source, this.corners, outW);
  }
}

// ───────────────────────────────────────────────────────────── helpers

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function midpoints(pts) {
  return [0, 1, 2, 3].map((i) => {
    const a = pts[i], b = pts[(i + 1) % 4];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

function inQuad(p, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}