/**
 * gen-y4m.mjs — Genera el vídeo que Chrome usa como cámara falsa.
 *
 *   node test/gen-y4m.mjs salida.y4m [correcto|sideways]
 *
 * `correcto`  → hoja vertical con el texto en horizontal (no hay que girar)
 * `sideways`  → hoja apaisada con el texto de lado (hay que girar 90°)
 *
 * Es una imagen dibujada píxel a píxel y luego convertida a YUV420, en el
 * formato raw que Chrome entiende con --use-file-for-fake-video-capture.
 */

import { writeFileSync } from 'node:fs';

const W = 640;
const H = 480;
const SIDEWAYS = process.argv[3] === 'sideways';

const SHEET_W = 268;
const SHEET_H = 372;
const BAR = 8;
const GAP = 12.5;
const MARGIN = 34;
const ANGLE = -8 * Math.PI / 180;

const rgb = new Uint8Array(W * H * 3);

// mesa oscura con veta vertical: sin textura el detector sería demasiado fácil
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const grain = ((x * 7 + y * 13) % 97) < 40 ? 12 : 0;
    const i = (y * W + x) * 3;
    rgb[i] = 74 + grain;
    rgb[i + 1] = 56 + grain;
    rgb[i + 2] = 38 + grain;
  }
}

const put = (px, py, v) => {
  const x = Math.round(px);
  const y = Math.round(py);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  rgb[i] = v;
  rgb[i + 1] = v;
  rgb[i + 2] = Math.max(0, v - 4);
};

// `u` avanza a lo largo de las líneas, `v` cruza de una línea a otra.
// Las líneas arrancan todas en el mismo margen, que es justo lo que
// despista al refinado del detector.
const inkAt = (u, v) => {
  const halfU = SHEET_W / 2;
  const halfV = SHEET_H / 2;
  if (Math.abs(u) > halfU || Math.abs(v) > halfV) return null;
  if (v > halfV - 44 && v < halfV - 24 && Math.abs(u) < halfU * 0.7) return 140;

  const start = halfV - 56;
  const idx = Math.floor((start - v) / GAP);
  const bar = v < start && idx >= 0 && (start - v - idx * GAP) < BAR
    && u > -halfU + MARGIN && u < halfU - MARGIN - (idx % 3) * 20;
  return bar ? 30 : 250;
};

const cos = Math.cos(ANGLE);
const sin = Math.sin(ANGLE);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - W / 2;
    const dy = y + 0.5 - H / 2;
    let lx = dx * cos + dy * sin;
    let ly = -dx * sin + dy * cos;
    if (SIDEWAYS) { const t = lx; lx = ly; ly = t; }
    const ink = inkAt(lx, ly);
    if (ink !== null) put(x, y, ink);
  }
}

const cl = (v) => Math.max(0, Math.min(255, Math.round(v)));
const Y = new Uint8Array(W * H);
const U = new Uint8Array((W / 2) * (H / 2));
const V = new Uint8Array((W / 2) * (H / 2));

for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    const i = (py * W + px) * 3;
    Y[py * W + px] = cl(0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]);
  }
}
for (let py = 0; py < H / 2; py++) {
  for (let px = 0; px < W / 2; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
      const i = ((py * 2 + dy) * W + (px * 2 + dx)) * 3;
      r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2];
    }
    r /= 4; g /= 4; b /= 4;
    U[py * (W / 2) + px] = cl(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
    V[py * (W / 2) + px] = cl(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
  }
}

const dest = process.argv[2];
if (!dest) {
  console.error('uso: node test/gen-y4m.mjs salida.y4m [correcto|sideways]');
  process.exit(1);
}
writeFileSync(dest, Buffer.concat([
  Buffer.from(`YUV4MPEG2 W${W} H${H} F25:1 Ip A1:1 C420\n`, 'ascii'),
  Buffer.from('FRAME\n', 'ascii'),
  Buffer.from(Y), Buffer.from(U), Buffer.from(V),
]));
console.log(`Y4M ${SIDEWAYS ? 'torcido' : 'correcto'} → ${dest}`);