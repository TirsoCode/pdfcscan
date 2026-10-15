/**
 * imageops.js — Transformaciones y filtros de página.
 */

export const FILTERS = {
  original: { label: 'Original', css: 'none' },
  gray: { label: 'Gris', css: 'grayscale(1) contrast(1.12)' },
  document: { label: 'Documento', css: 'grayscale(1) contrast(1.55) brightness(1.06)' },
  vivid: { label: 'Color', css: 'saturate(1.4) contrast(1.06)' },
};

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c) {
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Rota en pasos de 90° (0, 90, 180, 270). */
export function rotateCanvas(source, degrees) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const quarter = ((Math.round(degrees / 90) % 4) + 4) % 4;
  if (quarter === 0) return source;

  const swap = quarter % 2 === 1;
  const out = newCanvas(swap ? sh : sw, swap ? sw : sh);
  const ctx = ctx2d(out);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(source, -sw / 2, -sh / 2);
  return out;
}

/** Aplica un filtro con `ctx.filter`, con degradación si no está soportado. */
export function applyFilter(source, filter = 'original') {
  const def = FILTERS[filter] || FILTERS.original;
  if (def.css === 'none') return source;

  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const out = newCanvas(sw, sh);
  const ctx = ctx2d(out);

  if (typeof ctx.filter === 'string') {
    ctx.filter = def.css;
    ctx.drawImage(source, 0, 0);
    ctx.filter = 'none';
  } else {
    // Respaldo: se dibuja sin filtro y se ajusta canal a canal.
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, sw, sh);
    const px = img.data;
    const gray = filter !== 'vivid';
    for (let i = 0; i < px.length; i += 4) {
      const g = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      if (gray) {
        px[i] = px[i + 1] = px[i + 2] = g;
        if (filter === 'document') px[i] = px[i + 1] = px[i + 2] = clamp255((g - 128) * 1.55 + 128);
      } else {
        const mean = (px[i] + px[i + 1] + px[i + 2]) / 3;
        px[i] = clamp255(px[i] * 1.4 + (mean - px[i]) * 0.4);
        px[i + 1] = clamp255(px[i + 1] * 1.4 + (mean - px[i + 1]) * 0.4);
        px[i + 2] = clamp255(px[i + 2] * 1.4 + (mean - px[i + 2]) * 0.4);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return out;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Normaliza cualquier CanvasImageSource a un canvas. */
export function toCanvas(source) {
  if (source && typeof source.toBlob === 'function') return source;
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const out = newCanvas(sw, sh);
  ctx2d(out).drawImage(source, 0, 0);
  return out;
}

/** Reduce la imagen para que ningún lado pase de `maxDim` px. */
export function clampSize(source, maxDim) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const longest = Math.max(sw, sh);
  if (longest <= maxDim) return source;

  const k = maxDim / longest;
  const out = newCanvas(sw * k, sh * k);
  ctx2d(out).drawImage(source, 0, 0, out.width, out.height);
  return out;
}

/**
 * Compone la versión final de una página: rotación + filtro + límite
 * de resolución, en el orden en que se aplican.
 */
export function renderPage(plain, { rotation = 0, filter = 'original', maxDim = 2800 } = {}) {
  return clampSize(applyFilter(rotateCanvas(plain, rotation), filter), maxDim);
}

/** Miniatura cuadrada para la rejilla de páginas. */
export function thumbnail(source, size = 260) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const k = size / Math.max(sw, sh);
  const out = newCanvas(sw * k, sh * k);
  ctx2d(out).drawImage(source, 0, 0, out.width, out.height);
  return out;
}

export function canvasToDataURL(source, quality = 0.8) {
  return source.toDataURL('image/jpeg', quality);
}