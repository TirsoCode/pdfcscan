/**
 * app.js — Orquestación: ingesta de fotos, editor y generación del PDF.
 */

import { detectDocument, rectify, loadImage, estimateOrientation } from './detect.js';
import { Cropper } from './cropper.js';
import { Camera, cameraSupported } from './camera.js';
import {
  FILTERS, renderPage, thumbnail, clampSize, canvasToDataURL, toCanvas,
} from './imageops.js';
import { buildPdf, PAGE_SIZES, PT_TO_CM, canvasToJpeg } from './pdf.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ═══════════════════════════════════════════════════════════ resolución ══
//
// Estos topes deciden la nitidez final. A4 mide 29,7 cm de alto: con 2600 px
// salen 222 DPI (calidad de impresión de sobra), y en A5 se alcanzan los
// 300 DPI completos. Con los 1800 px de antes eran 154 DPI y el texto se veía
// blando; subirlo cuesta memoria, que es el precio que paga el móvil.
const MAX_SOURCE = 2600;  // solo para reabrir el recorte manual, no para el PDF
const MAX_PLAIN = 2600;   // lado mayor de la página ya enderezada
const MAX_RENDER = 2800;  // tope del lienzo compuesto al generar el PDF
const THUMB_DIM = 700;     // las miniaturas no necesitan la resolución final

// La captura de una web entera llega como una imagen muy alta; a partir de
// este tamaño se reduce para no reservar cientos de MB en el móvil.
const MAX_CAPTURE_PIXELS = 42e6;

const LS_KEY = 'fotoapdf.settings.v1';

const state = {
  pages: [],
  settings: {
    pageSize: 'a4',
    orientation: 'auto',
    fit: 'contain',
    marginCm: 1,
    quality: 0.92,
    numbers: true,
    filter: 'original',
    autoCrop: true,
  },
  bytesPerPage: 0,
  editingId: null,
};

const thumbCache = new Map();

const els = {};
let camera = null;
let cropper = null;

document.addEventListener('DOMContentLoaded', init);

// ═══════════════════════════════════════════════════════════ arranque

function init() {
  Object.assign(els, {
    start: $('#screen-start'),
    editor: $('#screen-editor'),
    pages: $('#pages'),
    statPages: $('#stat-pages'),
    estimate: $('#estimate'),
    toasts: $('#toasts'),
    busy: $('#busy'),
    busyText: $('#busy-text'),
    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    urlInput: $('#url-input'),
    title: $('#doc-title'),
    settings: $('#settings'),
  });

  buildSettingControls();
  loadSettings();
  wireEvents();
  els.pages.addEventListener('click', onCardClick);
  renderSettings();
  renderPages();
  initSortable(els.pages);
  initTabs();
  registerServiceWorker();
}

/**
 * Cachea el armazón para poder usarlo sin conexión. En localhost no se
 * registra, que si no el service worker sirve la versión anterior del
 * código mientras se desarrolla.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (['localhost', '127.0.0.1', ''].includes(location.hostname)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin caché, sin drama */ });
  });
}

