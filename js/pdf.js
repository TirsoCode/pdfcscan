/**
 * pdf.js — Generador de PDF mínimo, sin dependencias.
 *
 * Solo incrusta imágenes JPEG (DCTDecode), que es lo que produce
 * <canvas>.toBlob('image/jpeg') en todos los navegadores modernos.
 * Eso evita tener que comprimir/deflatear nada: los content streams
 * van sin filtro (un PDF lo permite) y el resto es bookkeeping de xref.
 */

const enc = new TextEncoder();

/** Tamaños de página en puntos PDF (1 pt = 1/72"). */
export const PAGE_SIZES = {
  a4: { label: 'A4', w: 595.28, h: 841.89 },
  a3: { label: 'A3', w: 841.89, h: 1190.55 },
  carta: { label: 'Carta', w: 612, h: 792 },
  legal: { label: 'Legal', w: 612, h: 1008 },
  a5: { label: 'A5', w: 419.53, h: 595.28 },
  a6: { label: 'A6', w: 297.64, h: 419.53 },
  '4x6': { label: 'Foto 4×6"', w: 288, h: 432 },
  '5x7': { label: 'Foto 5×7"', w: 360, h: 504 },
};

/** Puntos → centímetros (para mostrar márgenes en cm). */
export const PT_TO_CM = 2.54 / 72;

const encStr = (s) => {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
};

