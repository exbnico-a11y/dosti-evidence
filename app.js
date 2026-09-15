/* Dosti Evidence — búsqueda TF-IDF estricta sobre guías oficiales MX.
   Respuesta SINTETIZADA extractivamente: solo oraciones de fragmentos
   recuperados, con citas inline [n]. Sin conocimiento libre del modelo. */
let IDX = null;

const STOP = new Set(("a al algo algunas algunos ante antes como con contra cual " +
  "cuando de del desde donde durante e el ella ellas ellos en entre era eran es " +
  "esa esas ese eso esos esta estaban estabas estaba estamos estando estar estas " +
  "este esto estos estoy fue fueron ha habia habian haber han hasta hay la las le " +
  "les lo los mas me mi mis mucho muchos muy no nos nosotros o os otra otras otro " +
  "otros para pero poco por porque que quien quienes se sea sean ser si sin sobre " +
  "son soy su sus te tiene tienen todo todos un una unas uno unos y ya").split());

const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

function tokenize(text) {
  const out = [];
  for (const w of norm(text.toLowerCase()).match(/[a-z0-9]+/g) || []) {
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/* ---------- búsqueda ---------- */

function buscar(query, k = 10) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const scores = new Map();
  for (const t of terms) {
    const idf = IDX.idf[t];
    if (!idf) continue;
    const post = IDX.postings[t];
    if (!post) continue;
    for (const [cid, w] of Object.entries(post)) {
      scores.set(+cid, (scores.get(+cid) || 0) + w * idf);
    }
  }
  const ranked = [...scores.entries()]
    .map(([cid, s]) => [cid, s / (IDX.normas[cid] || 1)])
    .sort((a, b) => b[1] - a[1]);
  const porPagina = new Map(), sel = [];
  for (const [cid, sc] of ranked) {
    const c = IDX.chunks[cid];
    const key = c.doc + ":" + c.pagina;
    const n = porPagina.get(key) || 0;
    if (n >= 2) continue;
    const t = c.texto;
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

function puntuarOracion(s, terms) {
  const toks = tokenize(s);
  if (toks.length < 4 || s.length < 40) return -1;
  let s_ = 0, hits = 0;
  for (const t of toks) {
    const idf = IDX.idf[t];
    if (idf) s_ += idf;
    if (terms.includes(t)) hits++;
  }
  if (!hits) return -1;
  // bonus por contenido decisorio: cifras, dosis, verbos de recomendación
  let bonus = 0;
  if (/\d/.test(s)) bonus += 0.6;
  if (/recomiend|sugier|debe|iniciar|administrar|mantener|suspender|referir/i.test(s)) bonus += 0.8;
  return (s_ * (1 + hits / terms.length) + bonus * hits) / Math.sqrt(toks.length);
}

function sintetizar(resultados, query, maxOraciones = 8) {
  const terms = tokenize(query);
  const candidatas = [];
  resultados.forEach(([cid], ci) => {
    for (const s of oraciones(IDX.chunks[cid].texto)) {
      const p = puntuarOracion(s, terms);
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

function limpiar(t) { return t.replace(/\s+/g, " ").trim(); }

function render(resultados, query) {
  const box = document.getElementById("respuesta");
  const fuentes = document.getElementById("fuentes");
  document.getElementById("resultados").hidden = false;
  document.getElementById("inicio").hidden = true;

  if (!resultados.length) {
    box.innerHTML = `<p class="sin-resultados">Sin resultados suficientes en las guías
      cargadas para: “${query}”. Reformula con términos clínicos
      (fármacos, cifras de PA, comorbilidades).</p>`;
    fuentes.innerHTML = "";
    return;
  }

  const sintesis = sintetizar(resultados, query);

  let html = `<h3>Respuesta basada en guías oficiales</h3>`;
  if (sintesis.length) {
    html += `<div class="sintesis">`;
    // párrafos: agrupa de 3 en 3
    for (let i = 0; i < sintesis.length; i += 3) {
      html += "<p>" + sintesis.slice(i, i + 3).map(o =>
        `${o.s} <span class="cite" data-c="${o.ref}">[${o.ref + 1}]</span>`
      ).join(" ") + "</p>";
    }
    html += `</div>`;
  }
  html += `<details class="fragmentos"><summary>Ver fragmentos completos de las fuentes</summary>`;
  resultados.forEach(([cid], i) => {
    const c = IDX.chunks[cid];
    const txt = limpiar(c.texto);
    const recorte = txt.length > 700 ? txt.slice(0, 700).replace(/\s\S*$/, "") + "…" : txt;
    html += `<div class="frag">${recorte} <span class="cite" data-c="${i}">[${i + 1}]</span></div>`;
  });
  html += `</details>`;
  html += `<p class="nota">Respuesta compuesta únicamente con texto recuperado de las
    fuentes oficiales citadas. Verifica siempre el contexto completo en la página indicada.</p>`;
  box.innerHTML = html;

  fuentes.innerHTML = resultados.map(([cid], i) => {
    const c = IDX.chunks[cid];
    const snip = limpiar(c.texto).slice(0, 260);
    return `<div class="fuente" id="f${i}">
      <span class="n">[${i + 1}]</span><span class="doc">${c.doc_corto}</span>
      <div class="pag">${c.doc} · página ${c.pagina}</div>
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

/* ---------- referencia de fármacos (Cuadro Básico, GPC-076-21) ---------- */

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
  const fuente = "Fuente: GPC-IMSS-076-21, Cuadro de medicamentos del Cuadro Básico y Catálogo de Insumos del Sector Salud (CAUSES), págs. 81–90.";
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

/* ---------- arranque ---------- */

async function init() {
  const res = await fetch("index.json");
  IDX = await res.json();
  document.getElementById("doclist").innerHTML = IDX.meta.docs
    .map(d => `<li>${d}</li>`).join("");

  initCedula();
  initFarmacos();

  const run = q => {
    q = q.trim();
    if (!q) return;
    render(buscar(q), q);
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

  if (location.hash.startsWith("#q=")) {
    const q = decodeURIComponent(location.hash.slice(3)).replace(/\+/g, " ");
    document.getElementById("q").value = q;
    run(q);
  }
}

init();