function wireEvents() {
  const openPicker = () => els.fileInput.click();
  $('#btn-camera').addEventListener('click', openCamera);
  $('#btn-files').addEventListener('click', openPicker);
  $('#btn-add').addEventListener('click', openPicker);
  $('#add-more').addEventListener('click', openPicker);
  $('#btn-download').addEventListener('click', download);
  $('#btn-print').addEventListener('click', printPdf);
  $('#btn-reset').addEventListener('click', resetAll);

  $('#panel-toggle').addEventListener('click', () => {
    const open = els.settings.classList.toggle('open');
    $('#panel-toggle').setAttribute('aria-expanded', String(open));
  });

  els.fileInput.addEventListener('change', (e) => {
    ingestFiles(e.target.files);
    e.target.value = '';
  });
  els.title.addEventListener('input', saveSettings);

  // entrada por URL: también con Enter dentro del campo
  $('#btn-url').addEventListener('click', ingestUrl);
  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    ingestUrl();
  });
  els.urlInput.addEventListener('paste', () => {
    // un pegado con URL se envía solo: el caso normal es pegar y ya
    setTimeout(() => { if (els.urlInput.value.trim()) ingestUrl(); }, 60);
  });

  els.dropzone.addEventListener('click', openPicker);
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });

  // El comparador visual se inicializa en js/demo.js

  // arrastrar y soltar en cualquier punto de la página
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      els.dropzone.classList.add('hot');
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    document.addEventListener(type, (e) => {
      if (!els.dropzone.contains(e.relatedTarget)) els.dropzone.classList.remove('hot');
    });
  }
  document.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    els.dropzone.classList.remove('hot');
    if (e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
  });

  // modales
  $('#btn-cam-close').addEventListener('click', closeCamera);
  $('#btn-cam-flip').addEventListener('click', flipCamera);
  $('#btn-cam-from-file').addEventListener('click', () => { closeCamera(); openPicker(); });
  $('#btn-shot').addEventListener('click', shoot);
  $('#btn-crop-cancel').addEventListener('click', closeCrop);
  $('#btn-crop-apply').addEventListener('click', applyCrop);
  $('#btn-crop-auto').addEventListener('click', recropAuto);
  $('#btn-crop-full').addEventListener('click', useFullRect);

  $('#modal-camera').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCamera();
  });
  $('#modal-crop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCrop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-crop').hidden) closeCrop();
      else if (!$('#modal-camera').hidden) closeCamera();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.editor.hidden) {
      e.preventDefault();
      download();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.pages.length) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ════════════════════════════════════════════════════════ ajustes ══

function buildSettingControls() {
  const size = $('#set-size');
  for (const [key, def] of Object.entries(PAGE_SIZES)) {
    const cm = (pt) => Math.round((pt / 72) * 2.54);
    size.add(new Option(`${def.label} · ${cm(def.w)}×${cm(def.h)} cm`, key));
  }

  const radios = (sel, onPick) => {
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) onPick(b.dataset.value);
    });
  };

  const filters = $('#set-filter');
  for (const [key, def] of Object.entries(FILTERS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = key;
    b.textContent = def.label;
    filters.append(b);
  }

  radios('#set-filter', (value) => {
    state.settings.filter = value;
    thumbCache.clear();
    commitSettings();
    renderPages();
  });
  radios('#set-orient', (value) => {
    state.settings.orientation = value;
    commitSettings();
  });

  const bind = (sel, key, parse) => {
    $(sel).addEventListener('input', (e) => {
      state.settings[key] = parse(e.target.value);
      commitSettings();
    });
  };
  bind('#set-size', 'pageSize', String);
  bind('#set-fit', 'fit', String);
  bind('#set-margin', 'marginCm', Number);
  bind('#set-quality', 'quality', (v) => Number(v) / 100);
  $('#set-numbers').addEventListener('change', (e) => {
    state.settings.numbers = e.target.checked;
    commitSettings();
  });
  $('#set-autocrop').addEventListener('change', (e) => {
    state.settings.autoCrop = e.target.checked;
    commitSettings();
  });
}

function commitSettings() {
  renderSettings();
  saveSettings();
}

