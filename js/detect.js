/**
 * detect.js — Detección de documento y corrección de perspectiva.
 *
 * Todo en CPU sobre un downscale (~480 px) para que vaya rápido en móvil,
 * con un refinado final de las 4 esquinas sobre la imagen completa.
 *
 * Pipeline:
 *   1. gris + desenfoque
 *   2. dos estrategias de máscara, nos quedamos con la más fiable:
 *        a) brillo  → el papel es la región más clara (Otsu)
 *        b) bordes  → por si el documento es oscuro o el fondo claro
 *   3. mayor componente conexa + limpieza morfológica
 *   4. rectángulo mínimo → 4 vértices
 *   5. refinado de cada lado buscando el gradiente máximo
 *   6. intersección de líneas → cuadrilátero final
 */

const WORK = 480; // lado mayor del lienzo de trabajo

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ─────────────────────────────────────────────────────────── utilidades

export function loadImage(src) {
  if (typeof src !== 'string') return Promise.resolve(src);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = src;
  });
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawScaled(image, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  return c;
}

function grayOf(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    g[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  }
  return g;
}

/** Desenfoque de caja separable; tres pasadas ≈ gaussiano. */
function blur(src, w, h, r = 2) {
  const a = src;
  const b = new Float32Array(w * h);
  const d = 2 * r + 1;
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / d;
        sum -= a[row + clamp(x - r, 0, w - 1)];
        sum += a[row + clamp(x + r + 1, 0, w - 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / d;
        sum -= b[clamp(y - r, 0, h - 1) * w + x];
        sum += b[clamp(y + r + 1, 0, h - 1) * w + x];
      }
    }
  }
  return a;
}

/** Magnitud del gradiente (Sobel), normalizada 0..1. */
function sobel(g, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1] -
        (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]);
      const gy =
        g[i - w - 1] + 2 * g[i - w] + g[i - w + 1] -
        (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]);
      out[i] = Math.hypot(gx, gy) / 4;
    }
  }
  return out;
}

/** Umbral de Otsu: maximiza la separación entre clases de intensidad. */
function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[(gray[i] * 255) | 0]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; thr = i; }
  }
  return thr / 255;
}

// ─────────────────────────────────────────── morfología y componentes

/** Dilatación con un elemento separable 1×5. */
function dilate(mask, w, h) {
  const R = 2;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -R; k <= R && !v; k++) {
        if (mask[row + clamp(x + k, 0, w - 1)]) v = 1;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -R; k <= R && !v; k++) {
        if (tmp[clamp(y + k, 0, h - 1) * w + x]) v = 1;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Erosión con el mismo elemento separable. */
function erode(mask, w, h) {
  const R = 2;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -R; k <= R && v; k++) {
        if (!mask[row + clamp(x + k, 0, w - 1)]) v = 0;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = -R; k <= R && v; k++) {
        if (!tmp[clamp(y + k, 0, h - 1) * w + x]) v = 0;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Cierre morfológico: une bordes rotos sin engordar la silueta. */
const close = (mask, w, h) => erode(dilate(mask, w, h), w, h);

/** Mayor componente conexa (8 direcciones). */
function largestComponent(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = -1, bestArea = 0, label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    let sp = 0, area = 0;
    stack[sp++] = start;
    labels[start] = label;

    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] === 1 && labels[q] === -1) { labels[q] = label; stack[sp++] = q; }
        }
      }
    }
    if (area > bestArea) { bestArea = area; best = label; }
    label++;
  }
  return { labels, best, area: bestArea };
}

function bboxOf(labels, label, w, h) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== label) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

// ───────────────────────────────────────────────── geometría del quad

/**
 * Envolvente convexa (cadena monotónica de Andrew).
 * También sirve para tirar los huecos: el texto interior nunca está en el hull.
 */
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Caja mínima de un polígono (rotating calipers sobre los lados del hull).
 * Las direcciones candidatas tienen que ser las aristas reales del polígono:
 * con parejas arbitrarias de puntos el resultado sería la caja axis-aligned,
 * que es justo lo que no queremos con un documento torcido.
 */
function minAreaRect(pts) {
  const poly = convexHull(pts);
  if (poly.length < 3) return null;

  let best = null;
  let bestArea = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(-ang);
    const s = Math.sin(-ang);
    const rot = poly.map((q) => {
      const dx = q.x - a.x;
      const dy = q.y - a.y;
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of rot) {
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      bestArea = area;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      best = {
        area,
        corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([px, py]) => ({
          x: a.x + px * ca - py * sa,
          y: a.y + px * sa + py * ca,
        })),
      };
    }
  }
  return best;
}

