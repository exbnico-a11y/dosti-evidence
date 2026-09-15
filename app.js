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
  for (const { t, w } of resolved) {
    const idf = IDX.idf[t];
    const post = IDX.postings[t];
    if (!post) continue;
    for (const cid in post) {
      const tf = post[cid];
      const dl = IDX.dls[cid];
      const bm = idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl / avgdl));
      scores.set(+cid, (scores.get(+cid) || 0) + bm * w);
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

function puntuarOracion(s, termSet) {
  const toks = tokenize(s);
  if (toks.length < 4 || s.length < 40) return -1;
  let s_ = 0, hits = 0;
  for (const t of toks) {
    const idf = IDX.idf[t];
    if (idf) s_ += idf;
    if (termSet.has(t)) hits++;
  }
  if (!hits) return -1;
  let bonus = 0;
  if (/\d/.test(s)) bonus += 0.6;
  if (/recomiend|sugier|debe|iniciar|administrar|mantener|suspender|referir/i.test(s)) bonus += 0.8;
  return (s_ * (1 + hits / termSet.size) + bonus * hits) / Math.sqrt(toks.length);
}

function sintetizar(resultados, query, maxOraciones = 8) {
  const termSet = new Set(tokenize(query));
  const candidatas = [];
  resultados.forEach(([cid], ci) => {
    for (const s of oraciones(IDX.chunks[cid][2])) {
      const p = puntuarOracion(s, termSet);
      if (p > 0) candidatas.push({ s: s.trim(), p, ref: ci, cid });
    }
  });
  candidatas.sort((a, b) => b.p - a.p);
  const elegidas = [], usados = [];
  for (const c of candidatas) {
    if (elegidas.length >= maxOraciones) break;
    if (c.s.length > 420) continue;
    const toks = tokenize(c.s);
    if (usados.some(u => simJaccard(u, toks) > 0.45)) continue;
    elegidas.push(c);
    usados.push(toks);
  }
  return elegidas;
}

/* ---------- render ---------- */

function chunkInfo(cid) {
  const c = IDX.chunks[cid];
  const doc = IDX.meta.docs[c[0]];
  return { docCorto: doc.corto, docNombre: doc.nombre, pagina: c[1], texto: c[2] };
}

function limpiar(t) { return t.replace(/\s+/g, " ").trim(); }

function render(resultados, query) {
  const box = document.getElementById("respuesta");
  const fuentes = document.getElementById("fuentes");
  const sec = document.getElementById("resultados");
  sec.hidden = false;
  sec.dataset.mostrado = "1";
  document.getElementById("inicio").hidden = true;

  if (!resultados.length) {
    box.innerHTML = `<p class="sin-resultados">Sin resultados suficientes en las guías
      cargadas para: “${query}”. Reformula con términos clínicos
      (fármacos, cifras de PA, comorbilidades) o sus siglas (HTA, IECA, BCC…).</p>`;
    fuentes.innerHTML = "";
    return;
  }

  const sintesis = sintetizar(resultados, query);

  let html = `<h3>Respuesta basada en guías oficiales</h3>`;
  if (sintesis.length) {
    html += `<div class="sintesis">`;
    for (let i = 0; i < sintesis.length; i += 3) {
      html += "<p>" + sintesis.slice(i, i + 3).map(o =>
        `${o.s} <span class="cite" data-c="${o.ref}">[${o.ref + 1}]</span>`
      ).join(" ") + "</p>";
    }
    html += `</div>`;
  }
  html += `<details class="fragmentos"><summary>Ver fragmentos completos de las fuentes</summary>`;
  resultados.forEach(([cid], i) => {
    const info = chunkInfo(cid);
    const txt = limpiar(info.texto);
    const recorte = txt.length > 700 ? txt.slice(0, 700).replace(/\s\S*$/, "") + "…" : txt;
    html += `<div class="frag">${recorte} <span class="cite" data-c="${i}">[${i + 1}]</span></div>`;
  });
  html += `</details>`;
  html += `<p class="nota">Respuesta compuesta únicamente con texto recuperado de las
    fuentes oficiales citadas. Verifica siempre el contexto completo en la página indicada.</p>`;
  box.innerHTML = html;

  fuentes.innerHTML = resultados.map(([cid], i) => {
    const info = chunkInfo(cid);
    const snip = limpiar(info.texto).slice(0, 260);
    return `<div class="fuente" id="f${i}">
      <span class="n">[${i + 1}]</span><span class="doc">${info.docCorto}</span>
      <div class="pag">${info.docNombre} · página ${info.pagina}</div>
      <div class="snip">${snip}…</div></div>`;
  }).join("");

  box.querySelectorAll(".cite").forEach(el =>
    el.addEventListener("click", () => {
      const f = document.getElementById("f" + el.dataset.c);
      if (f) f.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
}

/* ---------- verificación de cédula (demo) ---------- */

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

function initRemedios() {
  const lista = document.getElementById("lista-remedios");
  const pintar = cat => {
    const sel = REMEDIOS.filter(r => cat === "todas" || r.categoria === cat);
    lista.innerHTML = sel.map(r => `
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
      </div>`).join("");
  };
  pintar("todas");
  document.querySelectorAll(".filtro-remedios .chip-tema").forEach(ch =>
    ch.addEventListener("click", () => {
      document.querySelectorAll(".filtro-remedios .chip-tema").forEach(c =>
        c.classList.toggle("activo", c === ch));
      pintar(ch.dataset.cat);
    }));
}

/* ---------- pestañas principales ---------- */

function initTabs() {
  document.querySelectorAll(".tabs .tab").forEach(tab =>
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tabs .tab").forEach(t =>
        t.classList.toggle("activo", t === tab));
      const vista = tab.dataset.vista;
      const hayResultados = !!document.getElementById("resultados").dataset.mostrado;
      document.getElementById("hero").hidden = vista !== "buscador";
      document.getElementById("remedios").hidden = vista !== "remedios";
      document.getElementById("resultados").hidden = vista !== "buscador" || !hayResultados;
      document.getElementById("inicio").hidden = vista !== "buscador" || hayResultados;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }));
}

/* ---------- arranque ---------- */

async function init() {
  const res = await fetch("index.json");
  IDX = await res.json();
  DOCS_TEMA = IDX.meta.docs.map(d => d.tema);

  // lista de fuentes agrupadas por padecimiento
  const temas = [...new Set(IDX.meta.docs.map(d => d.tema))];
  const nombreTema = { hipertension: "Hipertensión arterial", diabetes: "Diabetes mellitus tipo 2",
                       dislipidemias: "Dislipidemias", obesidad: "Sobrepeso y obesidad",
                       epoc: "EPOC", asma: "Asma bronquial", neumonia: "Neumonía adquirida en la comunidad" };
  document.getElementById("doclist").innerHTML = temas.map(t => {
    const docs = IDX.meta.docs.filter(d => d.tema === t);
    return `<li class="tema-grupo"><strong>${nombreTema[t] || t}</strong> (${docs.length} fuentes)<ul>` +
      docs.map(d => `<li class="tema-doc">${d.nombre}<br><span class="vig">${d.vigencia}</span></li>`).join("") +
      `</ul></li>`;
  }).join("");
  document.getElementById("cargando").hidden = true;

  initCedula();
  initFarmacos();
  initRemedios();
  initTabs();

  const run = q => {
    q = q.trim();
    if (!q) return;
    render(buscar(q, 10, TEMA_ACTUAL), q);
    document.getElementById("resultados").scrollIntoView({ behavior: "smooth", block: "start" });
  };
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
