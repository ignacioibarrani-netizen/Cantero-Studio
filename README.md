# Cantero Studio

Simulador 2D de paisajismo sobre foto con escala real, malla de perspectiva, canteros/macetas con texturas, límites botánicos y limpiador de fondo PNG.

## Estructura del proyecto

- `index.html` — Interfaz principal y paneles de catálogo, escena e inspector
- `styles.css` — Estilos y scrollbars
- `app.js` — Motor de composición 2D, calibración de escala, perspectiva, alertas botánicas y limpiador PNG
- `data/catalog.js` — Fichas botánicas de especies y contenedores
- `assets/` — Imágenes separadas (`bg/`, `plants/`, `containers/`)

## Deploy en Vercel

Subí esta carpeta tal cual a GitHub: al tener `index.html` en la raíz y ser 100% estático, Vercel la despliega sin configuración adicional (Framework Preset: `Other`, Output Directory vacío).