function renderSettings() {
  const s = state.settings;
  $('#set-size').value = s.pageSize;
  $('#set-fit').value = s.fit;
  $('#set-margin').value = s.marginCm;
  $('#set-quality').value = Math.round(s.quality * 100);
  $('#set-numbers').checked = s.numbers;
  $('#set-autocrop').checked = s.autoCrop;

  for (const b of $$('#set-orient button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === s.orientation));
  }
  for (const b of $$('#set-filter button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === s.filter));
  }

  $('#out-margin').textContent = `${s.marginCm.toFixed(1).replace('.', ',')} cm`;
  $('#out-quality').textContent =
    s.quality >= 0.9 ? 'Máxima' : s.quality >= 0.75 ? 'Alta' : s.quality >= 0.6 ? 'Media' : 'Baja';
  renderEstimate();
}

function renderEstimate() {
  const s = state.settings;
  const orient = { auto: 'auto', portrait: 'vertical', landscape: 'horizontal' }[s.orientation];
  const pages = `${state.pages.length} ${state.pages.length === 1 ? 'página' : 'páginas'}`;
  const base = `${pages} · ${PAGE_SIZES[s.pageSize].label} ${orient}`;
  els.estimate.textContent = state.bytesPerPage
    ? `${base} · ≈ ${formatBytes(state.bytesPerPage * state.pages.length)}`
    : base;
}

function saveSettings() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ ...state.settings, title: els.title.value }));
  } catch { /* modo privado o cuota llena */ }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (PAGE_SIZES[d.pageSize]) state.settings.pageSize = d.pageSize;
    if (['auto', 'portrait', 'landscape'].includes(d.orientation)) state.settings.orientation = d.orientation;
    if (typeof d.fit === 'string') state.settings.fit = d.fit;
    if (Number.isFinite(d.marginCm)) state.settings.marginCm = Math.min(3, Math.max(0, d.marginCm));
    if (Number.isFinite(d.quality)) state.settings.quality = Math.min(0.98, Math.max(0.5, d.quality));
    if (typeof d.numbers === 'boolean') state.settings.numbers = d.numbers;
    if (FILTERS[d.filter]) state.settings.filter = d.filter;
    if (typeof d.title === 'string' && d.title) els.title.value = d.title;
  } catch { /* ajustes corruptos: seguimos con los de fábrica */ }
}

// ════════════════════════════════════════════════════════ ingesta ══

async function ingestFiles(files) {
  const list = [...files].filter(
    (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name),
  );
  if (!list.length) {
    toast('Solo se aceptan imágenes.', 'error');
    return;
  }

  busy('Preparando imágenes…');
  try {
    // con el ajuste automático se busca el papel en cada foto, que es justo
    // lo que espera quien sube una foto hecha con el móvil
    const auto = state.settings.autoCrop;
    for (let i = 0; i < list.length; i++) {
      busy(`Procesando ${i + 1} de ${list.length}…`);
      await tick();
      try {
        await addPage(await decodeImage(list[i]), { autoCrop: auto });
      } catch (err) {
        console.error(err);
        toast(`No se pudo leer «${list[i].name}». Si es HEIC, pásala a JPG.`, 'error');
      }
    }
    showEditor();
  } finally {
    hideBusy();
  }
}

/**
 * Añade contenido a partir de su dirección pública. Hay dos caminos y se
 * distinguen por la extensión:
 *
 *  · una URL que acaba en .jpg/.png/... se descarga tal cual;
 *  · cualquier otra cosa se trata como una página web y se captura entera.
 *
 * La captura de una web es el único punto donde sale algo del dispositivo:
 * el navegador no puede fotografiar una página ajena por sí solo, así que se
 * pide a un servicio externo. Se avisa de ello en la interfaz.
 */
async function ingestUrl() {
  const raw = els.urlInput.value.trim();
  if (!raw) {
    toast('Pega antes una dirección de imagen o de web.', 'error');
    els.urlInput.focus();
    return;
  }

  let url;
  try {
    url = normalizeUrl(raw);
  } catch {
    toast('Esa dirección no es válida. Debe empezar por http:// o https://.', 'error');
    return;
  }

  const isImage = IMAGE_URL_RE.test(new URL(url).pathname);
  $('#btn-url').disabled = true;

  try {
    if (isImage) {
      busy('Descargando la imagen…');
      const blob = await fetchImage(url);
      busy('Procesando imagen…');
      await tick();
      await addPage(await decodeImage(blob), { autoCrop: false, origin: 'image' });
      showEditor();
      toast('Imagen añadida.', 'ok');
    } else {
      const pages = await captureWebPage(url);
      showEditor();
      const n = pages.length;
      toast(
        n === 1 ? 'Página capturada.' : `${n} páginas capturadas de la web.`,
        'ok',
      );
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'No se ha podido añadir ese contenido.', 'error');
  } finally {
    hideBusy();
    $('#btn-url').disabled = false;
    els.urlInput.value = '';
  }
}