/** Ordena 4 puntos como TL, TR, BR, BL. */
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    if (p.x + p.y < best) { best = p.x + p.y; start = i; }
  });
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/**
 * Refina las 4 esquinas. Para cada lado recorre puntos buscando el borde en
 * la perpendicular; ajusta una recta por mínimos cuadrados con un pase de
 * descarte de outliers. Cada esquina es el cruce de las rectas de los dos
 * lados que la comparten.
 *
 * `nx, ny` es la normal (sirve para desplazar el punto); `dx, dy` es la
 * dirección de la recta (sirve para cortarla). No son lo mismo.
 */
function refineQuad(quad, grad, gw, gh, sx, sy, maxShift) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const SAMPLES = 48;
  const lines = [];

  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 10) {
      lines.push({ px: a.x, py: a.y, dx: 1, dy: 0 });
      continue;
    }

    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    let nx = -dy;
    let ny = dx;
    if (nx * (a.x - cx) + ny * (a.y - cy) < 0) { nx = -nx; ny = -ny; }

    const pairs = [];
    for (let s = 0; s <= SAMPLES; s++) {
      const t = s / SAMPLES;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;

      const gradAt = (d) => {
        const qx = clamp(Math.round((px + nx * d) * sx), 1, gw - 2);
        const qy = clamp(Math.round((py + ny * d) * sy), 1, gh - 2);
        return grad[qy * gw + qx];
      };

      // Búsqueda del borde. No sirve con el gradiente más fuerte: el margen
      // izquierdo del texto forma una arista vertical muy alineada que puede
      // ser más marcada que el propio borde del papel, y el refinado se
      // quedaría enganchado ahí, metiendo el recorte hacia dentro. El borde
      // del papel es siempre el pico más externo, así que se recorre de fuera
      // hacia dentro y se toma el primero que sea fuerte de verdad.
      const lo = Math.round(-maxShift);
      const hi = Math.round(maxShift);
      let top = 0;
      for (let d = lo; d <= hi; d++) {
        const v = gradAt(d);
        if (v > top) top = v;
      }
      if (top < 0.04) continue;

      let bestOff = 0;
      for (let d = hi; d >= lo; d--) {
        const v = gradAt(d);
        if (v < top * 0.6) continue;
        if (v >= gradAt(d - 1) && v >= gradAt(d + 1)) { bestOff = d; break; }
      }
      pairs.push([t, bestOff]);
    }

    if (pairs.length < 8) {
      lines.push({ px: a.x + (b.x - a.x) / 2, py: a.y + (b.y - a.y) / 2, dx, dy });
      continue;
    }

    let slope = 0;
    let intercept = 0;
    for (let pass = 0; pass < 2; pass++) {
      const N = pairs.length;
      let st = 0;
      let so = 0;
      for (const [t, o] of pairs) { st += t; so += o; }
      const mt = st / N;
      const mo = so / N;
      let num = 0;
      let den = 0;
      for (const [t, o] of pairs) { num += (t - mt) * (o - mo); den += (t - mt) ** 2; }
      slope = den > 1e-9 ? num / den : 0;
      intercept = mo - slope * mt;
      const err = pairs.map(([t, o]) => Math.abs(o - (slope * t + intercept)));
      const sortedErr = [...err].sort((x, y) => x - y);
      const med = sortedErr[sortedErr.length >> 1] || 0;
      const kept = pairs.filter((_, k) => err[k] <= med * 2 + 0.5);
      if (kept.length >= 8) pairs.splice(0, pairs.length, ...kept);
    }

    // desplazamiento en el punto medio del lado (t = 0.5)
    const off = slope * 0.5 + intercept;
    lines.push({
      px: a.x + (b.x - a.x) / 2 + nx * off,
      py: a.y + (b.y - a.y) / 2 + ny * off,
      dx, dy,
    });
  }

  // cada esquina es el cruce de las dos rectas de los lados que la comparten
  return lines.map((l, i) => {
    const prev = lines[(i + 3) % 4];
    const next = lines[(i + 1) % 4];
    return intersect(l, prev) || intersect(l, next) || { x: l.px, y: l.py };
  });
}

function intersect(l1, l2) {
  const den = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(den) < 1e-9) return null;
  const dx = l2.px - l1.px;
  const dy = l2.py - l1.py;
  const t = (dx * l2.dy - dy * l2.dx) / den;
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
}

