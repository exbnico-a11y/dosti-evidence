/* Dosti Evidence v2 — BM25 estricto sobre guías oficiales MX.
   Respuesta sintetizada extractivamente: solo oraciones de fragmentos
   recuperados, con citas inline [n]. Sin conocimiento libre del modelo. */
let IDX = null;

const STOP = new Set(("a al algo algunas algunos ante antes como con contra cual " +
  "cuando de del desde donde durante e el ella ellas ellos en entre era eran es " +
  "esa esas ese eso esos esta estaban estabas estaba estamos estando estar estas " +
  "este esto estos estoy fue fueron ha habia habian haber han hasta hay la las le " +
  "les lo los mas me mi mis mucho muchos muy no nos nosotros o os otra otras otro " +
  "otros para pero poco por porque que quien quienes se sea sean ser si sin sobre " +
  "son soy su sus te tiene tienen todo todos un una unas uno unos y ya").split());

/* Expansión de siglas clínicas: si el término original no existe en el índice,
   se intenta su expansión (precisión primero). */
const EXPAND = {
  hta: ["hipertension"], has: ["hipertension"],
  pa: ["presion"], pas: ["presion", "sistolica"], pad: ["presion", "diastolica"],
  rcv: ["riesgo", "cardiovascular"],
  ieca: ["inhibidor", "enzima", "convertidora"],
  ara: ["antagonista", "receptor", "angiotensina"], bra: ["antagonista", "receptor", "angiotensina"],
  bcc: ["bloqueador", "canal", "calcio"],
  hctz: ["hidroclorotiazida"],
  dm: ["diabetes", "mellitus"], dmt2: ["diabetes", "mellitus"],
  fge: ["filtrado", "glomerular"], fg: ["filtrado", "glomerular"],
  mapa: ["monitoreo", "ambulatorio"], mdpa: ["monitoreo", "domiciliario"],
  imc: ["indice", "masa", "corporal"],
  iam: ["infarto", "miocardio"],
  aine: ["antiinflamatorio", "no", "esteroideo"],
  ea: ["estilo", "vida"],
};

const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function rawTerms(text) {
  return norm(text.toLowerCase()).match(/[a-z0-9]+/g) || [];
}

function tokenize(text) {
  const out = [];
  for (const w of rawTerms(text)) {
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/* ---------- búsqueda BM25 ---------- */

const K1 = 1.5, B = 0.75;
let TEMA_ACTUAL = "todos";
let DOCS_TEMA = null;  // docIdx -> tema (se construye al cargar)

function buscar(query, k = 10, tema = "todos") {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const N = IDX.meta.total, avgdl = IDX.meta.avgdl;

  // resolver términos (con expansión de siglas como respaldo)
  const resolved = [];
  for (const t of terms) {
    if (IDX.idf[t] !== undefined) { resolved.push({ t, w: 1 }); continue; }
    const exp = EXPAND[t];
    if (exp && exp.every(e => IDX.idf[e] !== undefined)) {
      exp.forEach((e, i) => resolved.push({ t: e, w: i === 0 ? 0.9 : 0.6 }));
    }
  }
  if (!resolved.length) return [];

  const scores = new Map();
  const BOOST = { recomendacion: 1.5, farmacos: 1.5, algoritmo: 1.5, evidencia: 0.7 };
  for (const { t, w } of resolved) {
    const idf = IDX.idf[t];
    const post = IDX.postings[t];
    if (!post) continue;
    for (const cid in post) {
      const tf = post[cid];
      const dl = IDX.dls[cid];
      const bm = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
      const tag = IDX.chunks[cid][3] || "otro";
      scores.set(+cid, (scores.get(+cid) || 0) + bm * w * (BOOST[tag] || 1));
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  const porPagina = new Map(), sel = [];
  for (const [cid, sc] of ranked) {
    const c = IDX.chunks[cid];
    if (tema !== "todos" && DOCS_TEMA[c[0]] !== tema) continue;
    const key = c[0] + ":" + c[1];
    const n = porPagina.get(key) || 0;
    if (n >= 2) continue;
    const t = c[2];
    if (t.length < 120) continue;
    if ((t.match(/\.{4,}/g) || []).length > 2) continue;
    if (/www\.|http/i.test(t) && t.length < 250) continue;
    porPagina.set(key, n + 1);
    sel.push([cid, sc]);
    if (sel.length >= k) break;
  }
  return sel;
}

/* ---------- clasificador de intención (P1-2) ---------- */

const INTENCION_PATRONES = [
  ["dosis", /dosis|\bmg\b|presentaci|contraindicaci/],
  ["tratamiento", /tratamiento|manejo|inicial|fármaco|farmaco|medicamento|primera l/i],
  ["diagnostico", /diagnóstico|diagnosticar|criterios|clasificación|clasificacion|cifras/],
  ["meta", /\bmeta\b|objetivo/],
  ["referencia", /referir|referencia|segundo nivel|especialista/],
];

function clasificarIntencion(query) {
  const q = " " + norm(query.toLowerCase()) + " ";
  for (const [intencion, pat] of INTENCION_PATRONES) {
    if (pat.test(q)) return intencion;
  }
  return "general";
}

/* ---------- síntesis extractiva (MMR) ---------- */

function oraciones(texto) {
  return texto.replace(/\s+/g, " ").trim()
    .match(/[^.!?;:]+[.!?;:]+/g) || [texto];
}

function simJaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return A.size + B.size ? inter / (A.size + B.size - inter) : 0;
}

/* P0-4: narrativa de estudio (diseño/muestra/estadísticos). No accionable. */
const PATRONES_EVIDENCIA = [
  /se realizó|se llevaron a cabo|se condujo|se incluyeron|se analizaron/i,
  /estudio de corte|ensayo cl[ií]nico|cohorte|casos y controles|revisi[oó]n sistem[aá]tica|metaan[aá]lisis|meta-an[aá]lisis/i,
  /los resultados (mostraron|demostraron|sugieren)|se encontró|se observó|se reportó una (mayor|menor|incidencia|prevalencia)/i,
  /\b(OR|RR|HR)\s*=|IC\s?95|intervalo de confianza|p\s?<\s?0\./,
  /participantes|poblaci[oó]n de estudio|tamaño de la muestra/i,
];
/* Una recomendación que cita evidencia sigue siendo accionable (excepción P0-4) */
const VERBO_ACCION_P0_4 = /recomiend|sugier|debe|no usar|evitar/i;

/* P0-2: verbos de acción clínica ampliados (condición de entrada) */
const VERBO_ACCION = /recomiend|sugier|debe|iniciar|administrar|mantener|suspender|referir|diagnosticar|clasificar|medir|confirmar|ajustar|combinar|contraindic|indicar/i;
const MARCADORES_GRADE = /recomendaci[oó]n (fuerte|d[eé]bil)|a favor|en contra|calidad de la evidencia (alta|moderada|baja)/i;

function puntuarOracion(s, termSet, intencion = "general") {
  const toks = tokenize(s);
  if (toks.length < 4 || s.length < 40) return -1;
  // artefactos de tabla mal extraída ("cuadro 1) , cuadro 1)… Evidencia / Recomendación")
  const letras = (s.match(/[a-záéíóúñü]/gi) || []).length;
  if (letras / s.length < 0.45) return -1;
  if (/evidencia\s*\/\s*recomendaci/i.test(s)) return -1;
  // P0-4: excluir narrativa metodológica en todas las consultas…
  if (PATRONES_EVIDENCIA.some(p => p.test(s)) && !VERBO_ACCION_P0_4.test(s)) return -1;
  let s_ = 0, hits = 0;
  for (const t of toks) {
    const idf = IDX.idf[t];
    if (idf) s_ += idf;
    if (termSet.has(t)) hits++;
  }
  if (!hits) return -1;
  // P0-2: en diagnóstico/tratamiento, la oración debe ser accionable…
  if ((intencion === "diagnostico" || intencion === "tratamiento") &&
      !/\d/.test(s) && !VERBO_ACCION.test(s)) return -1;
  let bonus = 0;
  if (/\d/.test(s)) bonus += 0.6;
  if (VERBO_ACCION.test(s)) bonus += 0.8;
  if (MARCADORES_GRADE.test(s)) bonus += 1.0;
  return (s_ * (1 + hits / termSet.size) + bonus * hits) / Math.sqrt(toks.length);
}

/* P1-1: bloques funcionales por intención (qué debe aparecer, no formato rígido) */
const BLOQUES_INTENCION = {
  diagnostico: [
    ["criterio", /diagn|criteri|sospecha|s[ií]ntoma|signo|confirma|tamizaje|medici/i, 2],
    ["clasificacion", /grado|estadio|fase|leve|moderad|grave|clasificaci/i, 2],
  ],
  tratamiento: [
    ["primera_linea", /inici|primera|tratamiento|f[aá]rmaco|monoterapia|combinaci|administrar|dosis/i, 2],
    ["meta", /\bmeta\b|objetivo|cifra|control/i, 1],
    ["referencia", /referir|segundo nivel|especialidad|contrarreferencia|urgencia/i, 1],
  ],
  dosis: [
    ["dosis", /dosis|\bmg\b|administraci/i, 2],
    ["presentacion", /presentaci|tableta|comprimido|c[aá]psula|ampolleta|frasco|envase/i, 1],
    ["contraindicacion", /contraindic|precauc|no usar|evitar|suspend/i, 1],
  ],
  meta: [
    ["cifra_objetivo", /\bmeta\b|objetivo|control/i, 2],
    ["condiciones", /excepto|siempre que|individualiz|ajust|embarazo|renal|hep[aá]tic/i, 2],
  ],
};
const ETIQUETA_BLOQUE = {
  criterio: "Criterios", clasificacion: "Clasificación",
  primera_linea: "Tratamiento", meta: "Meta terapéutica", referencia: "Referencia",
  dosis: "Dosis", presentacion: "Presentación", contraindicacion: "Contraindicaciones",
  cifra_objetivo: "Cifra objetivo", condiciones: "Condiciones",
};

function asignarBloque(s, intencion) {
  for (const [id, pat] of BLOQUES_INTENCION[intencion] || []) {
    if (pat.test(s)) return id;
  }
  return null;
}

function sintetizar(resultados, query, maxOraciones = 4) {
  const intencion = clasificarIntencion(query);
  const termSet = new Set(tokenize(query));
  const accionables = [], deEvidencia = [];
  resultados.forEach(([cid], ci) => {
    const tag = IDX.chunks[cid][3] || "otro";
    for (const s of oraciones(IDX.chunks[cid][2])) {
      const p = puntuarOracion(s, termSet, intencion);
      if (p > 0) {
        const item = { s: s.trim(), p, ref: ci, cid, tag };
        (tag === "evidencia" ? deEvidencia : accionables).push(item);
      }
    }
  });
  // P1-3.4: solo se recurre a oraciones de evidencia si no hay suficientes
  if (accionables.length < maxOraciones) {
    deEvidencia.sort((a, b) => b.p - a.p);
    accionables.push(...deEvidencia.slice(0, maxOraciones - accionables.length));
  }
  accionables.sort((a, b) => b.p - a.p);

  const elegidas = [], usados = [];
  const usar = c => {
    if (elegidas.length >= maxOraciones) return false;
    if (c.s.length > 420) return false;
    const toks = tokenize(c.s);
    if (usados.some(u => simJaccard(u, toks) > 0.45)) return false;
    elegidas.push(c); usados.push(toks);
    return true;
  };
  // selección por bloques funcionales (P1-1): cada bloque con cupo propio
  const bloqueDe = new Map();
  for (const [id, , cupo] of BLOQUES_INTENCION[intencion] || []) {
    let n = 0;
    for (const c of accionables) {
      if (n >= cupo || elegidas.length >= maxOraciones) break;
      if (asignarBloque(c.s, intencion) === id && usar(c)) { n++; bloqueDe.set(c, id); }
    }
  }
  for (const c of accionables) {           // relleno global dentro del límite
    if (elegidas.length >= maxOraciones) break;
    usar(c);
  }
  elegidas.sort((a, b) => b.p - a.p);      // orden clínico: las más puntuadas primero
  // Óptimo de palabras visibles (criterio global UX): ≤90 palabras en el bloque.
  // Estrategia: 1) recortar cada oración a su núcleo accionable (límite de
  // cláusula, nunca a la mitad de una frase), 2) si aún se rebasa, retirar la
  // oración menos relevante, 3) caso extremo de una sola oración: cortarla.
  const OPTIMO_PALABRAS = 90, MAX_PAL_ORACION = 34;
  const nPal = s => s.split(/\s+/).length;
  const cortarEnClausula = (s, maxPal) => {
    if (nPal(s) <= maxPal) return s;
    const toks = s.split(/\s+/);
    const acum = toks.slice(0, maxPal).join(" ");
    const hasta = acum.length + 1;
    const mejor = Math.max(s.slice(0, hasta).lastIndexOf("; "), s.slice(0, hasta).lastIndexOf(", "));
    return (mejor > 50 ? s.slice(0, mejor) : acum) + "…";
  };
  elegidas.forEach(o => { o.s = cortarEnClausula(o.s, MAX_PAL_ORACION); });
  let totalPal = elegidas.reduce((n, o) => n + nPal(o.s), 0);
  while (totalPal > OPTIMO_PALABRAS && elegidas.length > 1) {
    totalPal -= nPal(elegidas[elegidas.length - 1].s);
    elegidas.pop();
  }
  if (totalPal > OPTIMO_PALABRAS && elegidas.length) {
    elegidas[0].s = cortarEnClausula(elegidas[0].s, OPTIMO_PALABRAS);
  }
  elegidas.forEach(c => { if (!bloqueDe.has(c)) bloqueDe.set(c, asignarBloque(c.s, intencion)); });
  elegidas.bloqueDe = bloqueDe;
  elegidas.intencion = intencion;

  // P2-2: oraciones de referencia siempre disponibles en tratamiento o referencia
  if (intencion === "tratamiento" || intencion === "referencia") {
    const refs = [];
    for (const [cid] of resultados) {
      for (const s of oraciones(IDX.chunks[cid][2])) {
        if (/referir|referencia|segundo nivel/i.test(s) && /segundo nivel|referencia|especialidad|urgencia/i.test(s)
            && s.length < 420 && !refs.some(r => r.s === s)) {
          refs.push({ s: s.trim(), cid });
        }
      }
      if (refs.length >= 4) break;
    }
    elegidas.referir = refs.slice(0, 3);
  }
  return elegidas;
}

/* ---------- refinamiento de síntesis con IA (BYOK) ----------
   Reescritura asistida por IA de las oraciones ya recuperadas: corta,
   ordena y redacta en prosa médica, SIN agregar hechos externos y
   conservando las citas [n] a los fragmentos. Requiere endpoint
   compatible con OpenAI + API key del propio usuario (localStorage). */

const IA_DEFAULTS = { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" };

function iaConfig() {
  try { return { ...IA_DEFAULTS, ...JSON.parse(localStorage.getItem("dosti_ia") || "{}") }; }
  catch { return { ...IA_DEFAULTS }; }
}
function iaGuardar(cfg) { localStorage.setItem("dosti_ia", JSON.stringify(cfg)); }

function iaPrompt(query, intencion, elegidas) {
  const fragmentos = elegidas.map(o => `[${o.ref + 1}] ${o.s}`).join("\n");
  return {
    system: "Eres un editor médico experto. Reescribes síntesis de guías clínicas oficiales mexicanas para médicos de primer nivel. Reglas absolutas: 1) Usa SOLO la información de los fragmentos numerados; está prohibido añadir conocimiento externo, completar dosis o cifras que no aparezcan. 2) Conserva exactas las cifras, fármacos y dosis citados. 3) Mantén los marcadores [n] al final de cada afirmación que los respalde. 4) Máximo 85 palabras, máximo 3 oraciones, español médico directo y sin relleno. 5) Prioriza lo accionable: qué hacer, con qué dosis/meta y cuándo referir. 6) Si los fragmentos no responden la consulta, responde exactamente: INSUFICIENTE.",
    user: `Consulta del médico: "${query}" (intención: ${intencion}).\nFragmentos recuperados de las guías oficiales:\n${fragmentos}\n\nEscribe la síntesis refinada cumpliendo las reglas. Devuelve SOLO el texto de la síntesis.`,
  };
}

/* valida el texto refinado: cita solo fuentes presentes, sin conocimiento nuevo
   medible: longitud y presencia de al menos una cita */
function iaValidar(texto, nFuentes) {
  if (!texto || /INSUFICIENTE/i.test(texto)) return null;
  const limpio = texto.trim().replace(/^["']|["']$/g, "");
  const citas = [...limpio.matchAll(/\[(\d{1,2})\]/g)].map(m => +m[1]);
  if (!citas.length) return null;
  if (citas.some(n => n < 1 || n > nFuentes)) return null;
  return limpio;
}

async function refinarConIA(query, intencion, elegidas, nFuentes) {
  const cfg = iaConfig();
  if (!cfg.key) throw new Error("sin_key");
  const p = iaPrompt(query, intencion, elegidas);
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model, temperature: 0.1, max_tokens: 220,
      messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }],
    }),
  });
  if (!res.ok) throw new Error("http_" + res.status);
  const data = await res.json();
  const texto = data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  const valido = iaValidar(texto, nFuentes);
  if (!valido) throw new Error("respuesta_invalida");
  return valido;
}