/** Escapa literales de cadena PDF. */
const pdfString = (s) =>
  `(${String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;

/** Números cortos: dos decimales sobran para toda la geometría. */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * Convierte un canvas a Blob JPEG.
 * @returns {Promise<Blob>}
 */
export function canvasToJpeg(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo comprimir la imagen'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Calcula la disposición de una imagen dentro de una página.
 *
 * @param {object} size  { w, h } en puntos de la página (ya con orientación)
 * @param {object} image { w, h } dimensiones en píxeles de la imagen
 * @param {object} cfg   { margin, fit }
 * @returns {{x:number,y:number,w:number,h:number,clip?:object}}
 */
export function layoutImage(size, image, cfg) {
  const m = Math.max(0, Math.min(cfg.margin, Math.min(size.w, size.h) / 2 - 1));
  const box = { x: m, y: m, w: size.w - m * 2, h: size.h - m * 2 };
  const ratio = image.w / image.h;

  switch (cfg.fit) {
    // La imagen se imprime a su tamaño natural (72 px = 1 pulgada).
    case 'natural': {
      const w = Math.min(image.w, box.w);
      const h = w / ratio;
      return center(box, w, h);
    }
    case 'width':
      return center(box, box.w, box.w / ratio);
    case 'height':
      return center(box, box.h * ratio, box.h);
    // 'fill' recorta: necesita una ruta de clip en el content stream.
    case 'fill': {
      const scale = Math.max(box.w / image.w, box.h / image.h);
      const w = image.w * scale;
      const h = image.h * scale;
      return { ...center(box, w, h), clip: { x: box.x, y: box.y, w: box.w, h: box.h } };
    }
    case 'contain':
    default: {
      const scale = Math.min(box.w / image.w, box.h / image.h);
      return center(box, image.w * scale, image.h * scale);
    }
  }
}

const center = (box, w, h) => ({
  x: box.x + (box.w - w) / 2,
  y: box.y + (box.h - h) / 2,
  w,
  h,
});

/**
 * Construye el PDF completo.
 *
 * @param {Array<{data: Uint8Array, w: number, h: number}>} images
 *        JPEG crudo + dimensiones en píxeles, en el orden final del PDF.
 * @param {object} opts
 * @param {string} opts.pageSize    clave de PAGE_SIZES
 * @param {'auto'|'portrait'|'landscape'} opts.orientation
 * @param {number} opts.margin      margen en puntos
 * @param {string} [opts.title]
 * @param {boolean} [opts.pageNumbers]
 * @returns {Blob}
 */
export function buildPdf(images, opts) {
  const base = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.a4;
  const pageNumbers = opts.pageNumbers !== false;
  const title = opts.title || 'Documento';

  /** @type {Map<number, {dict: string, stream?: Uint8Array}>} */
  const objects = new Map();
  let nextId = 1;
  const put = (dict, stream) => {
    const id = nextId++;
    objects.set(id, { dict, stream });
    return id;
  };

  const catalogId = put(''); // 1, se rellena al final
  const pagesId = put(''); // 2
  const fontId = pageNumbers
    ? put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    : 0;

  const pageIds = [];

  for (const img of images) {
    const landscape = img.w > img.h;
    const orient =
      opts.orientation === 'auto' || !opts.orientation
        ? landscape
          ? 'landscape'
          : 'portrait'
        : opts.orientation;
    const size = {
      w: orient === 'landscape' ? base.h : base.w,
      h: orient === 'landscape' ? base.w : base.h,
    };

    const box = layoutImage(size, img, opts);
    const name = `Im${pageIds.length}`;

    const imageId = put(
      `<< /Type /XObject /Subtype /Image /Name /${name} ` +
        `/Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>`,
      img.data,
    );

    // Y en PDF crece hacia arriba; la imagen va volteada verticalmente.
    const parts = ['q'];
    if (box.clip) {
      const c = box.clip;
      parts.push(`${n(c.x)} ${n(c.y)} ${n(c.w)} ${n(c.h)} re W n`);
    }
    parts.push(`${n(box.w)} 0 0 ${n(box.h)} ${n(box.x)} ${n(box.y)} cm`);
    parts.push(`/${name} Do`);

    if (pageNumbers) {
      const label = `${pageIds.length + 1} / ${images.length}`;
      const fontSize = 9;
      parts.push(
        'BT',
        `/F1 ${fontSize} Tf`,
        '0.45 0.45 0.45 rg',
        `${n(Math.max(4, size.w / 2 - label.length * 2.6))} 10 Td`,
        `(${label}) Tj`,
        'ET',
      );
    }
    parts.push('Q');

    const contentBytes = enc.encode(parts.join('\n'));
    const contentId = put(
      `<< /Length ${contentBytes.length} >>`,
      contentBytes,
    );

    const pageId = put(
      `<< /Type /Page /Parent ${pagesId} 0 R ` +
        `/MediaBox [0 0 ${n(size.w)} ${n(size.h)}] ` +
        // ojo: la clave del recurso es un /Name, así que necesita la barra
        `/Resources << /XObject << /${name} ${imageId} 0 R >>` +
        (fontId ? ` /Font << /F1 ${fontId} 0 R >>` : '') +
        ` >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  objects.set(catalogId, {
    dict: `<< /Type /Catalog /Pages ${pagesId} 0 R >>`,
  });
  objects.set(pagesId, {
    dict:
      `<< /Type /Pages /Count ${pageIds.length} ` +
      `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
  });

  const infoId = put(
    `<< /Title ${pdfString(title)} /Producer ${pdfString('Foto a PDF')} ` +
      `/Creator ${pdfString('Foto a PDF')} >>`,
  );

  return serialize(objects, catalogId, infoId);
}

/** Serializa los objetos a bytes con tabla xref y trailer. */
function serialize(objects, rootId, infoId) {
  const chunks = [];
  const push = (x) => chunks.push(typeof x === 'string' ? encStr(x) : x);
  let length = 0;
  const emit = (x) => {
    push(x);
    length += (typeof x === 'string' ? encStr(x) : x).length;
  };

  emit('%PDF-1.4\n');
  // Byte binario en el comentario: evita que algunos readers lo traten como texto.
  emit(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = new Map();
  const ids = [...objects.keys()].sort((a, b) => a - b);

  for (const id of ids) {
    offsets.set(id, length);
    const { dict, stream } = objects.get(id);
    emit(`${id} 0 obj\n${dict}\n`);
    if (stream) {
      emit('stream\n');
      emit(stream);
      emit('\nendstream\n');
    }
    emit('endobj\n');
  }

  const xrefStart = length;
  const count = ids.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const id of ids) {
    xref += `${String(offsets.get(id)).padStart(10, '0')} 00000 n \n`;
  }
  emit(xref);
  emit(
    `trailer\n<< /Size ${count} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefStart}\n%%EOF\n`,
  );

  return new Blob(chunks, { type: 'application/pdf' });
}