const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?)$/i;

/** Acepta `ejemplo.com/foto.jpg` y le pone el esquema que falte. */
function normalizeUrl(raw) {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = new URL(withScheme);   // `new URL` ya valida la forma de la dirección
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('esquema no permitido');
  // sin exigir un punto en el dominio: localhost y las IP también valen, y son
  // justo los casos que se usan en desarrollo
  if (!u.hostname) throw new Error('sin dominio');
  return u.href;
}

/**
 * Descarga una imagen. `timeoutMs` importa: el servicio de captura de webs
 * se cuelga con facilidad (una página que tarda en cargar nunca termina), y
 * sin un tope el usuario se queda mirando el spinner indefinidamente.
 */
async function fetchImage(url, timeoutMs = 20000) {
  let res;
  try {
    res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(
        'El servidor ha tardado demasiado y se ha cancelado la petición. '
        + 'Si es una web, prueba con una página más ligera.',
      );
    }
    throw new Error(
      'El navegador no ha podido leer esa imagen. Casi siempre es porque el '
      + 'servidor no permite accesos externos (CORS): descarga la foto y '
      + 'arrástrala aquí.',
    );
  }

  if (!res.ok) {
    throw new Error(`El servidor respondió ${res.status}. Comprueba el enlace.`);
  }

  const type = res.headers.get('content-type') || '';
  if (type && !type.startsWith('image/')) {
    throw new Error('Esa dirección no apunta a una imagen.');
  }

  const blob = await res.blob();
  if (!blob.size) throw new Error('La imagen llegó vacía.');
  return blob;
}

// ════════════════════════════════════════════════ captura de páginas web ══

const CAPTURE_WIDTH = 1400;
// Alto de cada trozo: proporción A4 vertical, para que al imprimir coincida
// con el resto del documento y no haya que encoger una tira larguísima.
const SLICE_HEIGHT = Math.round(CAPTURE_WIDTH * (297 / 210));

/**
 * El navegador no puede leer el DOM de otra web (lo bloquea el origen), así
 * que la captura la hace un servicio externo. `fullpage` es lo que devuelve
 * la página entera y no solo lo que se ve en pantalla.
 */
function captureUrl(pageUrl) {
  return `https://image.thum.io/get/fullpage/width/${CAPTURE_WIDTH}`
    + `/noanimate/${pageUrl}`;
}

async function captureWebPage(pageUrl) {
  busy('Capturando la página web…');
  await tick();

  // margen amplio: capturar una web larga de verdad lleva su tiempo
  const blob = await fetchImage(captureUrl(pageUrl), 60000);

  busy('Recortando la captura…');
  await tick();

  let canvas = toCanvas(await decodeImage(blob));
  canvas = fitCapture(canvas);

  const slices = sliceTall(canvas);
  if (canvas !== slices.canvas) canvas.width = canvas.height = 0;

  for (const slice of slices.pages) {
    await addPage(slice, { autoCrop: false, origin: 'web' });
  }
  return slices.pages;
}

/**
 * Una captura muy alta puede ocupar cientos de MB. Si se pasa del límite se
 * reduce manteniendo la proporción y se avisa, porque el recorte manual ya no
 * podrá devolver el detalle perdido.
 */
function fitCapture(canvas) {
  const pixels = canvas.width * canvas.height;
  if (pixels <= MAX_CAPTURE_PIXELS) return canvas;

  const k = Math.sqrt(MAX_CAPTURE_PIXELS / pixels);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * k);
  out.height = Math.round(canvas.height * k);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/** Trocea una captura vertical en páginas con proporción de A4. */
