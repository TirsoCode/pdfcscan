/**
 * demo.js — Comparador interactivo Antes / Después.
 *
 * Una foto simulada sobre una mesa pasa por la corrección de perspectiva
 * de la app y se convierte en una página A4 limpia. El usuario arrastra
 * el divisor para comparar ambos estados.
 */

const root = document.getElementById('demo-mockup');

if (root) {
  const beforeEl = root.querySelector('.demo-before');
  const afterEl = root.querySelector('.demo-after');
  const stage = root.querySelector('.demo-stage');
  const range = root.querySelector('.demo-range');

  if (!beforeEl || !afterEl || !stage || !range) {
    console.error('[demo] No se encontraron todos los elementos del comparador.');
  } else {
    let dragging = false;

    const setPos = (pct) => {
      const val = Math.max(0, Math.min(100, pct));
      afterEl.style.clipPath = `inset(0 0 0 ${val}%)`;
      range.value = String(Math.round(val));
      range.setAttribute('aria-valuetext', `${Math.round(val)}%`);
      stage.style.setProperty('--pos', `${val}%`);
    };

    const pctFromEvent = (clientX) => {
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0) return 50;
      return ((clientX - rect.left) / rect.width) * 100;
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      setPos(pctFromEvent(clientX));
    };

    const stop = () => {
      dragging = false;
      stage.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', stop);
    };

    const start = (e) => {
      dragging = true;
      stage.classList.add('dragging');
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      setPos(pctFromEvent(clientX));
      e.preventDefault();
      document.addEventListener('pointermove', onMove, { passive: false });
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    };

    // Soporte táctil
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) start(e);
    }, { passive: true });

    // Soporte ratón
    stage.addEventListener('mousedown', (e) => {
      if (e.button === 0) start(e);
    });

    // Slider accesible
    range.addEventListener('input', () => setPos(Number(range.value)));
    range.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 2;
      const cur = Number(range.value);
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPos(cur - step); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setPos(cur + step); }
    });

    // Inicializar en 50%
    setPos(50);
  }
}
