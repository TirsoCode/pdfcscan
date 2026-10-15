# Foto a PDF

Escanea un documento con la cámara del móvil, ordénalo y descarga un PDF
listo para imprimir. **Gratis, sin registro y sin anuncios.**

Todo el procesamiento ocurre en el navegador: las fotos nunca salen del
dispositivo, así que no hay servidor, ni cuentas, ni base de datos.

## Puesta en marcha

Los ficheros son estáticos y no llevan build:

```bash
node serve.mjs          # http://localhost:5173
node serve.mjs 8080     # otro puerto
```

La cámara exige un contexto seguro: `localhost` sirve, en móvil hace falta
HTTPS.

## Despliegue

Sube el contenido de la carpeta tal cual a GitHub Pages, Netlify,
Cloudflare Pages, Vercel o cualquier hosting estático. No hay nada que
compilar y la carpeta `test/` no se despliega.

## Qué hace

- **Auto-recorte**: encuentra el papel, le quita la perspectiva y lo endereza.
  Se puede desactivar con el interruptor «Ajustar el documento
  automáticamente» si ya subes fotos recortadas.
- **Cámara en vivo** con cámara trasera y frontal, o fotos del carrete.
- **Entrada por URL**: una imagen suelta o, si el enlace no acaba en una
  extensión de imagen, la **página web entera** capturada y troceada en
  páginas con proporción A4.
- **Recorte manual** con tiradores por si el automático falla.
- **Reordenar, girar, duplicar y borrar** páginas.
- **Ajustes**: tamaño (A6–A3, Carta, Legal, 4×6″, 5×7″), orientación, ajuste
  de la imagen, margen, filtro y calidad.
- **Descargar** e **imprimir** sin pasar por ninguna app.

## Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl`/`Cmd` + `Enter` | Descargar el PDF |
| `Esc` | Cerrar la cámara o el recorte |

## Estructura

```
index.html            marcado de la interfaz
styles.css            estilos (claro y oscuro)
serve.mjs             servidor estático para desarrollo
manifest.webmanifest  PWA instalable
sw.js                 service worker (uso sin conexión)
robots.txt           _directivas para buscadores
sitemap.xml            mapa del sitio
og.png                imagen de vista previa al compartir (1200×630)
icon.svg              icono
icon-180.png          icono para iOS
icon-192.png          icono para instalación en Android
icon-512.png          icono grande y maskable
js/
  app.js        estado, interfaz y flujo completo
  detect.js     detección del documento y corrección de perspectiva
  cropper.js    recorte interactivo con tiradores
  camera.js     captura con getUserMedia
  imageops.js   rotación, filtros y miniaturas
  pdf.js        generador de PDF
test/            comprobaciones contra Chrome real (no se despliega)
```

### `pdf.js`

Generador propio, sin librerías. Solo incrusta imágenes JPEG
(`/DCTDecode`), que es lo que produce `canvas.toBlob()`, así que no hay que
comprimir nada: los content streams van sin filtro y el resto es libro de
xref. Admite tamaño de página, orientación, margen, cuatro modos de ajuste
(incluido `fill`, que recorta) y numeración de páginas.

### `detect.js`

Para cada foto:

1. gris y desenfoque sobre un downscale de 480 px;
2. dos máscaras candidatas — por brillo (Otsu) y por bordes — y se queda con
   la más fiable;
3. mayor componente conexa, cierre morfológico y envolvente convexa;
4. caja mínima por *rotating calipers* sobre los lados del hull;
5. refinado de cada lado en la perpendicular, con ajuste por mínimos
   cuadrados y descarte de outliers;
6. las esquinas son los cruces de las rectas de los lados contiguos.

Dos detalles que no son obvios y que cuestan un día si no se ven:

**La caja mínima tiene que ir sobre el hull.** Si las direcciones
candidatas son parejas arbitrarias de puntos, sale la caja axis-aligned, que
es justo lo que no sirve con el documento torcido.

**El refinado no busca el gradiente más fuerte, sino el pico más externo.**
El margen izquierdo del texto forma una arista vertical muy alineada que a
veces es más marcada que el propio borde del papel; con «el más fuerte» el
recorte se metía hacia dentro unos 20 px en cualquier documento con margen
uniforme. Recorriendo la perpendicular de fuera hacia dentro y quedándose
con el primer pico fuerte, el borde del papel gana siempre.

La homografía se resuelve con Gauss-Jordan normalizado: con cuatro
correspondencias el sistema puede salir dependiente (cuadrilátero muy
simétrico) y las variables libres se fijan a cero, que es la solución
correcta.

Para la orientación no se mira la foto entera sino la página ya enderezada,
porque el texture de la mesa no dice nada del texto. La señal es el perfil
de proyección de la tinta: con el texto en horizontal se reparte en pocas
filas y el perfil por filas sale mucho más irregular que el de columnas.
Solo se gira cuando **las dos señales coinciden** — la hoja sale apaisada
*y* el texto corre de lado —; con una sola bastaría para rotar un documento
apaisado de verdad.

## Verificación

Los tests necesitan `puppeteer-core` y Chrome. La web no depende de nada de
eso para funcionar:

```bash
npm i puppeteer-core
node test/detect.mjs            # precisión del detector y rectificación
node test/smoke.mjs             # ingesta, ajustes, PDF y móvil
node test/camera.mjs correcto   # cámara: página bien fotografiada
node test/camera.mjs sideways   # cámara: móvil torcido
```

`CHROME=/ruta/al/chrome` si no está en `/usr/bin/google-chrome`.

Qué miran, y por qué cada cosa:

- el error de las esquinas contra imágenes sintéticas de posición conocida,
  entre 0° y 23° de inclinación, y que la página rectificada traiga papel y
  texto de verdad — si la homografía falla sale en blanco y no se nota;
- que el PDF abra sin quejas en `pdftoppm` **y** que la página rasterizada
  tenga tinta: `pdfinfo` acepta PDFs con las imágenes sin declarar, así que
  el control de píxeles es el que de verdad protege contra ese fallo;
- que el botón de disparo y los tres botones del modal quepan a 390 px;
- que la cámara suelte los flujos al cerrar.

## Límites conocidos

- **HEIC** solo se abre en Safari. En el resto de navegadores hay que
  pasarlo a JPG antes; la app avisa cuando no puede leer un archivo.
- La memoria crece con las páginas abiertas: se guarda el original como
  JPEG comprimido y la página ya enderezada como lienzo (máx. 2600 px).
  Es el precio de que el PDF salga a más de 200 DPI; en móvil con poca
  memoria conviene trabajar en tandas.
- El detector busca un único cuadrilátero claro y dominante. Con dos
  documentos en la foto acierta con el mayor; con una foto normal sin
  recorte, simplemente no detecta nada y se usa tal cual.
- El reordenado por arrastre con el dedo necesita el tirador de la tarjeta,
  para no robar el scroll vertical.
- El recorte automático es preciso con documentos sobre fondo limpio, pero
  deja algún píxel de mesa si el papel toca el borde de la foto. El recorte
  manual está para eso.

## Privacidad

No hay analítica, ni cookies, ni peticiones de red en el uso normal: los
ficheros se sirven y ya. Las fotos se procesan en memoria y se pierden al
cerrar la pestaña.

La captura de una página web por URL es la única excepción, y solo con esa
función: el navegador no puede leer otra web por sí mismo, así que pide la
captura a `image.thum.io`, que recibe la dirección de la página y devuelve
un PNG. Las fotos del carrete no se envían nunca.