function sliceTall(source) {
  const w = source.width;
  const h = source.height;
  const pages = [];

  for (let y = 0; y < h; y += SLICE_HEIGHT) {
    const hh = Math.min(SLICE_HEIGHT, h - y);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, y, w, hh, 0, 0, w, hh);
    pages.push(c);
  }

  return { pages, canvas: source };
}

/**
 * Añade una página. Con `autoCrop` busca el papel y lo endereza; sin él
 * respeta el encuadre tal cual, que es lo que espera quien sube una foto
 * que ya está cuadrada.
 */
async function addPage(source, { autoCrop, origin = 'file' }) {
  let plain = null;
  let rotation = 0;
  let detected = false;

  // `source` puede ser un ImageBitmap, que no sabe convertir solo a JPEG
  const base = toCanvas(source);

  if (autoCrop) {
    const det = await detectDocument(base);
    if (det && det.confidence > 0.12) {
      const rect = rectify(base, det.corners, MAX_PLAIN);
      if (rect) {
        plain = rect;
        detected = true;
        // Solo se corrige el móvil torcido cuando las dos señales coinciden:
        // la hoja sale apaisada y el texto corre de lado. Con una sola de
        // las dos basta para girar un documento apaisado de verdad.
        const shapeIsWide = rect.width > rect.height;
        const textIsSideways = estimateOrientation(rect) === 'portrait';
        if (shapeIsWide && textIsSideways) rotation = 90;
      }
    }
  }

  if (!plain) plain = clampSize(base, MAX_PLAIN);

  state.pages.push({
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    // El original guardado solo se usa al reabrir el recorte manual, así que
    // no necesita la resolución del PDF: 2600 px y q0.90 van sobrados para un
    // lienzo de recorte y cuestan la mitad que 3200 px a q0.94.
    sourceBlob: await canvasToJpeg(clampSize(base, MAX_SOURCE), 0.9),
    plain,
    rotation,
    detected,
    origin,
  });
  renderPages();
  renderEstimate();
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* ciertos formatos solo los lee <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// ════════════════════════════════════════════════════════ pestañas ══════

/**
 * Pestañas de "cómo funciona". ARIA de verdad: roles, `aria-selected` y
 * navegación con flechas, que es lo que espera quien use el teclado.
 */
function initTabs() {
  const tablist = $('.tablist');
  if (!tablist) return;

  const tabs = $$('.tab', tablist);

  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };

  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) select(tab);
  });

  tablist.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;

    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;

    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ════════════════════════════════════════════════════════ editor ════

function showEditor() {
  if (!state.pages.length) return;
  els.start.hidden = true;
  els.editor.hidden = false;
  renderPages();
}

