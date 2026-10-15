/**
 * camera.mjs — Flujo completo de cámara contra la cámara falsa de Chrome.
 *
 *   node test/gen-y4m.mjs /tmp/doc.y4m sideways
 *   node test/camera.mjs sideways
 *
 * Comprueba getUserMedia → captura → detección → rectificación → PDF, en los
 * dos escenarios que importan: página bien fotografiada y página con el móvil
 * torcido.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const SERVE = new URL('../serve.mjs', import.meta.url);
const PORT = 5222;
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const MODE = process.argv[2] === 'sideways' ? 'sideways' : 'correcto';
const ESPERA_APAISADA = MODE === 'sideways';

const OUT = join(tmpdir(), `fotoapdf-${MODE}`);
const Y4M = join(OUT, 'doc.y4m');
const DL = join(OUT, 'dl');

const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); fails.push(m); };
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);

await rm(OUT, { recursive: true, force: true });
await mkdir(DL, { recursive: true });
spawn(process.execPath, [new URL('gen-y4m.mjs', import.meta.url).pathname, Y4M, MODE],
  { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

const server = spawn('node', [SERVE.pathname, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${Y4M}`,
  ],
  defaultViewport: { width: 1100, height: 900 },
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
  await browser.defaultBrowserContext().overridePermissions(`http://localhost:${PORT}`, ['camera']);

  console.log(`\n\x1b[1mCámara · escenario «${MODE}»\x1b[0m`);

  await page.evaluate(() => document.querySelector('#btn-camera').click());
  await page.waitForFunction(() => !document.querySelector('#modal-camera').hidden, { timeout: 10000 });
  await page.waitForFunction(() => {
    const v = document.querySelector('#video');
    return v && v.readyState >= 2 && v.videoWidth > 0;
  }, { timeout: 15000 });
  ok('la cámara entrega imagen en vivo');

  await page.evaluate(() => document.querySelector('#btn-shot').click());
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 1, { timeout: 20000 });
  ok('la captura añade una página y abre el editor');

  const card = await page.evaluate(() => {
    const c = document.querySelector('.card');
    return {
      auto: !!c.querySelector('.card-badge'),
      w: c.querySelector('img').naturalWidth,
      h: c.querySelector('img').naturalHeight,
    };
  });
  card.auto ? ok('el recorte automático se aplicó') : bad('no se marcó como auto');
  info(`miniatura ${card.w}×${card.h}`);

  const apaisada = card.w > card.h;
  const editorial = ESPERA_APAISADA ? apaisada : !apaisada && card.w <= card.h * 1.4;
  editorial
    ? ok(ESPERA_APAISADA
      ? 'el móvil torcido se corrige y la página queda apaisada'
      : 'una página bien fotografiada no se toca')
    : bad(`orientación inesperada: ${card.w}×${card.h}`);

  const pix = await page.evaluate(() => {
    const img = document.querySelector('.card img');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0; let total = 0;
    for (let i = 0; i < d.length; i += 4 * 7) {
      total++;
      if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 110) dark++;
    }
    const esquina = (u, v) => {
      const i = ((Math.round(v * (c.height - 1)) * c.width) + Math.round(u * (c.width - 1))) * 4;
      return (d[i] + d[i + 1] + d[i + 2]) / 3;
    };
    return {
      tinta: dark / total,
      esquinasClaras: [0.03, 0.97].flatMap((u) => [0.03, 0.97].map((v) => esquina(u, v)))
        .every((v) => v > 110),
    };
  });
  info(`tinta ${(pix.tinta * 100).toFixed(1)}%`);
  pix.tinta > 0.02 && pix.tinta < 0.6
    ? ok('el recorte conserva el texto') : bad('el recorte se ha comido el contenido');
  pix.esquinasClaras
    ? ok('no queda mesa en el recorte') : bad('queda fondo de mesa en el recorte');

  await page.evaluate(() => document.querySelector('#btn-shot').click());
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 2, { timeout: 20000 });
  ok('se pueden encadenar capturas sin cerrar el modal');

  await page.evaluate(() => document.querySelector('#btn-cam-close').click());
  await new Promise((r) => setTimeout(r, 400));
  const flujo = await page.$eval('#video', (v) => (v.srcObject ? 'activo' : 'detenido'));
  flujo === 'detenido' ? ok('al cerrar se sueltan los flujos de la cámara') : bad(`vídeo ${flujo}`);

  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await page.evaluate(() => document.querySelector('#btn-download').click());
  await page.waitForFunction(
    () => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('PDF listo')),
    { timeout: 30000 },
  );

  let pdf = null;
  for (let i = 0; i < 40 && !pdf; i++) {
    const files = await readdir(DL).catch(() => []);
    pdf = files.find((f) => f.endsWith('.pdf')) || null;
    if (!pdf) await new Promise((r) => setTimeout(r, 250));
  }
  if (!pdf) {
    bad('no se descargó el PDF');
  } else {
    const path = join(DL, pdf);
    const buf = await readFile(path);
    info(`PDF ${(buf.length / 1024).toFixed(0)} KB`);

    const salida = await new Promise((res) => {
      const p = spawn('pdfinfo', [path]);
      let o = '';
      p.stdout.on('data', (d) => { o += d; });
      p.on('close', () => res(o));
    });
    const n = (salida.match(/^Pages:\s*(\d+)/m) || [])[1];
    n === '2' ? ok('PDF de 2 páginas') : bad(`PDF de ${n} páginas`);

    const err = await new Promise((res) => {
      const p = spawn('pdftoppm', ['-r', '40', '-f', '1', '-l', '1', path, join(OUT, 'p')]);
      let e = '';
      p.stderr.on('data', (d) => { e += d; });
      p.on('close', () => res(e.trim()));
    });
    err === '' ? ok('pdftoppm abre el PDF sin quejas') : bad(`pdftoppm: ${err.split('\n')[0]}`);
  }

  errs.length === 0 ? ok('sin errores de consola') : errs.forEach((e) => bad(`consola: ${e}`));
} finally {
  await browser.close();
  server.kill();
}

console.log(fails.length ? `\n\x1b[31m${fails.length} fallos\x1b[0m\n` : '\n\x1b[32mTodo correcto\x1b[0m\n');
process.exit(fails.length ? 1 : 0);