/* pinta el texto refinado con citas clicables, reemplazando el bloque .sintesis */
function pintarRefinada(box, texto, originalHtml, notaEl) {
  const sintesis = box.querySelector(".sintesis");
  if (!sintesis) return;
  const html = texto.replace(/\[(\d{1,2})\]/g, (_, n) =>
    `<span class="cite" data-c="${+n - 1}">[${n}]</span>`);
  sintesis.innerHTML = `<p class="sintesis-refinada">${html}</p>`;
  if (notaEl) notaEl.innerHTML =
    `Redacción asistida por IA a partir <strong>exclusivamente</strong> de los fragmentos
     citados (sin conocimiento externo). <a href="#" id="ver-original">Ver síntesis extractiva original</a>.`;
  sintesis.querySelectorAll(".cite").forEach(el =>
    el.addEventListener("click", () => {
      const f = document.getElementById("f" + el.dataset.c);
      if (f) { f.classList.add("abierta"); f.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }));
  const volver = document.getElementById("ver-original");
  if (volver) volver.addEventListener("click", e => {
    e.preventDefault();
    sintesis.innerHTML = originalHtml;
    if (notaEl) notaEl.textContent = "Respuesta compuesta únicamente con texto recuperado de las fuentes oficiales citadas. Verifica siempre el contexto completo en la página indicada.";
    box.querySelectorAll(".sintesis .cite").forEach(el =>
      el.addEventListener("click", () => {
        const f = document.getElementById("f" + el.dataset.c);
        if (f) { f.classList.add("abierta"); f.scrollIntoView({ behavior: "smooth", block: "center" }); }
      }));
  });
}

/* ---------- render ---------- */

function chunkInfo(cid) {
  const c = IDX.chunks[cid];
  const doc = IDX.meta.docs[c[0]];
  return { docCorto: doc.corto, docNombre: doc.nombre, pagina: c[1], texto: c[2] };
}

/* ---------- detección de padecimiento (alias clínicos y coloquiales) ---------- */

const NOMBRE_PADECIMIENTO = {
  hipertension: "Hipertensión arterial", diabetes: "Diabetes mellitus tipo 2",
  dislipidemias: "Dislipidemias", obesidad: "Obesidad", asma: "Asma bronquial",
  epoc: "EPOC", neumonia: "Neumonía adquirida en la comunidad",
  erc: "Enfermedad renal crónica", depresion: "Trastorno depresivo",
  ansiedad: "Trastornos de ansiedad", hipotiroidismo: "Hipotiroidismo",
  cefalea: "Cefalea y migraña", anemia: "Anemia ferropénica",
  ivu: "Infección del tracto urinario", artritis: "Artritis reumatoide",
  osteoporosis: "Osteoporosis",
};

/* alias normalizados (sin acentos, minúsculas); clínicos + coloquiales */
const ALIAS_PADECIMIENTOS = {
  hipertension: ["hipertension", "hipertension arterial", "hta", "presion alta",
    "tension alta", "presion arterial alta", "hipertenso", "hipertensa"],
  diabetes: ["diabetes", "diabetes mellitus", "dm2", "dm 2", "azucar alta",
    "glucosa alta", "hiperglucemia", "diabetico", "diabetica"],
  dislipidemias: ["dislipidemia", "dislipidemias", "colesterol alto",
    "trigliceridos altos", "grasa en la sangre", "hipercolesterolemia",
    "colesterol y trigliceridos"],
  obesidad: ["obesidad", "obesidad morbida", "sobrepeso", "peso excesivo",
    "obeso", "obesa", "imc alto"],
  asma: ["asma", "asma bronquial", "crisis de asma"],
  epoc: ["epoc", "enfisema", "bronquitis cronica"],
  neumonia: ["neumonia", "pulmonia", "neumonia adquirida en la comunidad"],
  erc: ["enfermedad renal cronica", "insuficiencia renal", "rinon cronico",
    "falla renal", "erc", "rinones fallando"],
  depresion: ["depresion", "tristeza profunda", "animo bajo", "depresivo",
    "depresiva", "melancolia"],
  ansiedad: ["ansiedad", "ataque de panico", "crisis de panico",
    "nervios constantes", "tag", "trastorno de ansiedad"],
  hipotiroidismo: ["hipotiroidismo", "tiroides baja", "tiroides lenta",
    "tiroides baja de funcion"],
  cefalea: ["cefalea", "dolor de cabeza", "migrana", "jaqueca", "dolor de craneo"],
  anemia: ["anemia", "hierro bajo", "sangre baja", "anemico", "anemica"],
  ivu: ["ivu", "itu", "infeccion urinaria", "infeccion del tracto urinario",
    "orinar con ardor", "ardor al orinar", "orina con ardor"],
  artritis: ["artritis", "reuma", "artritis reumatoide", "articulaciones inflamadas"],
  osteoporosis: ["osteoporosis", "huesos fragiles", "densidad osea baja",
    "fractura por fragilidad"],
};

const ALIAS_A_TEMA = {};
Object.entries(ALIAS_PADECIMIENTOS).forEach(([tema, aliases]) =>
  aliases.forEach(a => { ALIAS_A_TEMA[norm(a)] = tema; }));

/* detecta el padecimiento de la consulta; el alias más largo manda */
function detectarPadecimiento(q) {
  const qn = " " + norm(q.toLowerCase()).replace(/[^a-z0-9ñ ]/g, " ") + " ";
  const aliases = Object.keys(ALIAS_A_TEMA).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (alias.length < 5) {
      const rx = new RegExp(`\\b${alias}\\b`);
      if (rx.test(qn)) return ALIAS_A_TEMA[alias];
    } else if (qn.includes(alias)) {
      return ALIAS_A_TEMA[alias];
    }
  }
  return null;
}

/* padecimientos del catálogo más cercanos a una consulta sin coincidencias */
const TOKENS_GENERICOS = new Set(["dolor", "sintoma", "sintomas", "cronica", "cronico",
  "severa", "severo", "aguda", "agudo", "adulto", "adulta", "nino", "nina",
  "paciente", "malestar", "mujer", "hombre"]);