function resetAll() {
  if (!confirm('¿Borrar todas las páginas y empezar de cero?')) return;
  state.pages = [];
  thumbCache.clear();
  renderPages();
  els.editor.hidden = true;
  els.start.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const icon = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

const ICONS = {
  rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
};

/**
 * Vista previa de una página con su rotación y el filtro global.
 *
 * `maxDim` permite pintar la miniatura a resolución baja: rotar y filtrar a
 * 2600 px solo para encoger luego a 300 era el grueso del trabajo de la
 * rejilla, y con muchas pages se nota.
 */
function previewOf(page, maxDim = MAX_RENDER) {
  return renderPage(page.plain, {
    rotation: page.rotation,
    filter: state.settings.filter,
    maxDim,
  });
}

function thumbFor(page) {
  const key = `${page.id}:${page.rotation}:${state.settings.filter}:${page.plain.width}`;
  if (!thumbCache.has(key)) {
    const small = previewOf(page, THUMB_DIM);
    thumbCache.set(key, canvasToDataURL(thumbnail(small, 300), 0.72));
    if (small !== page.plain) small.width = small.height = 0;  // liberar ya
  }
  return thumbCache.get(key);
}

/** Distintivo de la esquina: de dónde salió la página y si se enderezó sola. */
function pageBadge(page) {
  if (page.origin === 'web') return '<span class="card-badge">web</span>';
  if (page.origin === 'camera' && page.detected) return '<span class="card-badge">auto</span>';
  if (page.detected) return '<span class="card-badge">auto</span>';
  return '';
}

function renderPages() {
  els.pages.replaceChildren();
  els.statPages.textContent =
    `${state.pages.length} ${state.pages.length === 1 ? 'página' : 'páginas'}`;

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = page.id;
    card.setAttribute('role', 'listitem');

    const img = new Image();
    img.src = thumbFor(page);
    img.alt = `Página ${i + 1}`;
    img.draggable = false;

    card.innerHTML = `
      <button class="card-thumb" type="button" title="Ajustar el recorte">
        <span class="card-no">${i + 1}</span>
        ${pageBadge(page)}
      </button>
      <div class="card-tools">
        <button type="button" data-act="grip" aria-label="Mover página" title="Arrastra para reordenar">${icon(ICONS.grip)}</button>
        <button type="button" data-act="rotate" aria-label="Girar 90 grados" title="Girar 90°">${icon(ICONS.rotate)}</button>
        <button type="button" data-act="copy" aria-label="Duplicar" title="Duplicar">${icon(ICONS.copy)}</button>
        <span class="spacer"></span>
        <button type="button" data-act="del" class="danger" aria-label="Borrar página" title="Borrar">${icon(ICONS.trash)}</button>
      </div>`;
    $('.card-thumb', card).prepend(img);
    frag.append(card);
  });
  els.pages.append(frag);

  const empty = !state.pages.length;
  $('#btn-download').disabled = empty;
  $('#btn-print').disabled = empty;
  renderEstimate();
}

function onCardClick(e) {
  const thumb = e.target.closest('.card-thumb');
  const btn = e.target.closest('button[data-act]');

  if (thumb) { openCrop(thumb.closest('.card').dataset.id); return; }
  if (!btn || btn.dataset.act === 'grip') return;

  const id = btn.closest('.card').dataset.id;
  const index = state.pages.findIndex((p) => p.id === id);
  if (index < 0) return;

  switch (btn.dataset.act) {
    case 'rotate':
      state.pages[index].rotation = (state.pages[index].rotation + 90) % 360;
      renderPages();
      break;
    case 'copy':
      state.pages.splice(index + 1, 0, {
        ...state.pages[index],
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      });
      renderPages();
      break;
    case 'del':
      state.pages.splice(index, 1);
      thumbCache.clear();
      renderPages();
      if (!state.pages.length) {
        els.editor.hidden = true;
        els.start.hidden = false;
      }
      break;
    default:
      break;
  }
}

/**
 * Reordenar arrastrando: el ghost sigue al puntero y un hueco conserva
 * su sitio en la rejilla. Con ratón se puede arrastrar desde la miniatura;
 * con dedo, solo desde el tirador, para no robar el scroll vertical.
 */
