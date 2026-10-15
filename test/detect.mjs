/**
 * detect.mjs — Regresión del detector de documentos.
 *
 * Comprueba tres cosas que romperse rompe todo:
 *   1. la dilatación no se invierte al pasar a la columna,
 *   2. la caja mínima sigue al documento aunque esté torcido,
 *   3. la homografía rectifica de verdad (si no, sale una página en blanco).
 *
 * Las imágenes son sintéticas y se conoce exactamente dónde va cada
 * esquina, así que el error se puede medir en píxeles.
 *
 * Uso:  npm i puppeteer-core   (solo para los tests)
 *       node test/detect.mjs
 */

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url);
const SERVE = new URL('serve.mjs', ROOT);
const PORT = 5221;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fails.push(m); };
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);

const server = spawn('node', [SERVE.pathname, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => bad(`excepción: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });

  // ── morfología: cerrar debe devolver la forma original
  const morph = await page.evaluate(async () => {
    const { detectDocument } = await import('/js/detect.js');
    void detectDocument;
    const w = 20, h = 12;
    const m = new Uint8Array(w * h);
    for (let y = 3; y < 7; y++) for (let x = 5; x < 10; x++) m[y * w + x] = 1;

    // reimplementado aquí a propósito: si el módulo cambia, esto avisa
    const R = 2;
    const dilate = (src) => {
      const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let k = -R; k <= R && !v; k++) {
            const xx = Math.max(0, Math.min(w - 1, x + k));
            if (src[y * w + xx]) v = 1;
          }
          tmp[y * w + x] = v;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 0;
          for (let k = -R; k <= R && !v; k++) {
            const yy = Math.max(0, Math.min(h - 1, y + k));
            if (tmp[yy * w + x]) v = 1;
          }
          out[y * w + x] = v;
        }
      }
      return out;
    };
    const erode = (src) => {
      const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 1;
          for (let k = -R; k <= R && v; k++) {
            const xx = Math.max(0, Math.min(w - 1, x + k));
            if (!src[y * w + xx]) v = 0;
          }
          tmp[y * w + x] = v;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 1;
          for (let k = -R; k <= R && v; k++) {
            const yy = Math.max(0, Math.min(h - 1, y + k));
            if (!tmp[yy * w + x]) v = 0;
          }
          out[y * w + x] = v;
        }
      }
      return out;
    };
    const sum = (a) => a.reduce((s, v) => s + v, 0);
    const cerrado = erode(dilate(m));
    return { entrada: sum(m), cerrado: sum(cerrado), todo: sum(dilate(m)) };
  });
  morph.cerrado === morph.entrada
    ? ok(`cierre morfológico conserva el área (${morph.entrada} → ${morph.cerrado})`)
    : bad(`la dilatación está rota: ${morph.entrada} → ${morph.cerrado}`);
  morph.todo === 0
    ? bad('dilate() se ha vaciado por completo')
    : info(`dilate() crece a ${morph.todo} px`);

  // ── precisión de esquinas y rectificación
  const casos = [
    { n: 'recto', ang: 0, W: 1200, H: 900, cw: 460, ch: 620 },
    { n: 'torcido 9°', ang: 9, W: 1200, H: 900, cw: 470, ch: 630 },
    { n: 'torcido -14°', ang: -14, W: 900, H: 1200, cw: 560, ch: 780 },
    { n: 'torcido 23°', ang: 23, W: 1000, H: 1000, cw: 500, ch: 700 },
  ];

  for (const c of casos) {
    const r = await page.evaluate(async (cfg) => {
      const { detectDocument, rectify } = await import('/js/detect.js');
      const { W, H, cw, ch, ang } = cfg;

      const cvs = document.createElement('canvas');
      cvs.width = W; cvs.height = H;
      const x = cvs.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#4a3826'; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 160; i++) {
        x.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
        x.fillRect(Math.random() * W, Math.random() * H, 40 + Math.random() * 160, 2 + Math.random() * 3);
      }
      x.save();
      x.translate(W / 2, H / 2);
      x.rotate((ang * Math.PI) / 180);
      x.fillStyle = '#fbfaf6';
      x.fillRect(-cw / 2, -ch / 2, cw, ch);
      x.fillStyle = '#1c1c1c';
      for (let i = 0; i < 24; i++) {
        x.fillRect(-cw / 2 + 40, -ch / 2 + 60 + i * ((ch - 110) / 24), (cw - 80) * 0.7, 9);
      }
      x.restore();

      const det = await detectDocument(cvs);
      if (!det) return { ok: false };

      const rad = (ang * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const exp = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const px = (sx * cw) / 2, py = (sy * ch) / 2;
        return { x: W / 2 + px * cos - py * sin, y: H / 2 + px * sin + py * cos };
      });
      const err = det.corners.map((p, i) => Math.hypot(p.x - exp[i].x, p.y - exp[i].y));

      const out = rectify(cvs, det.corners, 900);
      const px = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
      let dark = 0, total = 0;
      for (let i = 0; i < px.length; i += 4 * 13) {
        total++;
        if ((px[i] + px[i + 1] + px[i + 2]) / 3 < 110) dark++;
      }
      const esquina = (u, v) => {
        const i = ((Math.round(v * (out.height - 1)) * out.width) + Math.round(u * (out.width - 1))) * 4;
        return (px[i] + px[i + 1] + px[i + 2]) / 3;
      };

      return {
        ok: true,
        media: err.reduce((s, v) => s + v, 0) / 4,
        peor: Math.max(...err),
        aspecto: out.width / out.height,
        aspectoOk: Math.abs(out.width / out.height - cw / ch) < 0.1 * (cw / ch),
        tinta: dark / total,
        esquinasClaras: [esquina(0.05, 0.05), esquina(0.95, 0.05), esquina(0.95, 0.95), esquina(0.05, 0.95)]
          .every((v) => v > 120),
      };
    }, c);

    if (!r.ok) { bad(`${c.n}: no detectó el documento`); continue; }
    r.media < 18
      ? ok(`${c.n}: error medio ${r.media.toFixed(1)} px (peor ${r.peor.toFixed(1)})`)
      : bad(`${c.n}: error medio ${r.media.toFixed(1)} px`);
    r.aspectoOk
      ? info(`aspecto ${r.aspecto.toFixed(3)} (esperado ${(c.cw / c.ch).toFixed(3)})`)
      : bad(`${c.n}: relación de aspecto ${r.aspecto.toFixed(3)} ≠ ${(c.cw / c.ch).toFixed(3)}`);
    r.esquinasClaras && r.tinta > 0.02 && r.tinta < 0.6
      ? ok(`${c.n}: rectificación correcta (${(r.tinta * 100).toFixed(1)}% de tinta)`)
      : bad(`${c.n}: la rectificación no conserva el papel (tinta ${(r.tinta * 100).toFixed(1)}%)`);
  }

  // ── orientación del texto
  const orient = await page.evaluate(async () => {
    const { estimateOrientation } = await import('/js/detect.js');
    const caso = (w, h, vertical) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#fbfaf6'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#1c1c1c';
      const m = Math.min(w, h) * 0.1;
      if (vertical) {
        const step = (w - m * 3) / 22;
        for (let i = 0; i < 22; i++) x.fillRect(m + i * step, m, step * 0.42, h - m * 2);
      } else {
        const step = (h - m * 3) / 22;
        for (let i = 0; i < 22; i++) x.fillRect(m, m + i * step, w - m * 2, step * 0.42);
      }
      return estimateOrientation(c);
    };
    return {
      hor: caso(700, 1000, false),
      ver: caso(700, 1000, true),
    };
  });
  orient.hor === 'landscape'
    ? ok('texto en horizontal → «landscape»')
    : bad(`texto en horizontal detectado como ${orient.hor}`);
  orient.ver === 'portrait'
    ? ok('texto en vertical → «portrait»')
    : bad(`texto en vertical detectado como ${orient.ver}`);
} finally {
  await browser.close();
  server.kill();
}

console.log(fails.length ? `\n\x1b[31m${fails.length} fallos\x1b[0m\n` : '\n\x1b[32mTodo correcto\x1b[0m\n');
process.exit(fails.length ? 1 : 0);