function padecimientosCercanos(q, limite = 4) {
  const toks = new Set([...tokenize(q)].filter(t => !TOKENS_GENERICOS.has(t)));
  if (!toks.size) return [];
  const scores = [];
  for (const [tema, aliases] of Object.entries(ALIAS_PADECIMIENTOS)) {
    let s = 0;
    for (const a of aliases) {
      const at = tokenize(a);
      if (!at.length) continue;
      for (const t of at) {
        if (t.length < 4) continue; // siglas cortas y preposiciones no puntúan aquí
        if (toks.has(t)) s += 1 / at.length;
        else if (t.length >= 5 && [...toks].some(qt => qt.length >= 5 && (qt.startsWith(t) || t.startsWith(qt)))) s += 0.5 / at.length;
      }
    }
    if (s > 0.2) scores.push([tema, s]);
  }
  return scores.sort((a, b) => b[1] - a[1]).slice(0, limite).map(([t]) => t);
}

function limpiar(t) { return t.replace(/\s+/g, " ").trim(); }

function render(resultados, query, opts = {}) {
  const box = document.getElementById("respuesta");
  const fuentes = document.getElementById("fuentes");
  const sec = document.getElementById("resultados");
  sec.hidden = false;
  sec.dataset.mostrado = "1";
  document.getElementById("inicio").hidden = true;

  if (!resultados.length) {
    const sugeridas = sugerirConsultas(query);
    const cercanos = padecimientosCercanos(query);
    const listaPadecimientos = cercanos.length ? cercanos : Object.keys(NOMBRE_PADECIMIENTO);
    box.innerHTML = `<p class="sin-resultados">Sin coincidencias exactas en las guías
      cargadas para: “${query}”. Reformula con términos clínicos (fármacos, cifras,
      comorbilidades) o sus siglas (HTA, IECA, BCC…).</p>` +
      `<div class="sugeridas-vacio"><strong>${cercanos.length
        ? "🏥 ¿Buscabas alguno de estos padecimientos del catálogo?"
        : "🏥 Padecimientos con evidencia disponible en el catálogo"}</strong>
        <p class="nota">${cercanos.length
          ? "Evidencia disponible con guías oficiales indexadas:"
          : "Todavía no tenemos ese tema; elige uno de los cubiertos:"}</p>` +
        listaPadecimientos.map(t => `<button type="button" class="chip chip-padecimiento" data-tema="${t}">${NOMBRE_PADECIMIENTO[t]}</button>`).join("") + `</div>` +
      (sugeridas.length ? `<div class="sugeridas-vacio"><strong>💡 Respuestas sugeridas del catálogo</strong>
        <p class="nota">Lo más cercano que existe en las guías indexadas; elige una para buscarla:</p>` +
        sugeridas.map(s => {
          const texto = s.texto.length > 110 ? s.texto.slice(0, 110).replace(/\s\S*$/, "") + "…" : s.texto;
          return `<button type="button" class="chip chip-sugerido" data-q="${escHtml(s.texto)}">${escHtml(texto)}
            <span class="sug-fuente">${escHtml(s.fuente)}</span></button>`;
        }).join("") + `</div>` : "");
    box.querySelectorAll(".chip-sugerido").forEach(b =>
      b.addEventListener("click", () => {
        document.getElementById("q").value = b.dataset.q;
        RUN_QUERY(b.dataset.q);
      }));
    box.querySelectorAll(".chip-padecimiento").forEach(b =>
      b.addEventListener("click", () => {
        TEMA_ACTUAL = b.dataset.tema;
        document.querySelectorAll(".chip-tema").forEach(c =>
          c.classList.toggle("activo", c.dataset.tema === b.dataset.tema));
        document.getElementById("q").value = NOMBRE_PADECIMIENTO[b.dataset.tema];
        RUN_QUERY(NOMBRE_PADECIMIENTO[b.dataset.tema]);
      }));
    fuentes.innerHTML = "";
    return;
  }

  const sintesis = sintetizar(resultados, query);
  const intencion = sintesis.intencion || "general";

  // P2-1: ¿hay ≥3 oraciones con la misma unidad de magnitud? → tabla
  const UNIDADES = /(\d[\d.,]*\s?(?:mm\s?hg|mg\/dl|g\/l|kg\/m2|kg\/m²|ml\/min|bpm|mg\/d[ií]a|g\/d[ií]a))/i;
  const conUnidad = sintesis.filter(o => UNIDADES.test(o.s));
  const unidadComun = (intencion === "diagnostico" || intencion === "meta") &&
    conUnidad.length >= 3 ? UNIDADES.exec(conUnidad[0].s)[1].replace(/[\d.,\s]+/, "") : null;

  const pintarOracion = o =>
    `${o.s} <span class="cite" data-c="${o.ref}">[${o.ref + 1}]</span>`;

  let html = `<h3>Respuesta basada en guías oficiales</h3>`;
  if (opts.padecimiento) {
    html += `<div class="aviso-padecimiento">🏥 Padecimiento detectado: <strong>${NOMBRE_PADECIMIENTO[opts.padecimiento]}</strong>
      — evidencia priorizada de sus guías oficiales.
      <button type="button" class="btn-algoritmo" data-alg="${opts.padecimiento}">📋 Ver algoritmo clínico</button></div>`;
  }
  if (opts.modo && opts.modo !== "exacto") {
    const explicacion = {
      "sin-filtro": "se amplió la búsqueda a todos los padecimientos",
      "expandida": "se usaron términos equivalentes del catálogo",
    };
    html += `<p class="aviso-relajado">⚠️ Sin coincidencia exacta para “${escHtml(query)}”.
      Mostrando la evidencia más cercana (${explicacion[opts.modo] || "búsqueda ampliada"}).</p>`;
  }
  if (sintesis.length) {
    html += `<div class="sintesis">`;
    const vistos = new Set();
    if (unidadComun) {
      // tabla concepto · valor: divide en el primer número
      html += `<table class="tabla-cifras"><thead><tr><th>Concepto</th><th>Valor</th></tr></thead><tbody>`;
      for (const o of sintesis) {
        if (!UNIDADES.test(o.s)) continue;
        const m = /^(.*?)(\d[\d.,]*(?:\.\d+)?\s?(?:mm\s?hg|mg\/dl|g\/l|kg\/m2|kg\/m²|ml\/min|bpm|mg\/d[ií]a|g\/d[ií]a)[^.]*)/i.exec(o.s);
        if (m && m[1].trim().length >= 8) {
          vistos.add(o);
          html += `<tr><td>${m[1].trim()}</td><td>${m[2].trim()} <span class="cite" data-c="${o.ref}">[${o.ref + 1}]</span></td></tr>`;
        }
      }
      html += `</tbody></table>`;
      const resto = sintesis.filter(o => !vistos.has(o));
      if (resto.length) html += `<p>${resto.map(pintarOracion).join(" ")}</p>`;
    } else {
      html += `<p>${sintesis.map(pintarOracion).join(" ")}</p>`;
    }
    html += `</div>`;
  }
  if (sintesis.referir && sintesis.referir.length) {
    html += `<div class="referir"><strong>📤 Cuándo referir a segundo nivel</strong><ul>` +
      sintesis.referir.map(o =>
        `<li>${o.s} <span class="cite" data-c="${resultados.findIndex(r => r[0] === o.cid)}">[${resultados.findIndex(r => r[0] === o.cid) + 1}]</span></li>`).join("") +
      `</ul></div>`;
  }
  html += `<details class="fragmentos"><summary>Ver fragmentos completos de las fuentes</summary>`;
  resultados.forEach(([cid], i) => {
    const info = chunkInfo(cid);
    const txt = limpiar(info.texto);
    const recorte = txt.length > 700 ? txt.slice(0, 700).replace(/\s\S*$/, "") + "…" : txt;
    html += `<div class="frag">${recorte} <span class="cite" data-c="${i}">[${i + 1}]</span></div>`;
  });
  html += `</details>`;
  html += `<p class="nota" id="nota-respuesta">Respuesta compuesta únicamente con texto recuperado de las
    fuentes oficiales citadas. Verifica siempre el contexto completo en la página indicada.</p>`;
  if (sintesis.length) {
    html += `<div class="acciones-ia"><button id="btn-ia" class="btn-ia">✨ Refinar redacción con IA</button>
      <button id="btn-ia-config" class="btn-ia-config" title="Configurar API key y modelo">⚙️</button></div>`;
  }
  box.innerHTML = html;

  // botón "ver algoritmo" del padecimiento detectado
  const btnAlg = box.querySelector(".btn-algoritmo");
  if (btnAlg) btnAlg.addEventListener("click", () => {
    const tab = document.querySelector('[data-vista="algoritmo"]');
    if (tab) tab.click();
    const chip = document.querySelector(`.chip-alg[data-alg="${btnAlg.dataset.alg}"]`);
    if (chip) chip.click();
  });

  // --- refinamiento IA (opcional, BYOK) ---
  const btnIA = box.querySelector("#btn-ia");
  const originalHtml = sintesis.length ? box.querySelector(".sintesis").innerHTML : null;
  btnIA.addEventListener("click", async () => {
    if (!iaConfig().key) { abrirModalIA(); if (!iaConfig().key) return; }
    btnIA.disabled = true;
    btnIA.textContent = "✨ Refinando…";
    try {
      const texto = await refinarConIA(query, intencion, sintesis, resultados.length);
      pintarRefinada(box, texto, originalHtml, box.querySelector("#nota-respuesta"));
      btnIA.textContent = "✓ Refinada";
    } catch (e) {
      btnIA.disabled = false;
      btnIA.textContent = "✨ Reintentar refinamiento";
      const nota = box.querySelector("#nota-respuesta");
      nota.innerHTML = e.message === "sin_key"
        ? "Configura tu API key (botón ⚙️) para usar el refinamiento con IA."
        : `El refinamiento con IA no estuvo disponible (${e.message}). La síntesis extractiva se mantiene.`;
    }
  });
  box.querySelector("#btn-ia-config").addEventListener("click", abrirModalIA);

  // P0-3: fuentes colapsadas por defecto; clic expande nombre completo + fragmento
  fuentes.innerHTML = resultados.map(([cid], i) => {
    const info = chunkInfo(cid);
    const snip = limpiar(info.texto).slice(0, 260);
    return `<div class="fuente" id="f${i}" data-i="${i}" role="button" tabindex="0">
      <span class="n">[${i + 1}]</span><span class="doc">${info.docCorto}</span>
      <span class="pag">· página ${info.pagina}</span>
      <div class="fuente-extra"><div class="pag">${info.docNombre}</div>
      <div class="snip">${snip}…</div></div></div>`;
  }).join("");
  fuentes.querySelectorAll(".fuente").forEach(f => {
    const toggle = () => f.classList.toggle("abierta");
    f.addEventListener("click", toggle);
    f.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  });

  box.querySelectorAll(".cite").forEach(el =>
    el.addEventListener("click", () => {
      const f = document.getElementById("f" + el.dataset.c);
      if (f) {
        f.classList.add("abierta");
        f.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }));
}

/* ---------- verificación de cédula (demo) ---------- */

/* ---------- configuración IA (modal) ---------- */

function abrirModalIA() {
  const modal = document.getElementById("modal-ia");
  const cfg = iaConfig();
  document.getElementById("ia-endpoint").value = cfg.endpoint;
  document.getElementById("ia-model").value = cfg.model;
  document.getElementById("ia-key").value = cfg.key || "";
  modal.hidden = false;
}
function cerrarModalIA() { document.getElementById("modal-ia").hidden = true; }

function initModalIA() {
  document.getElementById("ia-guardar").addEventListener("click", () => {
    iaGuardar({
      endpoint: document.getElementById("ia-endpoint").value.trim() || IA_DEFAULTS.endpoint,
      model: document.getElementById("ia-model").value.trim() || IA_DEFAULTS.model,
      key: document.getElementById("ia-key").value.trim(),
    });
    cerrarModalIA();
  });
  document.getElementById("ia-cancelar").addEventListener("click", cerrarModalIA);
}

function initCedula() {
  const badge = document.getElementById("badge-demo");
  const modal = document.getElementById("modal-cedula");
  const guardada = localStorage.getItem("dosti_cedula");
  const modo = localStorage.getItem("dosti_modo");
  if (guardada || modo === "invitado") {
    modal.remove();
    badge.textContent = guardada
      ? `Médico verificado (demo) · céd. ${guardada}`
      : "Modo invitado — demo sin validación";
    return;
  }
  document.getElementById("btn-cedula").addEventListener("click", () => {
    const v = document.getElementById("cedula").value.trim();
    if (!/^\d{7,9}$/.test(v)) {
      document.getElementById("cedula-error").textContent =
        "Formato inválido: la cédula profesional tiene 7 a 9 dígitos.";
      return;
    }
    localStorage.setItem("dosti_cedula", v);
    modal.remove();
    badge.textContent = `Médico verificado (demo) · céd. ${v}`;
  });
  document.getElementById("btn-invitado").addEventListener("click", () => {
    localStorage.setItem("dosti_modo", "invitado");
    modal.remove();
    badge.textContent = "Modo invitado — demo sin validación";
  });
}

/* ---------- referencia de fármacos (Cuadro Básico, GPC-238-09/GPC-076-21) ---------- */

const FARMACOS = [
  { clave: "010.000.2521.00", nombre: "Losartán / Hidroclorotiazida",
    presentacion: "Gragea o comprimido recubierto",
    notas: "Hipotensión (muy raro), ansiedad. Hiperpotasemia con IECA, AINEs, suplementos de potasio.",
    pagina: 81 },
  { clave: "010.000.5801.00", nombre: "Irbesartán / Amlodipino 150/5 mg",
    presentacion: "Tableta, envase con 28",
    notas: "Con AINEs puede haber deterioro de función renal; vigilar potasio.",
    pagina: 82 },
  { clave: "010.000.5802.00", nombre: "Irbesartán / Amlodipino 300/5 mg",
    presentacion: "Tableta, envase con 28",
    notas: "Interacción con fármacos que afectan el sistema renina-angiotensina.",
    pagina: 82 },
  { clave: "010.000.6233–6234", nombre: "Perindopril / Amlodipino",
    presentacion: "Comprimidos",
    notas: "Contraindicado con antecedente de angioedema, 2º-3er trimestre de embarazo. AINEs reducen efecto.",
    pagina: 82 },
  { clave: "010.000.6235–6236", nombre: "Perindopril / Indapamida",
    presentacion: "Comprimidos",
    notas: "Contraindicado si aclaramiento de creatinina < 60 ml/min, hipopotasemia, sulfonamidas.",
    pagina: 83 },
  { clave: "010.000.6246.00", nombre: "Olmesartán / Amlodipino 20/5 y 40/5–10 mg",
    presentacion: "Tableta, envase con 28",
    notas: "Aumenta toxicidad de litio; potencia efecto baclofeno; reducido por AINEs.",
    pagina: 85 },
  { clave: "010.000.5800.00", nombre: "Amlodipino / Valsartán / HCTZ 5/160/12.5 mg",
    presentacion: "Comprimido, envase con 28",
    notas: "CYP3A4: aumenta con eritromicina, claritromicina, verapamilo; reduce con inductores.",
    pagina: 88 },
  { clave: "010.000.6252–6253", nombre: "Olmesartán / Amlodipino / HCTZ",
    presentacion: "Tableta, caja con 28",
    notas: "Combinación triple. Contraindicado en hipopotasemia refractaria, hipercalcemia, 2º-3er trimestre.",
    pagina: 89 },
  { clave: "—", nombre: "Telmisartán / Hidroclorotiazida 80/12.5 mg",
    presentacion: "Tableta o cápsula, envase con 14",
    notas: "Aumenta toxicidad de litio y digoxina.",
    pagina: 81 },
];

function initFarmacos() {
  const list = document.getElementById("lista-farmacos");
  const input = document.getElementById("filtro-farmacos");
  const fuente = "Fuente: Cuadro de medicamentos del Cuadro Básico y Catálogo de Insumos del Sector Salud (CAUSES) reproducido en las GPC oficiales, págs. 81–90.";
  const pintar = f => {
    list.innerHTML = FARMACOS.filter(x =>
      !f || (x.nombre + x.clave + x.notas).toLowerCase().includes(f.toLowerCase()))
      .map(x => `<tr><td>${x.nombre}</td><td class="clave">${x.clave}</td>
        <td>${x.presentacion}</td><td>${x.notas} <em>(p. ${x.pagina})</em></td></tr>`)
      .join("") || `<tr><td colspan="4" class="sin-resultados">Sin coincidencias</td></tr>`;
  };
  pintar("");
  input.addEventListener("input", e => pintar(e.target.value.trim()));
  document.getElementById("fuente-farmacos").textContent = fuente;
}

/* ---------- remedios caseros con evidencia ---------- */

const EV_LABEL = {
  alta: "Evidencia sólida",
  moderada: "Evidencia moderada",
  limitada: "Evidencia limitada · bajo riesgo",
  mixta: "Evidencia mixta",
  tradicional: "Uso tradicional documentado",
};

const REMEDIOS = [
  {
    nombre: "Jamaica (Hibiscus sabdariffa)", icono: "🌺", categoria: "cardiovascular",
    uso: "Coadyuvante en hipertensión arterial leve y reducción modesta de LDL.",
    preparacion: "Infusión de la flor (agua de jamaica sin azúcar o tibia); en los ensayos clínicos, extracto estandarizado o 2 tazas al día por ≥ 4 semanas.",
    evidencia: "moderada",
    evidenciaNota: "Meta-análisis de 17 ECA (2022): reduce la presión sistólica −7.1 mmHg frente a control y −6.8 mg/dL de LDL; incluye ensayos mexicanos del IMSS comparando extracto estandarizado contra lisinopril.",
    seguridad: [
      "Efecto aditivo con antihipertensivos: vigilar PA para evitar hipotensión.",
      "Nunca suspender el tratamiento antihipertensivo prescrito por tomar jamaica.",
      "Precaución en embarazo por falta de datos de seguridad."
    ],
    fuentes: [
      { nombre: "Meta-análisis 2022 — PMC (17 ECA)", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9086798/" },
      { nombre: "Atlas de las Plantas de la Medicina Tradicional Mexicana (UNAM/INI)", url: "http://www.medicinatradicionalmexicana.unam.mx/" }
    ],
    enlaces: [
      { texto: "🗺️ Ver algoritmos clínicos (16 padecimientos)", vista: "algoritmo" },
      { texto: "🔎 Guías oficiales: tratamiento de la HAS", vista: "buscador",
        q: "tratamiento farmacológico inicial hipertensión", tema: "hipertension" }
    ]
  },
  {
    nombre: "Ajo (Allium sativum)", icono: "🧄", categoria: "cardiovascular",
    uso: "Coadyuvante en hipertensión; efecto hipotensor modesto documentado en hipertensos.",
    preparacion: "En los ensayos: suplementos de extracto o polvo de ajo (300–2,400 mg/día) por 2–24 semanas. El ajo culinario aporta dosis menores.",
    evidencia: "moderada",
    evidenciaNota: "Meta-análisis de ECA en hipertensos (Phytomedicine 2015): PAS −6.7 mmHg y PAD −4.8 mmHg vs placebo; meta-análisis 2020 (12 ECA): −8.3/−5.5 mmHg en hipertensos.",
    seguridad: [
      "Aumenta riesgo de sangrado con warfarina, antiagregantes o AINE; suspender suplementos antes de cirugía.",
      "Puede potenciar el efecto de antihipertensivos.",
      "En dosis culinarias es seguro; el efecto clínico se estudió con suplementos."
    ],
    fuentes: [
      { nombre: "Meta-análisis Xiong 2015 — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/25837272/" },
      { nombre: "Meta-análisis Ried 2020 — PMC", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6966103/" }
    ],
    enlaces: [
      { texto: "🗺️ Ver algoritmos clínicos (16 padecimientos)", vista: "algoritmo" },
      { texto: "🔎 Guías oficiales: metas de presión arterial", vista: "buscador",
        q: "meta de presión arterial según riesgo cardiovascular", tema: "hipertension" }
    ]
  },
  {
    nombre: "Avena (beta-glucano)", icono: "🥣", categoria: "cardiovascular",
    uso: "Reducción de colesterol LDL dentro de una dieta cardiosaludable.",
    preparacion: "≥ 3 g/día de beta-glucano de avena ≈ 70 g de avena tradicional (1 tazón) al día; el efecto en lípidos se aprecia tras 4–12 semanas.",
    evidencia: "alta",
    evidenciaNota: "La FDA autoriza desde 1997 la alegación de salud (21 CFR 101.81) para fibra soluble de avena y riesgo de enfermedad coronaria; meta-análisis: LDL −5 a −10 % con ≥ 3 g/día.",
    seguridad: [
      "Muy segura; puede dar gases o distensión al inicio.",
      "No sustituye estatinas cuando están indicadas por las guías.",
      "En celiaquía, usar avena certificada libre de gluten."
    ],
    fuentes: [
      { nombre: "FDA — Health claims autorizados (21 CFR 101.81)", url: "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/authorized-health-claims-meet-significant-scientific-agreement-ssa-standard" },
      { nombre: "Revisión de beta-glucano de avena — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/21631511/" }
    ],
    enlaces: [
      { texto: "🔎 Guías oficiales: metas de LDL en dislipidemia", vista: "buscador",
        q: "metas de LDL dislipidemia", tema: "dislipidemias" }
    ]
  },
  {
    nombre: "Psyllium (Plantago ovata)", icono: "🌾", categoria: "digestivo",
    uso: "Estreñimiento crónico, síntomas globales del SII y coadyuvante en colesterol LDL.",
    preparacion: "1 cucharada (≈ 5–7 g de fibra soluble) en un vaso grande de agua, 1–2 veces al día, acompañado de buena hidratación.",
    evidencia: "alta",
    evidenciaNota: "Recomendación fuerte (calidad moderada) de la guía canadiense de SII (CAG 2019) y sugerida por ACG 2021; la FDA autoriza alegación de reducción de riesgo coronario para psyllium (21 CFR 101.81).",
    seguridad: [
      "Tomar separado ≥ 2 h de fármacos de margen estrecho (levotiroxina, litio, warfarina, carbamazepina): reduce su absorción.",
      "Iniciar gradual para evitar distensión; indispensable abundante agua.",
      "Contraindicado si hay sospecha de obstrucción intestinal."
    ],
    fuentes: [
      { nombre: "Guía CAG de SII 2019 (recomendación fuerte)", url: "https://www.cag-acg.org/_Library/clinical_cpgs_position_papers/CAG_CPG_for_Management_of_IBS_JCAG_Jan2019.pdf" },
      { nombre: "FDA — Health claims autorizados (psyllium)", url: "https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/authorized-health-claims-meet-significant-scientific-agreement-ssa-standard" }
    ]
  },
  {
    nombre: "Miel de abeja", icono: "🍯", categoria: "respiratorio",
    uso: "Tos aguda por infección respiratoria alta, sobre todo nocturna, en niños mayores de 1 año y adultos.",
    preparacion: "1–2 cucharaditas solas o disueltas en agua tibia con limón, antes de dormir.",
    evidencia: "moderada",
    evidenciaNota: "Cochrane (CD007094, 2018): alivia la tos más que no tratar, placebo o difenhidramina, comparable a dextrometorfano; meta-análisis BMJ EBM 2021: superior a cuidado habitual en síntomas de IRAS.",
    seguridad: [
      "CONTRAINDICADA en menores de 1 año (riesgo de botulismo infantil).",
      "No recomendada de libre uso en diabetes por su carga glucémica.",
      "Complemento sintomático; no sustituye evaluación si hay datos de alarma."
    ],
    fuentes: [
      { nombre: "Cochrane — Miel para la tos aguda en niños", url: "https://www.cochrane.org/evidence/CD007094_honey-acute-cough-children" },
      { nombre: "Meta-análisis BMJ Evidence-Based Medicine 2021", url: "https://ebm.bmj.com/content/26/2/57" }
    ]
  },
  {
    nombre: "Lavado nasal con solución salina", icono: "💧", categoria: "respiratorio",
    uso: "Congestión nasal, secreción y molestias de resfriado y rinitis; el clásico “suero casero” de la abuela.",
    preparacion: "Solución salina isotónica (¼ cdita de sal en 250 ml de agua hervida y enfriada) en spray o lavado, 2–3 veces al día.",
    evidencia: "limitada",
    evidenciaNota: "Cochrane (CD006821, 2015): posible beneficio leve en síntomas de IRAS aguda (un ECA grande en niños mostró menos secreción y menor uso de descongestionantes); segura, con efectos adversos menores.",
    seguridad: [
      "Usar agua hervida o estéril, nunca directo de la llave (riesgo de infección).",
      "Lavarse las manos y lavar el aplicador.",
      "Si hay dolor de oído o sangrado, suspender y valorar."
    ],
    fuentes: [
      { nombre: "Cochrane — Irrigación nasal salina en IRAS (2015)", url: "https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD006821.pub3/full" }
    ]
  },
  {
    nombre: "Zinc en pastillas para chupar", icono: "💊", categoria: "respiratorio",
    uso: "Posible acortamiento de la duración del resfriado común si se inicia en las primeras 24 h.",
    preparacion: "Pastillas de acetato o gluconato de zinc disueltas lentamente cada 2–3 h, solo durante los primeros días del cuadro (máx. 1 semana a dosis altas).",
    evidencia: "mixta",
    evidenciaNota: "Cochrane 2024 (34 ECA, n=8,526): podría acortar el resfriado ~2 días, pero con certeza baja-muy baja e inconclusa; meta-análisis independientes con dosis > 75 mg/día reportan mayor efecto.",
    seguridad: [
      "NO usar zinc intranasal: asociado a pérdida del olfato (anosmia) permanente.",
      "Sabor metálico y náusea son frecuentes; suspender si molesta.",
      "Uso prolongado en dosis altas inhibe absorción de cobre."
    ],
    fuentes: [
      { nombre: "Cochrane — Zinc para el resfriado común (2024)", url: "https://www.cochrane.org/about-us/news/inconclusive-evidence-suggests-zinc-may-slightly-shorten-common-cold" }
    ]
  },
  {
    nombre: "Jengibre (Zingiber officinale)", icono: "🫚", categoria: "digestivo",
    uso: "Náusea y vómito del embarazo; también náusea leve en general.",
    preparacion: "Té de jengibre fresco o polvo; en los ensayos, < 1,500 mg/día en dosis divididas mostró mejor relación beneficio.",
    evidencia: "moderada",
    evidenciaNota: "Meta-análisis de 12 ECA (1,278 embarazadas, Nutrition Journal 2014): mejora significativa de la náusea vs placebo sin riesgo de eventos adversos; el NCCIH (NIH) lo considera potencialmente útil en el embarazo.",
    seguridad: [
      "Puede causar acidez o molestia abdominal en dosis altas.",
      "Precaución con anticoagulantes (riesgo teórico de sangrado).",
      "En embarazo, siempre informar a la obstetra antes de usarlo de forma regular."
    ],
    fuentes: [
      { nombre: "NCCIH (NIH) — Ginger: Usefulness and Safety", url: "https://www.nccih.nih.gov/health/ginger" },
      { nombre: "Meta-análisis Nutrition Journal 2014", url: "https://nutritionj.biomedcentral.com/counter/pdf/10.1186/1475-2891-13-20.pdf" }
    ]
  },
  {
    nombre: "Aceite de menta (Mentha piperita)", icono: "🌱", categoria: "digestivo",
    uso: "Síntomas globales y dolor abdominal del síndrome de intestino irritable (SII); antiespasmódico natural.",
    preparacion: "Cápsulas con recubrimiento entérico (≈ 180 mg) antes de los alimentos; el té de menta es más suave y sirve para distensión leve.",
    evidencia: "moderada",
    evidenciaNota: "Guía ACG 2021 de SII: sugiere su uso para alivio de síntomas globales (recomendación condicional); meta-análisis: NNT 3–4 vs placebo, seguridad comparable a placebo.",
    seguridad: [
      "Puede provocar o empeorar pirosis: usar formulación entérica y evitar en ERGE.",
      "El aceite esencial concentrado no debe ingerirse sin supervisión.",
      "No en niños pequeños sin indicación médica."
    ],
    fuentes: [
      { nombre: "Guía ACG 2021 — Manejo del SII (PDF)", url: "https://webfiles.gi.org/links/PCC/ACG_Clinical_Guideline__Management_of_Irritable.11.pdf" },
      { nombre: "Meta-análisis Alammar 2019 (BMC CAM)", url: "https://doi.org/10.52778/efsm.21.0276" }
    ]
  },
  {
    nombre: "Probióticos (yogur, cepas vivas)", icono: "🦠", categoria: "digestivo",
    uso: "Prevención de la diarrea asociada a antibióticos en adultos y niños.",
    preparacion: "Durante y unos días después del antibiótico; las cepas y dosis estudiadas son ≥ 5 mil millones de UFC/día.",
    evidencia: "moderada",
    evidenciaNota: "Cochrane 2025 (CD006095): reduce el riesgo de diarrea asociada a antibióticos (RR 0.67) y de C. difficile (RR 0.50, NNT ≈ 65); en pediatría (CD004827): RR 0.45, calidad moderada.",
    seguridad: [
      "Evitar en inmunocomprometidos graves, catéter venoso central o pacientes críticos.",
      "Los efectos son específicos de cepa y dosis; no todos los productos son iguales.",
      "Separar de la toma del antibiótico por 2–3 horas."
    ],
    fuentes: [
      { nombre: "Cochrane 2025 — Probióticos y C. difficile", url: "https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD006095.pub5/abstract" },
      { nombre: "Cochrane 2019 — DAA pediátrica", url: "https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD004827.pub5/information" }
    ]
  },
  {
    nombre: "Sábila (Aloe vera) tópica", icono: "🌵", categoria: "piel",
    uso: "Quemaduras leves de primer y segundo grado y piel irritada; el gel de la penca de toda la vida.",
    preparacion: "Gel fresco de la hoja o producto comercial puro, aplicado 2–3 veces al día sobre piel limpia.",
    evidencia: "moderada",
    evidenciaNota: "Meta-análisis de 9 ECA (2024): acorta el tiempo de curación de quemaduras de 2º grado (−3.8 días) sin aumentar infección; revisión sistemática 2007 (Burns): −8.8 días vs control. En heridas quirúrgicas profundas la evidencia es negativa.",
    seguridad: [
      "Solo en quemaduras leves; quemaduras extensas o de 3er grado requieren atención médica.",
      "NO usar en heridas quirúrgicas que cierran por segunda intención (retrasó la cicatrización en Cochrane 2012).",
      "Evitar el látex amarillo de la cáscara (irritante y laxante fuerte); posible dermatitis de contacto."
    ],
    fuentes: [
      { nombre: "Meta-análisis 2024 — Journal of Burn Care & Research", url: "https://oamonitor.ireland.openaire.eu/national/search/publication?pid=10.1093%2Fjbcr%2Firae061" },
      { nombre: "Revisión sistemática Burns 2007 — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/17499928/" }
    ]
  },
  {
    nombre: "Caldo de pollo, reposo e hidratación", icono: "🍲", categoria: "soporte",
    uso: "Resfriado y malestar general: la sopa de la abuela como medida de soporte.",
    preparacion: "Caldo caliente, líquidos abundantes y descanso durante el cuadro viral.",
    evidencia: "limitada",
    evidenciaNota: "Estudio publicado en Chest (2000, Univ. de Nebraska): el caldo de pollo inhibió la quimiotaxis de neutrófilos in vitro, posible efecto antiinflamatorio leve; sin ensayos clínicos que demuestren curar el resfriado. La hidratación y el reposo son medidas de soporte aceptadas.",
    seguridad: [
      "Medida segura; vigilar el sodio del caldo en hipertensos e insuficiencia cardiaca.",
      "No retrasa la consulta si hay fiebre persistente, disnea o datos de alarma."
    ],
    fuentes: [
      { nombre: "Rennard et al., Chest 2000 — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/11035691/" }
    ]
  },
  {
    nombre: "Eucalipto (cineol)", icono: "🌿", categoria: "respiratorio",
    uso: "Bronquitis aguda y rinosinusitis: tos, congestión y secreción; el clásico vapor de eucalipto.",
    preparacion: "La evidencia clínica es con cápsulas orales de cineol (200 mg, 3/día, uso médico). En casa: inhalación de vapor con hojas o 2–3 gotas de aceite esencial en agua caliente.",
    evidencia: "moderada",
    evidenciaNota: "ECA doble ciego multicéntrico (n=242): el cineol mejoró el score de bronquitis aguda vs placebo a los 4 días (p=0.038) y redujo los accesos de tos (p=0.0001); ECA en rinosinusitis aguda (Kehrl 2004) con beneficio significativo. Es medicamento registrado en Alemania; la inhalación de vapor casera tiene evidencia más débil que las cápsulas.",
    seguridad: [
      "El aceite esencial de eucalipto NO se ingiere: es tóxico por vía oral (convulsiones, incluso en dosis pequeñas).",
      "Evitar vapores en menores de 2 años (riesgo de laringoespasmo).",
      "Puede desencadenar broncoespasmo en asmáticos sensibles."
    ],
    fuentes: [
      { nombre: "ECA bronquitis aguda (n=242) — PMC", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3842692/" },
      { nombre: "ECA rinosinusitis Kehrl 2004 — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/15064633/" }
    ]
  },
  {
    nombre: "Manzanilla (Matricaria chamomilla)", icono: "🌼", categoria: "digestivo",
    uso: "Nervios leves y ansiedad leve-moderada; digestión pesada y cólicos: el té de manzanilla de toda la vida.",
    preparacion: "Té de la flor (1 cda por taza, 2–3 veces al día). Los ensayos clínicos de ansiedad usaron extracto estandarizado en cápsulas.",
    evidencia: "limitada",
    evidenciaNota: "ECA (Amsterdam 2009, J Clin Psychopharmacol): reducción modesta pero significativa de la ansiedad generalizada leve-moderada vs placebo; el NCCIH la considera prometedora pero preliminar y no concluyente. Para uso digestivo el respaldo es principalmente tradicional documentado.",
    seguridad: [
      "Muy segura en té; posible alergia en personas sensibles a Asteraceae (margarita, ambrosía).",
      "Precaución teórica con anticoagulantes en uso abundante.",
      "En embarazo, consumo ocasional en té; evitar extractos concentrados sin indicación."
    ],
    fuentes: [
      { nombre: "NCCIH (NIH) — Chamomile", url: "https://www.nccih.nih.gov/health/chamomile" },
      { nombre: "ECA Amsterdam 2009 — PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/19593179/" }
    ]
  },
  {
    nombre: "Toronjil (Melissa officinalis)", icono: "🍃", categoria: "digestivo",
    uso: "Nervios, dificultad para dormir y malestar digestivo de origen nervioso; la “yerba del susto”.",
    preparacion: "Té de hojas (1–2 cdtas por taza) por la tarde-noche; en los estudios, extractos de 300–600 mg.",
    evidencia: "limitada",
    evidenciaNota: "Revisión 2024 de ensayos clínicos: perfil calmante con mejora de ansiedad y calidad de sueño en varios ECA pequeños; meta-análisis 2021 (Phytother Res) favorable para ansiedad y depresión leve. Faltan ensayos grandes.",
    seguridad: [
      "Generalmente segura en té; en dosis altas de extracto puede dar palpitaciones o reducir la alerta.",
      "Uso tradicional en hipertiroidismo: precaución con levotiroxina (posible interferencia).",
      "Sin datos de seguridad en embarazo y lactancia."
    ],
    fuentes: [
      { nombre: "Revisión clínica 2024 — PMC", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11510126/" },
      { nombre: "Meta-análisis 2021 — Phytotherapy Research", url: "https://doi.org/10.1002/ptr.7252" }
    ]
  },
  {
    nombre: "Orégano (Origanum vulgare)", icono: "🌱", categoria: "respiratorio",
    uso: "Té de orégano para la tos y la garganta: remedio de la abuela con base tradicional sólida, ciencia aún preliminar.",
    preparacion: "Té de la hoja (1 cdta por taza). Como especia culinaria es seguro y aporta antioxidantes.",
    evidencia: "tradicional",
    evidenciaNota: "Documentado en el Atlas de las Plantas de la Medicina Tradicional Mexicana (UNAM/INI). Su actividad antimicrobiana (carvacrol y timol) está probada in vitro y en animales, pero NO hay ensayos clínicos en humanos que demuestren eficacia para infecciones.",
    seguridad: [
      "Seguro como alimento y té ocasional.",
      "El aceite esencial de orégano es irritante: nunca puro en piel ni ingerido sin diluir; no en menores de 5 años.",
      "No sustituye antibióticos cuando están indicados."
    ],
    fuentes: [
      { nombre: "Atlas de las Plantas de la Medicina Tradicional Mexicana (UNAM/INI)", url: "http://www.medicinatradicionalmexicana.unam.mx/" },
      { nombre: "Revisión de actividad biológica — PMC", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC6152729/" }
    ]
  },
  {
    nombre: "Gárgaras con agua tibia y sal", icono: "🧂", categoria: "soporte",
    uso: "Dolor de garganta leve y higiene bucal; medida tradicional de alivio sintomático.",
    preparacion: "½ cucharadita de sal en un vaso de agua tibia; gárgaras 2–3 veces al día sin tragar.",
    evidencia: "limitada",
    evidenciaNota: "Evidencia formal escasa pero práctica inocua y barata recomendada de forma empírica para faringitis leve; su valor principal es sintomático y de higiene.",
    seguridad: [
      "No tragar la solución (carga de sodio).",
      "Niños pequeños que no saben hacer gárgaras: riesgo de broncoaspiración.",
      "Si hay fiebre alta, exudado o disfagia, requiere valoración médica."
    ],
    fuentes: [
      { nombre: "Biblioteca Digital de la Medicina Tradicional Mexicana (UNAM/INI)", url: "http://www.medicinatradicionalmexicana.unam.mx/" }
    ]
  },
];

/* Enlaces de salto para los remedios sin `enlaces` inline en REMEDIOS */
const ENLACES_EXTRA = {
  "Psyllium (Plantago ovata)": [
    { texto: "🔎 Guías oficiales: metas de LDL en dislipidemia", vista: "buscador",
      q: "metas de LDL dislipidemia", tema: "dislipidemias" }
  ],
  "Miel de abeja": [
    { texto: "🔎 Guías oficiales: cuándo sí va antibiótico (NAC)", vista: "buscador",
      q: "criterios de antibiótico neumonía adquirida en la comunidad", tema: "neumonia" }
  ],
  "Lavado nasal con solución salina": [
    { texto: "🔎 Guías oficiales: datos de alarma en infección respiratoria", vista: "buscador",
      q: "datos de alarma referencia neumonía", tema: "neumonia" }
  ],
  "Zinc en pastillas para chupar": [
    { texto: "🔎 Guías oficiales: cuándo sí va antibiótico (NAC)", vista: "buscador",
      q: "criterios de antibiótico neumonía adquirida en la comunidad", tema: "neumonia" }
  ],
  "Jengibre (Zingiber officinale)": [
    { texto: "⚠️ Embarazo y anticoagulantes: ver reglas de seguridad", vista: "seguridad" }
  ],
  "Aceite de menta (Mentha piperita)": [
    { texto: "⚠️ Pirosis, ERGE y niños: ver reglas de seguridad", vista: "seguridad" }
  ],
  "Probióticos (yogur, cepas vivas)": [
    { texto: "🔎 Guías oficiales: antibiótico de primera línea en NAC", vista: "buscador",
      q: "antibiótico de primera línea neumonía", tema: "neumonia" }
  ],
  "Sábila (Aloe vera) tópica": [
    { texto: "⚠️ Quemaduras graves y heridas: ver reglas de seguridad", vista: "seguridad" }
  ],
  "Caldo de pollo, reposo e hidratación": [
    { texto: "🔎 Guías oficiales: datos de alarma en infección respiratoria", vista: "buscador",
      q: "datos de alarma referencia neumonía", tema: "neumonia" }
  ],
  "Eucalipto (cineol)": [
    { texto: "🔎 Guías oficiales: tratamiento del EPOC", vista: "buscador",
      q: "tratamiento EPOC estable y exacerbación", tema: "epoc" },
    { texto: "🔎 Guías oficiales: tratamiento del asma", vista: "buscador",
      q: "tratamiento asma bronquial", tema: "asma" }
  ],
  "Manzanilla (Matricaria chamomilla)": [
    { texto: "⚠️ Alergia y embarazo: ver reglas de seguridad", vista: "seguridad" }
  ],
  "Toronjil (Melissa officinalis)": [
    { texto: "⚠️ Tiroides, embarazo y lactancia: ver reglas de seguridad", vista: "seguridad" }
  ],
  "Orégano (Origanum vulgare)": [
    { texto: "🔎 Guías oficiales: cuándo sí va antibiótico (NAC)", vista: "buscador",
      q: "criterios de antibiótico neumonía adquirida en la comunidad", tema: "neumonia" }
  ],
  "Gárgaras con agua tibia y sal": [
    { texto: "⚠️ Datos de alarma en dolor de garganta: ver reglas de seguridad", vista: "seguridad" }
  ]
};

function initRemedios() {
  const lista = document.getElementById("lista-remedios");
  const inputTexto = document.getElementById("filtro-remedios-texto");
  let catActual = "todas";

  const normT = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const pintar = () => {
    const q = normT(inputTexto.value.trim());
    const sel = REMEDIOS.filter(r => {
      if (catActual !== "todas" && r.categoria !== catActual) return false;
      if (!q) return true;
      const palabras = normT([r.nombre, r.uso, r.preparacion, r.evidenciaNota,
        r.seguridad.join(" ")].join(" ")).split(/[^a-z0-9]+/);
      return q.split(/\s+/).every(t => palabras.some(w => w.startsWith(t)));
    });
    lista.innerHTML = sel.length ? sel.map(r => `
      <div class="card remedio">
        <div class="remedio-head">
          <span class="remedio-icono">${r.icono}</span>
          <h4>${r.nombre}</h4>
          <span class="badge-ev ${r.evidencia}">${EV_LABEL[r.evidencia]}</span>
        </div>
        <p class="remedio-uso"><strong>Para qué:</strong> ${r.uso}</p>
        <p><strong>Cómo se usa:</strong> ${r.preparacion}</p>
        <p class="remedio-ev"><strong>Qué dice la evidencia:</strong> ${r.evidenciaNota}</p>
        <div class="remedio-seg">
          <strong>Seguridad:</strong>
          <ul>${r.seguridad.map(s => `<li>${s}</li>`).join("")}</ul>
        </div>
        <div class="remedio-fuentes">
          ${r.fuentes.map(f => `<a href="${f.url}" target="_blank" rel="noopener">${f.nombre} ↗</a>`).join("")}
        </div>
        ${(r.enlaces || ENLACES_EXTRA[r.nombre]) ? `<div class="remedio-enlaces">` + (r.enlaces || ENLACES_EXTRA[r.nombre]).map((e, i) =>
          `<button class="link-salto" data-r="${REMEDIOS.indexOf(r)}" data-e="${i}">${e.texto}</button>`
        ).join("") + `</div>` : ""}
      </div>`).join("")
      : `<p class="sin-resultados" style="grid-column:1/-1">Sin remedios que coincidan
        con la búsqueda. Prueba con otro síntoma (tos, náusea, presión, dormir…)
        o revisa la categoría seleccionada.</p>`;
  };

  pintar();
  inputTexto.addEventListener("input", pintar);
  lista.addEventListener("click", ev => {
    const b = ev.target.closest(".link-salto");
    if (!b) return;
    const r0 = REMEDIOS[+b.dataset.r];
    const e = (r0.enlaces || ENLACES_EXTRA[r0.nombre])[+b.dataset.e];
    irA(e.vista, e.q, e.tema);
  });
  document.querySelectorAll(".filtro-remedios .chip-tema").forEach(ch =>
    ch.addEventListener("click", () => {
      catActual = ch.dataset.cat;
      document.querySelectorAll(".filtro-remedios .chip-tema").forEach(c =>
        c.classList.toggle("activo", c === ch));
      pintar();
    }));
}

/* ---------- navegación entre secciones (remedio → algoritmo / guías) ---------- */

let RUN_QUERY = null; // la asigna init() al crear `run`

function irA(vista, q, tema) {
  if (vista === "seguridad") {
    const tabR = document.querySelector('.tabs .tab[data-vista="remedios"]');
    if (tabR) tabR.click();
    const aviso = document.querySelector(".aviso-seguridad");
    if (aviso) aviso.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const tab = document.querySelector(`.tabs .tab[data-vista="${vista}"]`);
  if (tab) tab.click();
  if (vista === "buscador" && q && RUN_QUERY) {
    if (tema) {
      TEMA_ACTUAL = tema;
      document.querySelectorAll(".chip-tema[data-tema]").forEach(c =>
        c.classList.toggle("activo", c.dataset.tema === tema));
    }
    document.getElementById("q").value = q;
    RUN_QUERY(q);
  }
}

/* ---------- pestañas principales ---------- */

function initTabs() {
  const irInicio = () => {
    document.querySelectorAll(".tabs .tab").forEach(t =>
      t.classList.toggle("activo", t.dataset.vista === "buscador"));
    const res = document.getElementById("resultados");
    delete res.dataset.mostrado;
    res.hidden = true;
    document.getElementById("inicio").hidden = false;
    document.getElementById("hero").hidden = false;
    document.getElementById("remedios").hidden = true;
    document.getElementById("algoritmo").hidden = true;
    document.getElementById("padecimientos").hidden = true;
    const sug = document.getElementById("sugerencias");
    if (sug) sug.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  document.getElementById("btn-home").addEventListener("click", irInicio);
  const brand = document.getElementById("brand-home");
  brand.addEventListener("click", irInicio);
  brand.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); irInicio(); }
  });

  document.querySelectorAll(".tabs .tab").forEach(tab =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tabs .tab").forEach(t =>
        t.classList.toggle("activo", t === tab));
      const vista = tab.dataset.vista;
      const hayResultados = !!document.getElementById("resultados").dataset.mostrado;
      document.getElementById("hero").hidden = vista !== "buscador";
      document.getElementById("remedios").hidden = vista !== "remedios";
      document.getElementById("algoritmo").hidden = vista !== "algoritmo";
      document.getElementById("padecimientos").hidden = vista !== "padecimientos";
      document.getElementById("resultados").hidden = vista !== "buscador" || !hayResultados;
      document.getElementById("inicio").hidden = vista !== "buscador" || hayResultados;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));
}

/* ---------- arranque ---------- */

/* ---------- hub de padecimientos + buscador de sección ---------- */

const ICONOS_PADECIMIENTO = {
  hipertension: "🫀", diabetes: "🍬", dislipidemias: "🧈", obesidad: "⚖️",
  asma: "🫁", epoc: "🚬", neumonia: "🌡️", erc: "🫘", depresion: "🧠",
  ansiedad: "💭", hipotiroidismo: "🦋", cefalea: "⚡", anemia: "🩸",
  ivu: "🧫", artritis: "🤲", osteoporosis: "🦴",
};

const DESCRIPCION_PADECIMIENTO = {
  hipertension: "Elevación persistente de la presión arterial ≥ 140/90 mm Hg; estratificar riesgo cardiovascular guía el tratamiento.",
  diabetes: "Hiperglucemia crónica confirmada con HbA1c; metformina es el inicio y las metas se individualizan.",
  dislipidemias: "Colesterol y triglicéridos alterados; la meta de LDL depende del riesgo cardiovascular (≤116 a <55 mg/dL).",
  obesidad: "IMC > 30 kg/m² (o > 27 con comorbilidad); meta de pérdida > 5 % del peso con mejora clínica.",
  asma: "Enfermedad inflamatoria crónica de vías respiratorias; en exacerbación, β2 de acción rápida y oxígeno.",
  epoc: "Obstrucción bronquial crónica, casi siempre por tabaquismo; confirma con espirometría con broncodilatador.",
  neumonia: "Infección aguda del parénquima pulmonar con infiltrado nuevo en radiografía; estratifica con PSI/CURB-65.",
  erc: "TFG < 60 mL/min/1.73 m² o daño renal ≥ 3 meses; IECA/ARA II si proteinuria.",
  depresion: "Trastorno del ánimo con afectación funcional; preguntar siempre por ideas de muerte o suicidio.",
  ansiedad: "TAG, pánico y fobias; TCC y antidepresivos de base, BZD solo corto plazo.",
  hipotiroidismo: "TSH elevada; levotiroxina 1.6–1.8 mcg/kg/día, dosis bajas si mayor de 65 años o cardiopatía.",
  cefalea: "Tensional (bilateral, opresiva) o migraña; banderas rojas mandan a referencia inmediata.",
  anemia: "Hb baja, con déficit de hierro como causa principal en adultos; sulfato ferroso de primera línea.",
  ivu: "Infección urinaria baja en la mujer no embarazada; TMP/SMZ o nitrofurantoína según GPC.",
  artritis: "Artritis simétrica autoinmune; iniciar FARME (metotrexato) lo antes posible.",
  osteoporosis: "Masa ósea baja con riesgo de fractura; alendronato + calcio y vitamina D.",
};

function navegarAlgoritmo(tema) {
  const tab = document.querySelector('.tabs .tab[data-vista="algoritmo"]');
  if (tab) tab.click();
  const chip = document.querySelector(`.chip-alg[data-alg="${tema}"]`);
  if (chip) chip.click();
}

function initPadecimientos() {
  const grid = document.getElementById("padecimientos-grid");
  if (!grid) return;
  grid.innerHTML = Object.keys(NOMBRE_PADECIMIENTO).map(t => {
    const nFuentes = IDX.meta.docs.filter(d => d.tema === t).length;
    return `<button type="button" class="pad-card" data-tema="${t}">
      <span class="pad-icono">${ICONOS_PADECIMIENTO[t]}</span>
      <span class="pad-nombre">${NOMBRE_PADECIMIENTO[t]}</span>
      <span class="pad-desc">${DESCRIPCION_PADECIMIENTO[t]}</span>
      <span class="pad-fuentes">${nFuentes} fuentes oficiales</span>
    </button>`;
  }).join("");
  grid.querySelectorAll(".pad-card").forEach(b =>
    b.addEventListener("click", () => pintarHubPadecimiento(b.dataset.tema)));
}

function pintarHubPadecimiento(tema) {
  const detalle = document.getElementById("padecimiento-detalle");
  const grid = document.getElementById("padecimientos-grid");
  const nombre = NOMBRE_PADECIMIENTO[tema];

  const ev = buscar(nombre, 5, tema);
  const sol = sintetizar(buscar(`tratamiento ${nombre}`, 8, tema), `tratamiento ${nombre}`);
  const docs = IDX.meta.docs.filter(d => d.tema === tema);
  const claves = (ALIAS_PADECIMIENTOS[tema] || []).filter(a => a.length >= 4);
  const remedios = REMEDIOS.filter(r => {
    const texto = norm([r.nombre, r.uso, r.preparacion, r.evidenciaNota].join(" ").toLowerCase());
    return claves.some(k => texto.includes(norm(k.toLowerCase())));
  });

  let html = `<button type="button" class="chip" id="pad-volver">← Todos los padecimientos</button>
    <div class="card pad-header">
      <span class="pad-icono grande">${ICONOS_PADECIMIENTO[tema]}</span>
      <div><h3>${nombre}</h3><p>${DESCRIPCION_PADECIMIENTO[tema]}</p></div>
    </div>
    <div class="pad-bloques">
    <div class="card pad-bloque"><h4>💊 Soluciones — tratamiento basado en guías</h4>`;
  html += sol.length
    ? `<ul>${sol.slice(0, 5).map(o => `<li>${o.s} <span class="cite">[${o.ref + 1}]</span></li>`).join("")}</ul>`
    : `<p class="nota">Ver el algoritmo clínico y las fuentes oficiales de abajo.</p>`;
  html += `</div>
    <div class="card pad-bloque"><h4>🗺️ Algoritmo clínico de primer nivel</h4>
    <p class="nota">Secuencia decisión → acción con criterios de referencia a segundo nivel.</p>
    <button type="button" class="btn-algoritmo" id="pad-ver-alg">📋 Ver algoritmo de ${nombre}</button></div>
    <div class="card pad-bloque"><h4>🌿 Remedios con evidencia relacionados</h4>`;
  html += remedios.length
    ? `<ul class="pad-lista">${remedios.map(r => `<li><strong>${r.icono} ${r.nombre}</strong> — ${r.uso}</li>`).join("")}</ul>`
    : `<p class="nota">Sin remedios con evidencia indexados para este padecimiento.</p>`;
  html += `</div>
    <div class="card pad-bloque"><h4>📚 Evidencias que respaldan el padecimiento</h4>`;
  html += ev.length
    ? `<ul class="pad-lista">${ev.map(([cid]) => {
        const info = chunkInfo(cid);
        const txt = limpiar(info.texto);
        const recorte = txt.length > 220 ? txt.slice(0, 220).replace(/\s\S*$/, "") + "…" : txt;
        return `<li>${recorte} <span class="sug-fuente">${info.docCorto} · p.${info.pagina}</span></li>`;
      }).join("")}</ul>`
    : `<p class="nota">Sin fragmentos indexados.</p>`;
  html += `</div>
    <div class="card pad-bloque"><h4>📖 Fuentes oficiales (${docs.length})</h4>
    <ul class="pad-lista">${docs.map(d => `<li><strong>${d.nombre}</strong><br><span class="vig">${d.vigencia}</span></li>`).join("")}</ul></div>
    </div>`;

  detalle.innerHTML = html;
  grid.hidden = true;
  detalle.hidden = false;
  detalle.querySelector("#pad-volver").addEventListener("click", () => {
    detalle.hidden = true; grid.hidden = false;
  });
  detalle.querySelector("#pad-ver-alg").addEventListener("click", () => navegarAlgoritmo(tema));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- buscador de sección: cubre evidencias + algoritmos + remedios ---------- */

function buscarPasosAlgoritmo(q, limite = 4) {
  const terms = tokenize(q);
  if (!terms.length) return [];
  const matches = [];
  document.querySelectorAll("#algoritmo .alg").forEach(alg => {
    alg.querySelectorAll("li.paso").forEach(paso => {
      if (matches.length >= limite) return;
      const t = norm(paso.textContent.toLowerCase());
      if (terms.some(term => t.includes(term))) {
        matches.push({ tema: alg.dataset.alg, paso,
          titulo: (paso.querySelector("h4") || {}).textContent || "Paso" });
      }
    });
  });
  return matches;
}

function buscarRemediosData(q, limite = 4) {
  const terms = tokenize(q);
  if (!terms.length) return [];
  return REMEDIOS.filter(r => {
    const palabras = norm([r.nombre, r.uso, r.preparacion, r.evidenciaNota].join(" ").toLowerCase())
      .split(/[^a-z0-9ñ]+/);
    return terms.some(t => palabras.some(w => w.startsWith(t)));
  }).slice(0, limite);
}

function pintarBusquedaSeccion(q, contenedor) {
  const ev = buscar(q, 4, "todos");
  const algs = buscarPasosAlgoritmo(q);
  const rems = buscarRemediosData(q);
  if (!ev.length && !algs.length && !rems.length) {
    contenedor.innerHTML = `<p class="nota">Sin coincidencias en evidencias, algoritmos ni remedios para “${escHtml(q)}”.</p>`;
    contenedor.hidden = false;
    return;
  }
  let html = "";
  if (ev.length) {
    html += `<div class="res-grupo"><strong>📚 Evidencia</strong>` + ev.map(([cid]) => {
      const info = chunkInfo(cid);
      const txt = limpiar(info.texto);
      return `<button type="button" class="res-item" data-acc="ev" data-q="${escHtml(q)}">
        <span class="res-texto">${escHtml(txt.slice(0, 130))}${txt.length > 130 ? "…" : ""}</span>
        <span class="sug-fuente">${info.docCorto} · p.${info.pagina}</span></button>`;
    }).join("") + `</div>`;
  }
  if (algs.length) {
    html += `<div class="res-grupo"><strong>🗺️ Algoritmos clínicos</strong>` + algs.map(a =>
      `<button type="button" class="res-item" data-acc="alg" data-tema="${a.tema}">
        <span class="res-texto">${ICONOS_PADECIMIENTO[a.tema]} ${NOMBRE_PADECIMIENTO[a.tema]} — ${escHtml(a.titulo)}</span></button>`).join("") + `</div>`;
  }
  if (rems.length) {
    html += `<div class="res-grupo"><strong>🌿 Remedios</strong>` + rems.map(r =>
      `<button type="button" class="res-item" data-acc="rem" data-nombre="${escHtml(r.nombre)}">
        <span class="res-texto">${r.icono} ${escHtml(r.nombre)}</span>
        <span class="sug-fuente">${escHtml(r.uso.slice(0, 70))}${r.uso.length > 70 ? "…" : ""}</span></button>`).join("") + `</div>`;
  }
  contenedor.innerHTML = html;
  contenedor.hidden = false;
  contenedor.querySelectorAll('.res-item[data-acc="ev"]').forEach(b =>
    b.addEventListener("click", () => {
      const tab = document.querySelector('.tabs .tab[data-vista="buscador"]');
      if (tab) tab.click();
      document.getElementById("q").value = b.dataset.q;
      RUN_QUERY(b.dataset.q);
    }));
  contenedor.querySelectorAll('.res-item[data-acc="alg"]').forEach(b =>
    b.addEventListener("click", () => navegarAlgoritmo(b.dataset.tema)));
  contenedor.querySelectorAll('.res-item[data-acc="rem"]').forEach(b =>
    b.addEventListener("click", () => {
      const tab = document.querySelector('.tabs .tab[data-vista="remedios"]');
      if (tab) tab.click();
      const input = document.getElementById("filtro-remedios-texto");
      if (input) {
        input.value = b.dataset.nombre;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(() => input.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
      }
    }));
}

function initBuscadoresSeccion() {
  [["q-algoritmo", "res-algoritmo"], ["q-remedios-global", "res-remedios-global"]].forEach(([inpId, resId]) => {
    const input = document.getElementById(inpId);
    const cont = document.getElementById(resId);
    if (!input || !cont) return;
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const q = input.value.trim();
        if (q.length >= 3) pintarBusquedaSeccion(q, cont);
      }
    });
    input.addEventListener("input", () => { if (input.value.trim().length < 3) cont.hidden = true; });
  });
}

/* ---------- sugerencias de búsqueda y respaldo sin resultados ---------- */

const escHtml = s => s.replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Expansión por prefijo: términos del índice que empiecen como el escrito
   (rescue de errores de dedo / variantes: "hipertension" → "hipertensión" ya
   normalizado; "sulfatoferroso" → término indexado más cercano). */
function expandirConsulta(q) {
  const terms = rawTerms(norm(q.toLowerCase()));
  if (!terms.length) return null;
  let cambio = false;
  const salida = terms.map(w => {
    if (w.length < 4 || IDX.idf[w] !== undefined) return w;
    let mejor = null, mejorIdf = Infinity;
    for (const v in IDX.idf) {
      if (v.startsWith(w) && IDX.idf[v] < mejorIdf) { mejor = v; mejorIdf = IDX.idf[v]; }
    }
    if (mejor) { cambio = true; return mejor; }
    return w;
  });
  return cambio ? salida.join(" ") : null;
}

/* Frases candidatas del catálogo que contienen los términos escritos.
   Alimenta tanto el panel en vivo como las consultas sugeridas del vacío. */
function frasesDelCatalogo(q, limite = 6) {
  const terms = tokenize(q);
  if (!terms.length) return [];
  const sugs = new Map();
  for (const [cid] of buscar(q, 24, TEMA_ACTUAL)) {
    const c = IDX.chunks[cid];
    const doc = IDX.meta.docs[c[0]];
    for (const s of oraciones(c[2])) {
      const t = limpiar(s);
      // descartar fragmentos de tabla (alta densidad de dígitos / encabezados)
      if (/^(f[aá]rmaco|cuadro|tabla|dosis|presentaci[oó]n|principio activo|clave)\b/i.test(t)) continue;
      if (((t.match(/\d/g) || []).length / t.length) > 0.12) continue;
      if (t.length < 25 || t.length > 160) continue;
      const baj = norm(t.toLowerCase());
      if (!terms.some(term => baj.includes(term))) continue;
      if (!VERBO_ACCION.test(t) && !/\d/.test(t)) continue;
      const clave = t.slice(0, 50);
      if ([...sugs.keys()].some(k => k === clave || k.startsWith(clave) || clave.startsWith(k))) continue;
      sugs.set(clave, { texto: t, fuente: `${doc.corto} · p.${c[1]}` });
      if (sugs.size >= limite) return [...sugs.values()];
    }
  }
  return [...sugs.values()];
}

/* Consultas sugeridas cuando no hay NADA: termino por término + ejemplos del catálogo */
function sugerirConsultas(q) {
  const directas = frasesDelCatalogo(q, 4);
  if (directas.length) return directas;
  const terms = tokenize(q);
  const salida = [];
  const vistos = new Set();
  for (const t of terms) {
    for (const [cid] of buscar(t, 6, "todos")) {
      const c = IDX.chunks[cid];
      const doc = IDX.meta.docs[c[0]];
      const frase = oraciones(c[2]).map(limpiar)
        .find(s => s.length >= 25 && s.length <= 120 && (VERBO_ACCION.test(s) || /\d/.test(s)) &&
          !/^(f[aá]rmaco|cuadro|tabla|dosis|presentaci[oó]n|principio activo|clave)\b/i.test(s) &&
          ((s.match(/\d/g) || []).length / s.length) <= 0.12);
      if (!frase) continue;
      const clave = frase.slice(0, 50);
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      salida.push({ texto: frase, fuente: `${doc.corto} · p.${c[1]}` });
      break;
    }
    if (salida.length >= 4) break;
  }
  if (salida.length) return salida;
  // último recurso: las búsquedas de ejemplo curadas que ya vive en la portada
  return [...document.querySelectorAll(".ejemplos .chip[data-q]")]
    .slice(0, 4)
    .map(ch => ({ texto: ch.dataset.q, fuente: "búsqueda de ejemplo" }));
}

/* Panel de sugerencias mientras se escribe (debounce + teclado) */
function initSugerencias(run) {
  const input = document.getElementById("q");
  const box = document.getElementById("sugerencias");
  if (!input || !box) return;
  let items = [], activo = -1, timer = null;

  const pintar = () => {
    if (!items.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = items.map((s, i) => {
      const texto = s.texto.length > 110 ? s.texto.slice(0, 110).replace(/\s\S*$/, "") + "…" : s.texto;
      return `<button type="button" class="sug-item${i === activo ? " activo" : ""}" data-i="${i}">
        <span class="sug-texto">${escHtml(texto)}</span>
        <span class="sug-fuente">${escHtml(s.fuente)}</span>
      </button>`;
    }).join("");
    box.hidden = false;
    box.querySelectorAll(".sug-item").forEach(b =>
      b.addEventListener("mousedown", e => { e.preventDefault(); elegir(+b.dataset.i); }));
  };

  const elegir = i => {
    const s = items[i];
    if (!s) return;
    input.value = s.texto;
    box.hidden = true; items = []; activo = -1;
    run(input.value);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { box.hidden = true; items = []; return; }
    timer = setTimeout(() => { items = frasesDelCatalogo(q, 6); activo = -1; pintar(); }, 180);
  });
  input.addEventListener("keydown", e => {
    if (box.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); activo = (activo + 1) % items.length; pintar(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); activo = (activo - 1 + items.length) % items.length; pintar(); }
    else if (e.key === "Enter" && activo >= 0) { e.preventDefault(); e.stopImmediatePropagation(); elegir(activo); }
    else if (e.key === "Escape") { box.hidden = true; activo = -1; }
  });
  input.addEventListener("blur", () => setTimeout(() => { box.hidden = true; activo = -1; }, 150));
}

