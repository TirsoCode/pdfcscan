/**
 * camera.js — Captura con la cámara del dispositivo.
 */

export function cameraSupported() {
  return !!(navigator.mediaDevices?.getUserMedia);
}

export class Camera {
  /** @param {HTMLVideoElement} video */
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  /**
   * @param {{facingMode?: string}} [opts]
   */
  async start(opts = {}) {
    if (!cameraSupported()) {
      throw new Error('Este navegador no permite usar la cámara. Sube las fotos con el botón de archivos.');
    }
    if (!window.isSecureContext) {
      throw new Error('La cámara solo funciona en HTTPS o en localhost.');
    }
    this.stop();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: opts.facingMode || 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      });
    } catch (err) {
      throw new Error(friendlyError(err));
    }

    this.stream = stream;
    this.video.srcObject = stream;
    this.video.setAttribute('playsinline', '');
    await this.video.play();
    return stream;
  }

  stop() {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  get ready() {
    return !!this.stream && this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  /** Congela el fotograma actual en un canvas. */
  grab(maxDim = 2400) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) throw new Error('La cámara todavía no está lista.');

    const k = Math.min(1, maxDim / Math.max(vw, vh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * k);
    canvas.height = Math.round(vh * k);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
}

function friendlyError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permiso de cámara denegado. Actívalo en el candado de la barra de direcciones.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No se ha encontrado ninguna cámara en este dispositivo.';
    case 'NotReadableError':
      return 'La cámara está siendo usada por otra aplicación.';
    default:
      return 'No se ha podido abrir la cámara.';
  }
}