// ─────────────────────────────────────────────────────── detección

/**
 * Detecta el documento en una imagen.
 * @param {CanvasImageSource} image
 * @returns {Promise<{corners:{x:number,y:number}[], confidence:number,
 *                   width:number, height:number, orientation:string}|null>}
 *          Las esquinas vienen en píxeles de la imagen original.
 */
export async function detectDocument(image) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return null;

  const scale = Math.min(1, WORK / Math.max(iw, ih));
  const w = Math.max(8, Math.round(iw * scale));
  const h = Math.max(8, Math.round(ih * scale));
  const ctx = drawScaled(image, w, h).getContext('2d', { willReadFrequently: true });

  const gray = blur(grayOf(ctx, w, h), w, h, 2);
  const grad = sobel(gray, w, h);
  const thr = otsu(gray);

  // (a) el papel es la zona más clara
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < bright.length; i++) bright[i] = gray[i] > thr ? 1 : 0;
  const candA = clean(bright, w, h);

  // (b) bordes: cubre documento oscuro o fondo claro
  const edges = new Uint8Array(w * h);
  for (let i = 0; i < edges.length; i++) edges[i] = grad[i] > 0.16 ? 1 : 0;
  const filled = fillHoles(dilate(dilate(edges, w, h), w, h), w, h);
  const candB = clean(filled, w, h);

  const pick = pickBest(candA, candB, w, h);
  if (!pick) return null;

  // el refinado fino trabaja en píxeles de la imagen original
  const fw = Math.min(iw, WORK * 2);
  const fh = Math.min(ih, WORK * 2);
  const fctx = drawScaled(image, fw, fh).getContext('2d', { willReadFrequently: true });
  const fullGrad = sobel(blur(grayOf(fctx, fw, fh), fw, fh, 1), fw, fh);

  // `pick.quad` viene en coordenadas del lienzo de trabajo
  const k = 1 / scale;
  const quad = orderCorners(pick.quad).map((p) => ({ x: p.x * k, y: p.y * k }));
  const maxShift = Math.max(iw, ih) * 0.045;
  const refined = refineQuad(quad, fullGrad, fw, fh, fw / iw, fh / ih, maxShift);

  const corners = refined.map((p) => ({
    x: clamp(p.x, 0, iw - 1),
    y: clamp(p.y, 0, ih - 1),
  }));

  return {
    corners,
    confidence: clamp((polyArea(corners) / (iw * ih)) * 1.4, 0, 1),
    width: iw,
    height: ih,
  };
}

/** Cierra la máscara y devuelve el quad de la mayor componente útil. */
function clean(mask, w, h) {
  const m = close(mask, w, h);
  const { labels, best, area } = largestComponent(m, w, h);
  const total = w * h;
  if (best < 0 || area < total * 0.06 || area > total * 0.96) return null;

  const { x0, y0, x1, y1 } = bboxOf(labels, best, w, h);
  const pts = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (labels[y * w + x] !== best) continue;
      const border =
        x === x0 || x === x1 || y === y0 || y === y1 ||
        labels[y * w + x - 1] !== best || labels[y * w + x + 1] !== best ||
        labels[(y - 1) * w + x] !== best || labels[(y + 1) * w + x] !== best;
      if (border) pts.push({ x, y });
    }
  }
  if (pts.length < 8) return null;
  const rect = minAreaRect(pts);
  return rect ? { quad: rect.corners, area } : null;
}

/** Rellena los huecos interiores de una máscara de bordes. */
function fillHoles(mask, w, h) {
  const out = new Uint8Array(mask);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;

  const seed = (x, y) => {
    const i = y * w + x;
    if (mask[i] || seen[i]) return;
    seen[i] = 1; stack[sp++] = i;
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        seed(nx, ny);
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (!seen[i]) out[i] = 1;
  return out;
}

function pickBest(a, b, w, h) {
  const ok = (c) => c && c.area > w * h * 0.06 && c.area < w * h * 0.96;
  if (ok(a) && ok(b)) return b.area > a.area * 1.25 ? b : a;
  return ok(a) ? a : ok(b) ? b : null;
}

const polyArea = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
};

