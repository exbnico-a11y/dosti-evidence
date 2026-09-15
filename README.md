# Dosti Evidence

Asistente de apoyo clínico con IA para médicos mexicanos verificados, basado
exclusivamente en fuentes oficiales: CENETEC, Cuadro Básico de Medicamentos
(CAUSES), guías del IMSS y Normas Oficiales Mexicanas (NOM).

**Tema inicial:** Hipertensión arterial sistémica (HAS).

> ⚠️ **Aviso fundamental:** Dosti Evidence es una herramienta de *apoyo* a la
> decisión clínica. No sustituye el juicio médico, ni la relación médico-paciente,
> ni las guías oficiales vigentes. Toda recomendación debe mostrar su fuente
> oficial y fecha de publicación/actualización.

---

## Estructura del proyecto

```
Dosti Evidence/
├── README.md               ← este archivo
├── docs/
│   └── ROLES.md            ← definición de los 3 roles de trabajo
├── data/
│   ├── guidelines/         ← PDFs oficiales (guías, GPC, NOMs)
│   └── extracted/          ← texto extraído de los PDFs (para indexación)
├── src/
│   └── search/             ← motor de búsqueda semántica con citas
├── web/                    ← frontend (página del asistente)
├── marketing/              ← materiales y estrategia de distribución
├── accounting/             ← contabilidad, costos y modelo de negocio
└── tests/                  ← pruebas
```

## Fuentes cargadas (tema: hipertensión)

Ver registro detallado en [data/guidelines/FUENTES.md](data/guidelines/FUENTES.md).
Incluye: GPC-IMSS-076-21 (CENETEC 2021), Guía de Ejecución Rápida IMSS-076,
Referencia Rápida, PAI de HAS del IMSS, NOM-030-SSA2-2009 y Guía Práctica de
Tratamiento Farmacológico (gob.mx).

## Los 3 roles

1. **Construcción (Producto/Tech)** — página web, sistema de búsqueda con
   citas verificables, verificación de médicos. ← *Empezamos aquí.*
2. **Mercadotecnia y distribución** — alcance entre médicos mexicanos.
3. **Contabilidad y costos** — presupuesto, modelo de negocio, costos de
   operación (APIs, verificación de cédula, infraestructura).

Ver [docs/ROLES.md](docs/ROLES.md).

## Principios de diseño

1. **Toda afirmación clínica lleva cita** con fuente oficial + página/sección.
2. **Fuentes trazables:** cada documento tiene URL oficial, fecha de descarga y hash.
3. **Verificación de usuario:** solo médicos con cédula profesional vigente
   (verificación ante la DGPSEP/SEP o servicios como docIntell / APIs de cédula).
4. **Deslinde de responsabilidad visible** en cada pantalla.
5. **Actualización periódica** de guías (las GPC del CENETEC se actualizan).

## Publicación y actualización continua

La app es 100% estática y se publica con un túnel de Cloudflare que **sirve los
archivos en vivo**: todo cambio en `web/` (código, estilos, índice) se refleja
**al instante** en la URL pública, sin republicar.

```bash
# Operación (desde cualquier lugar)
"/Users/nico/Documents/Kimi/Workspaces/Dosti Evidence/web/publish.sh" start    # levanta todo
".../web/publish.sh" stop      # detiene todo
".../web/publish.sh" status    # estado + URL vigente
".../web/publish.sh" url       # solo la URL

# Flujo de desarrollo
# 1. Editar archivos en web/  →  cambio visible al instante
# 2. Agregaste guías nuevas:
python3 src/search/build_index.py   # reindexa → también visible al instante
```

- **Auto-arranque:** LaunchAgent `com.dosti.evidence` instalado en
  `~/Library/LaunchAgents/` — la app se republica sola al iniciar sesión.
- ⚠️ **La URL cambia tras cada reinicio** (límite de los túneles gratuitos sin
  cuenta). Consúltala siempre con `publish.sh url`.

## URL permanente (producción)

**https://exbnico-a11y.github.io/dosti-evidence/** — GitHub Pages, sirviendo
directamente del repo [github.com/exbnico-a11y/dosti-evidence](https://github.com/exbnico-a11y/dosti-evidence).
**Las actualizaciones de producción van siempre sobre este link.**

Flujo de publicación (optimizado, vía Kimi WebBridge):
1. Editar los archivos en `web/` — el túnel local refleja el cambio al instante
   para preview/desarrollo (solo si se agregaron guías nuevas:
   `python3 src/search/build_index.py` y copiar `assets/index.json` → `web/index.json`).
2. Pedir a Kimi "publica en producción": sube por WebBridge al repo los archivos
   que hayan cambiado de `web/` (`index.html`, `styles.css`, `app.js`,
   `index.json` si se reindexó) con commit directo a `main`.
3. GitHub Pages despliega en ~1 minuto; verificar en la URL permanente antes de
   dar por cerrada la actualización.

El túnel local (`publish.sh`) queda solo como entorno de desarrollo/preview.

## Secciones de la app

- **🔎 Buscador de evidencia** — BM25 sobre fragmentos de guías oficiales con
  citas por página (ver `src/search/`).
- **🌿 Remedios caseros con evidencia** — remedios naturales y herbolaria con
  respaldo estudiado (Cochrane, NCCIH/NIH, ACG, FDA, meta-análisis publicados y
  la Biblioteca Digital de la Medicina Tradicional Mexicana UNAM/INI). Cada
  remedio declara su nivel de evidencia, uso correcto y advertencias de
  seguridad/interacciones. Datos curados en `web/app.js` (constante `REMEDIOS`).