function initSortable(container) {
  let drag = null;

  container.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    const card = e.target.closest('.card');
    if (!card) return;
    const fromGrip = !!e.target.closest('[data-act="grip"]');
    const fromThumb = e.pointerType === 'mouse' && !!e.target.closest('.card-thumb');
    if (!fromGrip && !fromThumb) return;

    e.preventDefault();
    const rect = card.getBoundingClientRect();

    const ghost = document.createElement('div');
    ghost.className = 'card';
    ghost.style.cssText =
      `position:fixed;z-index:70;pointer-events:none;width:${rect.width}px;` +
      `left:${rect.left}px;top:${rect.top}px;opacity:.96;` +
      'box-shadow:var(--shadow-lg);transform:scale(1.03) rotate(.5deg)';

    const slot = document.createElement('div');
    slot.className = 'card';
    slot.style.cssText =
      `width:${rect.width}px;height:${rect.height}px;border-style:dashed`;

    // el hueco ocupa el lugar original y la tarjeta sale del flujo
    card.parentElement.insertBefore(slot, card);
    card.remove();
    document.body.append(ghost);

    drag = {
      ghost, slot, card,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      moved: false,
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  });

  function onMove(e) {
    if (!drag) return;
    e.preventDefault();
    drag.moved = true;
    drag.ghost.style.left = `${e.clientX - drag.dx}px`;
    drag.ghost.style.top = `${e.clientY - drag.dy}px`;

    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card');
    if (!under || under === drag.slot) return;

    const rect = under.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    under.parentElement.insertBefore(drag.slot, after ? under.nextSibling : under);
  }

  function onUp() {
    if (!drag) return;
    const { ghost, slot, card, moved } = drag;
    window.removeEventListener('pointermove', onMove);
    slot.replaceWith(card);
    ghost.remove();
    drag = null;
    if (!moved) return;

    const order = $$('.card', container).map((c) => c.dataset.id);
    state.pages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    renderPages();
  }
}

// ════════════════════════════════════════════════════════ recorte ════

async function openCrop(id) {
  const page = state.pages.find((p) => p.id === id);
  if (!page) return;

  busy('Cargando la imagen…');
  let source;
  try {
    source = await decodeImage(page.sourceBlob);
  } catch (err) {
    console.error(err);
    hideBusy();
    toast('No se ha podido recuperar la imagen.', 'error');
    return;
  }
  hideBusy();

  state.editingId = id;
  $('#modal-crop').hidden = false;
  document.body.style.overflow = 'hidden';

  cropper = new Cropper($('#crop-canvas'));
  cropper.source = source;

  const det = await detectDocument(source);
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  cropper.open(source, det && det.confidence > 0.12 ? det.corners : fullRect(sw, sh));

  window.addEventListener('resize', onCropResize);
}

const onCropResize = () => {
  if ($('#modal-crop').hidden) return;
  cropper?.resize();
};

const fullRect = (w, h) => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
];

async function recropAuto() {
  const source = cropper?.source;
  if (!source) return;
  busy('Buscando el papel…');
  const det = await detectDocument(source);
  hideBusy();
  if (!det || det.confidence <= 0.12) {
    toast('No he encontrado los bordes del documento.', 'error');
    return;
  }
  cropper.open(source, det.corners);
}

function useFullRect() {
  const source = cropper?.source;
  if (!source) return;
  cropper.open(source, fullRect(
    source.naturalWidth || source.width,
    source.naturalHeight || source.height,
  ));
}

async function applyCrop() {
  const page = state.pages.find((p) => p.id === state.editingId);
  const out = cropper?.apply(MAX_PLAIN);
  if (!out) {
    toast('El recorte es demasiado pequeño.', 'error');
    return;
  }
  busy('Enderezando…');
  await tick();
  page.plain = out;
  page.rotation = 0;
  page.detected = true;
  thumbCache.clear();
  hideBusy();
  closeCrop();
  renderPages();
}

function closeCrop() {
  $('#modal-crop').hidden = true;
  document.body.style.overflow = '';
  cropper?.source?.close?.();   // los ImageBitmap hay que liberarlos a mano
  cropper?.destroy();
  cropper = null;
  window.removeEventListener('resize', onCropResize);
}

// ════════════════════════════════════════════════════════ cámara ════

let facing = 'environment';

const camTip = () => (facing === 'environment'
  ? 'Coloca el papel dentro del marco, con buena luz.'
  : 'Cámara frontal: útil para un libro o un carné.');