/**
 * Dirección en la que corre el texto, por perfil de proyección.
 *
 * Se proyecta la tinta (no el gradiente) sobre cada eje y se compara la
 * varianza de ambos perfiles. Con el texto en horizontal la tinta se
 * reparte en pocas filas y el perfil por filas sale mucho más irregular;
 * en vertical, al revés. El margen izquierdo común a todas las líneas no
 * falsea el resultado porque queda repartido entre filas y columnas igual.
 *
 * Conviene medirlo sobre la página ya enderezada: sobre la foto entera el
 * texture de la mesa introduce bordes que no dicen nada del texto.
 *
 * @returns {'landscape'|'portrait'} 'landscape' = el texto corre en horizontal
 */
export function estimateOrientation(image) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const scale = Math.min(1, 400 / Math.max(iw, ih));
  const w = Math.max(8, Math.round(iw * scale));
  const h = Math.max(8, Math.round(ih * scale));
  const ctx = drawScaled(image, w, h).getContext('2d', { willReadFrequently: true });

  const gray = blur(grayOf(ctx, w, h), w, h, 2);
  const thr = otsu(gray);

  const row = new Float32Array(h);
  const col = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] > thr) continue;   // papel
      row[y] += 1;
      col[x] += 1;
    }
  }
  for (let y = 0; y < h; y++) row[y] /= w;
  for (let x = 0; x < w; x++) col[x] /= h;

  const variance = (arr) => {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    let acc = 0;
    for (const v of arr) acc += (v - mean) ** 2;
    return acc / arr.length;
  };

  return variance(row) > variance(col) ? 'landscape' : 'portrait';
}

// ───────────────────────────────────────────── transformación perspectiva

/** Homografía (3×3, fila mayor) que lleva `src` a `dst`. */
function perspectiveMatrix(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const u = dst[i].x, v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Gauss-Jordan con pivoteo parcial y normalización de fila.
 *
 * Con cuatro correspondencias se puede dar el caso de un sistema
 * dependiente (p. ej. un cuadrilátero muy simétrico): las variables libres
 * se fijan a cero, que es la solución mínima y la correcta aquí.
 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }

    if (Math.abs(M[piv][c]) < 1e-12) {
      // columna degenerada: la variable queda libre y se anula su columna
      for (let r = 0; r < n; r++) M[r][c] = 0;
      continue;
    }

    [M[c], M[piv]] = [M[piv], M[c]];
    const p = M[c][c];
    for (let k = c; k <= n; k++) M[c][k] /= p;

    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }

  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (Math.abs(M[i][i]) > 1e-12) out[i] = M[i][n];
  }
  return out;
}

function invert3x3([a, b, c, d, e, f, g, h, i]) {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
    (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
    (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ];
}

/**
 * Rectifica un cuadrilátero: mapea la región delimitada por `corners`
 * (TL, TR, BR, BL) a un rectángulo de `outW` de ancho, con bilineal.
 * La altura sale de la relación de aspecto real del cuadrilátero.
 */
export function rectify(source, corners, outW = 1600) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;

  const side = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const avgW = (side(corners[0], corners[1]) + side(corners[3], corners[2])) / 2;
  const avgH = (side(corners[0], corners[3]) + side(corners[1], corners[2])) / 2;
  // outW cubre el ancho del papel, así que el alto sale de su proporción
  const outH = clamp(Math.round(outW * (avgH / Math.max(1, avgW))), 64, 8000);

  const inv = invert3x3(perspectiveMatrix(corners, [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH },
  ]));
  if (!inv) return null;

  const sctx = drawScaled(source, sw, sh).getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, sw, sh).data;

  const out = makeCanvas(outW, outH);
  const octx = out.getContext('2d');
  const img = octx.createImageData(outW, outH);
  const px = img.data;

  for (let y = 0; y < outH; y++) {
    const v = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const u = x + 0.5;
      const o = (y * outW + x) * 4;
      const wq = inv[6] * u + inv[7] * v + inv[8];
      const qx = (inv[0] * u + inv[1] * v + inv[2]) / wq;
      const qy = (inv[3] * u + inv[4] * v + inv[5]) / wq;

      if (qx < 0 || qy < 0 || qx >= sw - 1 || qy >= sh - 1) {
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 255;
        continue;
      }
      const x0 = qx | 0, y0 = qy | 0;
      const fx = qx - x0, fy = qy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4;
      const i01 = i00 + sw * 4, i11 = i01 + 4;
      const wx = 1 - fx;
      for (let c = 0; c < 3; c++) {
        const up = src[i00 + c] * wx + src[i10 + c] * fx;
        const dn = src[i01 + c] * wx + src[i11 + c] * fx;
        px[o + c] = up * (1 - fy) + dn * fy;
      }
      px[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}