/* ---------- selector de algoritmos clínicos ---------- */
function initAlgoritmos() {
  const chips = [...document.querySelectorAll(".chip-alg")];
  const algs = [...document.querySelectorAll("#algoritmo .alg")];
  if (!chips.length || !algs.length) return;

  const mostrar = algId => {
    chips.forEach(c => c.classList.toggle("activo", c.dataset.alg === algId));
    algs.forEach(a => { a.hidden = a.dataset.alg !== algId; });
    const alg = algs.find(a => a.dataset.alg === algId);
    if (alg) alg.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  chips.forEach(c => c.addEventListener("click", () => mostrar(c.dataset.alg)));
  mostrar("hipertension");
}

async function init() {
  const res = await fetch("index.json");
  IDX = await res.json();
  DOCS_TEMA = IDX.meta.docs.map(d => d.tema);

  // lista de fuentes agrupadas por padecimiento
  const temas = [...new Set(IDX.meta.docs.map(d => d.tema))];
  const nombreTema = { hipertension: "Hipertensión arterial", diabetes: "Diabetes mellitus tipo 2",
                       dislipidemias: "Dislipidemias", obesidad: "Sobrepeso y obesidad",
                       epoc: "EPOC", asma: "Asma bronquial", neumonia: "Neumonía adquirida en la comunidad",
                       erc: "Enfermedad renal crónica", depresion: "Trastorno depresivo",
                       ansiedad: "Trastornos de ansiedad", hipotiroidismo: "Hipotiroidismo",
                       cefalea: "Cefalea y migraña", anemia: "Anemia ferropénica",
                       ivu: "IVU en la mujer", artritis: "Artritis reumatoide",
                       osteoporosis: "Osteoporosis",
                       evc: "EVC isquémica", embarazo_hipertensivo: "Enf. hipertensivas del embarazo",
                       hemorragia_obstetrica: "Choque hemorrágico obstétrico",
                       parto_pretermino: "Parto pretérmino", apendicitis: "Apendicitis aguda",
                       colecistitis: "Colecistitis y colelitiasis", pancreatitis: "Pancreatitis aguda",
                       dispepsia: "Dispepsia funcional", sinusitis: "Sinusitis aguda",
                       faringoamigdalitis: "Faringoamigdalitis", conjuntivitis: "Conjuntivitis",
                       bronquiolitis: "Bronquiolitis" };
  document.getElementById("doclist").innerHTML = temas.map(t => {
    const docs = IDX.meta.docs.filter(d => d.tema === t);
    return `<li class="tema-grupo"><strong>${nombreTema[t] || t}</strong> (${docs.length} fuentes)<ul>` +
      docs.map(d => `<li class="tema-doc">${d.nombre}<br><span class="vig">${d.vigencia}</span></li>`).join("") +
      `</ul></li>`;
  }).join("");
  document.getElementById("cargando").hidden = true;

  initCedula();
  initModalIA();
  initFarmacos();
  initRemedios();
  initAlgoritmos();
  initPadecimientos();
  initBuscadoresSeccion();
  initTabs();

  const run = q => {
    q = q.trim();
    if (!q) return;
    const panelSug = document.getElementById("sugerencias");
    if (panelSug) panelSug.hidden = true;

    // detección de padecimiento por alias (clínico o coloquial)
    const padecimiento = detectarPadecimiento(q);
    if (padecimiento && padecimiento !== TEMA_ACTUAL) {
      TEMA_ACTUAL = padecimiento;
      document.querySelectorAll(".chip-tema").forEach(c =>
        c.classList.toggle("activo", c.dataset.tema === padecimiento));
    }

    let resultados = buscar(q, 10, TEMA_ACTUAL);
    let modo = "exacto";
    if (!resultados.length && TEMA_ACTUAL !== "todos") {
      resultados = buscar(q, 10, "todos");
      if (resultados.length) modo = "sin-filtro";
    }
    if (!resultados.length) {
      const qExp = expandirConsulta(q);
      if (qExp) {
        resultados = buscar(qExp, 10, "todos");
        if (resultados.length) modo = "expandida";
      }
    }
    render(resultados, q, { modo, padecimiento });
    document.getElementById("resultados").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  RUN_QUERY = run;
  initSugerencias(run);
  document.getElementById("btn").addEventListener("click", () =>
    run(document.getElementById("q").value));
  document.getElementById("q").addEventListener("keydown", e => {
    if (e.key === "Enter") run(e.target.value);
  });
  document.querySelectorAll(".chip").forEach(ch =>
    ch.addEventListener("click", () => {
      document.getElementById("q").value = ch.dataset.q;
      run(ch.dataset.q);
    }));

  // filtro por padecimiento
  document.querySelectorAll(".chip-tema").forEach(ch =>
    ch.addEventListener("click", () => {
      TEMA_ACTUAL = ch.dataset.tema;
      document.querySelectorAll(".chip-tema").forEach(c =>
        c.classList.toggle("activo", c === ch));
      const q = document.getElementById("q").value.trim();
      if (q) run(q);
    }));

  if (location.hash.startsWith("#q=")) {
    const q = decodeURIComponent(location.hash.slice(3)).replace(/\+/g, " ");
    document.getElementById("q").value = q;
    run(q);
  }
}

init();