async function openCamera() {
  if (!cameraSupported()) {
    toast('Este navegador no da acceso a la cámara. Usa «Elegir fotos».', 'error');
    els.fileInput.click();
    return;
  }
  $('#modal-camera').hidden = false;
  document.body.style.overflow = 'hidden';

  camera = new Camera($('#video'));
  try {
    await camera.start({ facingMode: facing });
    $('#cam-tip').textContent = camTip();
  } catch (err) {
    toast(err.message, 'error');
    closeCamera();
  }
}

async function flipCamera() {
  if (!camera) return;
  facing = facing === 'environment' ? 'user' : 'environment';
  try {
    await camera.start({ facingMode: facing });
    $('#cam-tip').textContent = camTip();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function shoot() {
  if (!camera?.ready) return;
  const shot = camera.grab(MAX_SOURCE);
  busy('Buscando el papel…');
  await tick();
  try {
    await addPage(shot, { autoCrop: true, origin: 'camera' });
  } catch (err) {
    console.error(err);
    toast('No se ha podido procesar la foto.', 'error');
  } finally {
    hideBusy();
    // el modal sigue abierto para encadenar capturas, pero el editor ya
    // tiene que estar listo detrás
    showEditor();
  }
}

function closeCamera() {
  camera?.stop();
  camera = null;
  $('#modal-camera').hidden = true;
  document.body.style.overflow = '';
}

// ══════════════════════════════════════════════════════════ PDF ════

async function compose() {
  const images = [];
  busy('Generando el PDF…');

  try {
    for (let i = 0; i < state.pages.length; i++) {
      busy(`Componiendo página ${i + 1} de ${state.pages.length}…`);
      await tick();

      const page = state.pages[i];
      const canvas = previewOf(page);
      const { width, height } = canvas;
      // renderPage devuelve la propia página si no hay nada que transformar:
      // en ese caso no se puede liberar el lienzo.
      const disposable = canvas !== page.plain;

      const blob = await canvasToJpeg(canvas, state.settings.quality);
      if (disposable) canvas.width = canvas.height = 0;

      images.push({
        data: new Uint8Array(await blob.arrayBuffer()),
        w: width,
        h: height,
      });
    }

    const blob = buildPdf(images, {
      pageSize: state.settings.pageSize,
      orientation: state.settings.orientation,
      margin: state.settings.marginCm / PT_TO_CM,
      fit: state.settings.fit,
      pageNumbers: state.settings.numbers,
      title: els.title.value.trim() || 'Documento',
    });
    state.bytesPerPage = blob.size / images.length;
    renderEstimate();
    return blob;
  } finally {
    hideBusy();
  }
}

async function download() {
  if (!state.pages.length) return;
  let blob;
  try {
    blob = await compose();
  } catch (err) {
    console.error(err);
    toast('No se ha podido generar el PDF.', 'error');
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(els.title.value) || 'documento'}.pdf`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20000);
  toast(`PDF listo · ${formatBytes(blob.size)}`, 'ok');
}

async function printPdf() {
  if (!state.pages.length) return;
  let blob;
  try {
    blob = await compose();
  } catch (err) {
    console.error(err);
    toast('No se ha podido preparar la impresión.', 'error');
    return;
  }

  const url = URL.createObjectURL(blob);
  const frame = document.createElement('iframe');
  frame.title = 'Vista previa de impresión';
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
  frame.src = url;

  let printed = false;
  const print = () => {
    if (printed) return;
    printed = true;
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank');
    }
  };
  // algunos navegadores no disparan load en un iframe con PDF: el temporizador
  // de respaldo cubre ese caso.
  frame.addEventListener('load', () => setTimeout(print, 250));
  setTimeout(print, 1500);
  setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120000);

  document.body.append(frame);
  toast('Elige la impresora y el número de copias.');
}

// ══════════════════════════════════════════════════════════ UI ═════

function busy(text) {
  els.busyText.textContent = text;
  els.busy.hidden = false;
}

const hideBusy = () => { els.busy.hidden = true; };

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function slugify(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}