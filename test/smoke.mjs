/**
 * smoke.mjs — Comprobación general: ingesta, ajustes, PDF y móvil.
 *
 *   node test/smoke.mjs
 *
 * Valida el PDF con pdfinfo y pdftoppm, y además mira los píxeles de la
 * página rasterizada: si el XObject está mal declarado la página sale en
 * blanco y pdfinfo no se queja, así que este es el control que de verdad
 * protege contra ese fallo.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const SERVE = new URL('../serve.mjs', import.meta.url);
const PORT = 5224;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT = join(tmpdir(), 'fotoapdf-smoke');

const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fails.push(m); };
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'dl'), { recursive: true });

const server = spawn('node', [SERVE.pathname, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 900 },
});

try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', async (m) => {
    if (m.type() !== 'error') return;
    try { errs.push(await m.args()[0].evaluate((e) => (e && e.stack) || String(e))); } catch { /* noop */ }
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
  ok('la app carga');

  await page.evaluate(() => {
    const mk = (angle, w, h, cw, ch) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#4a3826'; x.fillRect(0, 0, w, h);
      x.save();
      x.translate(w / 2, h / 2); x.rotate((angle * Math.PI) / 180);
      x.fillStyle = '#fbfaf6'; x.fillRect(-cw / 2, -ch / 2, cw, ch);
      x.fillStyle = '#1c1c1c';
      for (let i = 0; i < 24; i++) {
        x.fillRect(-cw / 2 + 40, -ch / 2 + 60 + i * ((ch - 110) / 24), (cw - 80) * 0.72, 8);
      }
      x.restore();
      c.toBlob((b) => {
        const dt = new DataTransfer();
        dt.items.add(new File([b], `${angle}.png`, { type: 'image/png' }));
        const input = document.querySelector('#file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, 'image/png');
    };
    mk(6, 1000, 800, 400, 560);
    mk(-9, 1000, 800, 400, 560);
  });

  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, { timeout: 25000 });
  ok('2 páginas ingeridas');

  await page.select('#set-size', 'a4');
  await new Promise((r) => setTimeout(r, 200));

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow', downloadPath: join(OUT, 'dl'),
  });
  await page.evaluate(() => document.querySelector('#btn-download').click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('PDF listo')),
    { timeout: 30000 },
  );

  let pdf = null;
  for (let i = 0; i < 40 && !pdf; i++) {
    const f = await readdir(join(OUT, 'dl')).catch(() => []);
    pdf = f.find((x) => x.endsWith('.pdf')) || null;
    if (!pdf) await new Promise((r) => setTimeout(r, 250));
  }

  if (!pdf) {
    bad('no se descargó el PDF');
  } else {
    const path = join(OUT, 'dl', pdf);
    const buf = await readFile(path);
    info(`PDF ${(buf.length / 1024).toFixed(0)} KB`);
    ok('PDF descargado');

    const meta = await new Promise((res) => {
      const p = spawn('pdfinfo', [path]);
      let o = '';
      p.stdout.on('data', (d) => { o += d; });
      p.on('close', () => res(o));
    });
    const n = (meta.match(/^Pages:\s*(\d+)/m) || [])[1];
    n === '2' ? ok('pdfinfo: 2 páginas') : bad(`pdfinfo dice ${n} páginas`);

    const err = await new Promise((res) => {
      const p = spawn('pdftoppm', ['-gray', '-r', '50', '-f', '1', '-l', '1', path, join(OUT, 'p')]);
      let e = '';
      p.stderr.on('data', (d) => { e += d; });
      p.on('close', () => res(e.trim()));
    });
    err === '' ? ok('estructura del PDF válida') : bad(`pdftoppm: ${err.split('\n')[0]}`);

    const pgm = (await readdir(OUT)).find((f) => f.endsWith('.pgm'));
    const raw = await readFile(join(OUT, pgm));
    const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(raw.subarray(0, 40).toString('latin1'));
    const tinta = raw.subarray(m[0].length).filter((v) => v < 128).length / (raw.length - m[0].length);
    info(`página ${m[1]}×${m[2]}, ${(tinta * 100).toFixed(1)}% de tinta`);
    tinta > 0.02
      ? ok('la página trae la imagen incrustada (no sale en blanco)')
      : bad('la página sale en blanco');
  }

  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await new Promise((r) => setTimeout(r, 400));

  const mv = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    toggle: getComputedStyle(document.querySelector('#panel-toggle')).display !== 'none',
    disparo: getComputedStyle(document.querySelector('.btn-round')).width,
  }));
  !mv.overflow ? ok('sin desbordamiento horizontal a 390 px') : bad('desbordamiento en móvil');
  mv.toggle ? ok('los ajustes se pliegan en móvil') : bad('los ajustes no se pliegan');
  info(`botón de disparo: ${mv.disparo}`);

  const botones = await page.evaluate(() => {
    const foot = document.querySelector('#modal-camera .modal-foot');
    const modal = document.querySelector('#modal-camera');
    modal.hidden = false;
    const caja = foot.getBoundingClientRect();
    const dentro = [...foot.children].every((b) => {
      const r = b.getBoundingClientRect();
      return r.right <= caja.right + 1 && r.left >= caja.left - 1 && r.width > 10;
    });
    modal.hidden = true;
    return dentro;
  });
  botones
    ? ok('los tres botones del modal caben a 390 px')
    : bad('algún botón se sale del modal');

  errs.length === 0 ? ok('sin errores de consola') : errs.forEach((e) => bad(`consola: ${e}`));
} finally {
  await browser.close();
  server.kill();
}

console.log(fails.length ? `\n\x1b[31m${fails.length} fallos\x1b[0m\n` : '\n\x1b[32mTodo correcto\x1b[0m\n');
process.exit(fails.length ? 1 : 0);