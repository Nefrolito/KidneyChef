// En la app empaquetada (Capacitor) los assets se sirven desde un origen local
// del propio WebView, sin servidor Python detrás, así que una URL relativa
// apuntaría al WebView y no al backend: ahí hay que usar la URL desplegada.
// Como página web normal (local o ya desplegada) sí sirve la URL relativa.
//
// La detección mira window.Capacitor, que el bridge nativo inyecta en el
// WebView. NO sirve mirar location.protocol: en Android el esquema por defecto
// de Capacitor es "https" (igual que la web), así que ese chequeo dejaba a la
// app de Android llamando a https://localhost/api/analyze en vez del backend.
function esAppNativa() {
  const cap = window.Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === "function") return cap.isNativePlatform();
  return true;
}

const API_BASE = esAppNativa() ? "https://kidneychef-api.onrender.com" : "";

// Clave compartida con el backend, enviada en cada análisis. No es un secreto:
// viaja en el código del cliente y alguien técnico puede extraerla. Sirve para
// que quien descubra la URL del backend no pueda usarlo directamente. Debe
// coincidir con la variable APP_KEY configurada en el servidor.
const APP_KEY = "Xhw465sJYD8cL1lobmCuebpbJ2EmT6aD";

// Umbrales de semáforo por PORCIÓN (mg), pensados como referencia educativa general.
// Deben personalizarse con el equipo de nefrología/nutrición de cada paciente.
const UMBRALES = {
  potasio_mg: { verde: 200, amarillo: 400 },
  fosforo_mg: { verde: 100, amarillo: 200 },
  sodio_mg: { verde: 140, amarillo: 400 },
};

const NUTRIENTE_LABEL = {
  potasio_mg: "Potasio",
  fosforo_mg: "Fósforo",
  sodio_mg: "Sodio",
  carbohidratos_g: "Carbohidratos",
};

const NUTRIENTE_ICON = {
  potasio_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4C10 4 4 10 4 20c10 0 16-6 16-16Z"/><path d="M8.5 15.5 15.5 8.5"/></svg>`,
  fosforo_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="6" r="2.3"/></svg>`,
  sodio_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 3H8Z"/><path d="M8 6h8l1.2 12.5A2 2 0 0 1 15.2 21H8.8a2 2 0 0 1-2-2.5L8 6Z"/><circle cx="10.5" cy="11" r="0.4" fill="currentColor"/><circle cx="13.5" cy="11" r="0.4" fill="currentColor"/><circle cx="12" cy="14" r="0.4" fill="currentColor"/></svg>`,
  carbohidratos_g: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-3 0-5 2-5 4.5S9 12 12 12s5-2 5-4.5S15 3 12 3Z"/><path d="M5 14c2.5-1 4.5-1 7-1s4.5 0 7 1"/><path d="M6 18c2-.8 4-1 6-1s4 .2 6 1"/></svg>`,
};

const ICONO_LIQUIDO = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c3.5 4 7 8.2 7 12a7 7 0 0 1-14 0c0-3.8 3.5-8 7-12Z"/></svg>`;

// Estructura de planes: hoy solo existe el plan básico (gratuito). Los planes
// pagados se agregarán aquí más adelante, cada uno con su propio set de
// umbrales/features habilitados según lo que indique el nefrólogo(a) del
// paciente.
const PLANS = {
  basico: {
    id: "basico",
    nombre: "KidneyChef Plan Básico",
    precio: "Gratis",
    features: {
      semaforoEstandar: true,
      historialLocal: true,
      consejoDelDia: true,
      umbralesPersonalizados: false,
      reportesExportables: false,
      perfilesMultiples: false,
    },
  },
  // Plan pagado único (en vez de un plan por cada combinación de etapa ERC /
  // diabetes / hipertensión): el equipo tratante ajusta los umbrales según el
  // caso puntual del paciente, registrado en perfil.datosClinicos.
  clinico: {
    id: "clinico",
    nombre: "KidneyChef Plan Clínico",
    precio: "De pago",
    features: {
      semaforoEstandar: true,
      historialLocal: true,
      consejoDelDia: true,
      umbralesPersonalizados: true,
      reportesExportables: true,
      perfilesMultiples: true,
    },
  },
};

const ETAPAS_ERC = ["3a", "3b", "4", "5", "hemodialisis", "peritoneal"];

const PERFIL_STORAGE_KEY = "kidneyChefPerfil";

function ensurePerfil() {
  let perfil;
  try {
    perfil = JSON.parse(localStorage.getItem(PERFIL_STORAGE_KEY));
  } catch {
    perfil = null;
  }
  if (!perfil || !PLANS[perfil.planId]) {
    perfil = {
      planId: "basico",
      creadoEn: new Date().toISOString(),
      datosClinicos: datosClinicosPorDefecto(),
      umbralesPersonalizados: null,
    };
    localStorage.setItem(PERFIL_STORAGE_KEY, JSON.stringify(perfil));
  }
  if (!perfil.datosClinicos) perfil.datosClinicos = datosClinicosPorDefecto();
  const d = perfil.datosClinicos;
  if (d.diuresisMl === undefined) d.diuresisMl = null;
  if (d.enDialisis === undefined) d.enDialisis = null;
  if (d.modoEtapa === undefined) d.modoEtapa = "calculada";
  if (d.edad === undefined) d.edad = null;
  if (d.sexoBiologico === undefined) d.sexoBiologico = null;
  if (d.creatininaMgDl === undefined) d.creatininaMgDl = null;
  if (d.cistatinaMgL === undefined) d.cistatinaMgL = null;
  if (perfil.umbralesPersonalizados === undefined) perfil.umbralesPersonalizados = null;
  if (perfil.metasDiarias === undefined) perfil.metasDiarias = null;
  if (perfil.vinculacion === undefined) {
    perfil.vinculacion = { codigoCliente: null, deviceSecret: null };
  }
  return perfil;
}

function datosClinicosPorDefecto() {
  return {
    etapaERC: null,
    diabetes: false,
    hipertension: false,
    diuresisMl: null,
    enDialisis: null,
    modoEtapa: "calculada",
    edad: null,
    sexoBiologico: null,
    creatininaMgDl: null,
    cistatinaMgL: null,
  };
}

function guardarPerfil(perfil) {
  localStorage.setItem(PERFIL_STORAGE_KEY, JSON.stringify(perfil));
}

function getPlanActual() {
  return PLANS[ensurePerfil().planId];
}

function umbralesActivos() {
  const perfil = ensurePerfil();
  const plan = PLANS[perfil.planId];
  if (plan.features.umbralesPersonalizados && perfil.umbralesPersonalizados) {
    return perfil.umbralesPersonalizados;
  }
  return UMBRALES;
}

// --- Calculadora de eGFR (CKD-EPI 2021, sin coeficiente racial) ---------
// Fuente: National Kidney Foundation — ecuaciones de creatinina (2021) y
// creatinina-cistatina combinada (2021) en kidney.org/ckd-epi-creatinine-equation-2021
// y kidney.org/ckd-epi-creatinine-cystatin-equation-2021; la de cistatina
// sola es la de 2012 (kidney.org/ckd-epi-cystatin-c-equation-2012), que esa
// revisión no modificó. Coeficientes kappa/alfa varían por sexo biológico
// porque así se define la ecuación original, no por identidad de género.
function egfrCreatinina(edad, esMujer, scrMgDl) {
  const kappa = esMujer ? 0.7 : 0.9;
  const alfa = esMujer ? -0.241 : -0.302;
  const ratio = scrMgDl / kappa;
  return 142
    * Math.pow(Math.min(ratio, 1), alfa)
    * Math.pow(Math.max(ratio, 1), -1.2)
    * Math.pow(0.9938, edad)
    * (esMujer ? 1.012 : 1);
}

function egfrCistatina(edad, esMujer, scysMgL) {
  const ratio = scysMgL / 0.8;
  return 133
    * Math.pow(Math.min(ratio, 1), -0.499)
    * Math.pow(Math.max(ratio, 1), -1.328)
    * Math.pow(0.996, edad)
    * (esMujer ? 0.932 : 1);
}

function egfrCombinada(edad, esMujer, scrMgDl, scysMgL) {
  const kappa = esMujer ? 0.7 : 0.9;
  const alfa = esMujer ? -0.219 : -0.144;
  const ratioCr = scrMgDl / kappa;
  const ratioCys = scysMgL / 0.8;
  return 135
    * Math.pow(Math.min(ratioCr, 1), alfa)
    * Math.pow(Math.max(ratioCr, 1), -0.544)
    * Math.pow(Math.min(ratioCys, 1), -0.323)
    * Math.pow(Math.max(ratioCys, 1), -0.778)
    * Math.pow(0.9961, edad)
    * (esMujer ? 0.963 : 1);
}

// Elige la ecuación más precisa según los datos disponibles: NKF/ASN
// recomiendan la combinada cuando hay creatinina y cistatina, porque reduce
// el error de cada marcador por separado; si falta uno, se usa la ecuación
// de ese único marcador.
function calcularEgfr({ edad, sexoBiologico, creatininaMgDl, cistatinaMgL }) {
  if (edad == null || !sexoBiologico) return null;
  const esMujer = sexoBiologico === "F";
  const tieneCr = creatininaMgDl != null && creatininaMgDl > 0;
  const tieneCys = cistatinaMgL != null && cistatinaMgL > 0;
  if (tieneCr && tieneCys) return egfrCombinada(edad, esMujer, creatininaMgDl, cistatinaMgL);
  if (tieneCr) return egfrCreatinina(edad, esMujer, creatininaMgDl);
  if (tieneCys) return egfrCistatina(edad, esMujer, cistatinaMgL);
  return null;
}

// Categorías KDIGO por eGFR. G1/G2 (eGFR >= 60) devuelven key null porque
// limites-clinicos.json solo modela desde la etapa 3: esta app está pensada
// para ERC ya diagnosticada, y unas cifras de filtración conservada no
// bastan para decidir un plan alimentario (podría haber ERC por albuminuria
// con eGFR normal, que esta calculadora no evalúa).
function etapaPorEgfr(egfr) {
  if (egfr >= 90) return { key: null, etiqueta: "categoría G1 (función renal normal o alta)", selloCorto: "G1 · función normal" };
  if (egfr >= 60) return { key: null, etiqueta: "categoría G2 (levemente disminuida)", selloCorto: "G2 · función levemente disminuida" };
  if (egfr >= 45) return { key: "3a", etiqueta: "ERC etapa 3a", selloCorto: "ERC etapa 3a" };
  if (egfr >= 30) return { key: "3b", etiqueta: "ERC etapa 3b", selloCorto: "ERC etapa 3b" };
  if (egfr >= 15) return { key: "4", etiqueta: "ERC etapa 4", selloCorto: "ERC etapa 4" };
  return { key: "5", etiqueta: "ERC etapa 5 (sin diálisis)", selloCorto: "ERC etapa 5" };
}

// --- Modelo clínico (KDIGO/KDOQI) ---------------------------------------
// Cargado desde limites-clinicos.json. Mientras no esté cargado, la app cae
// a los umbrales fijos de UMBRALES, así que nunca queda sin semáforo.
let LIMITES = null;

// ¿El paciente tiene factores que aumentan el riesgo de hiperkalemia?
// Diabetes y bloqueo del SRAA se tratan igual: ambos justifican clasificar
// el potasio con los cortes estrictos.
function riesgoHiperkalemia() {
  const d = ensurePerfil().datosClinicos || {};
  return !!(d.diabetes || d.farmacosRetenedoresK);
}

// Meta diaria de un nutriente, o null si no corresponde fijar una.
// Solo el sodio tiene meta universal; potasio y fósforo únicamente cuando el
// equipo tratante los individualizó (plan clínico).
function metaDiaria(nutriente) {
  if (!LIMITES) return null;
  const perfil = ensurePerfil();
  const plan = PLANS[perfil.planId];
  const propias = plan.features.umbralesPersonalizados ? perfil.metasDiarias : null;
  if (propias && propias[nutriente] != null) return propias[nutriente];

  if (nutriente === "sodio_mg") return LIMITES.sodio.objetivo_mg_dia;
  if (nutriente === "carbohidratos_g") {
    return perfil.datosClinicos && perfil.datosClinicos.diabetes
      ? LIMITES.carbohidratos.objetivo_g_dia_por_defecto
      : null;
  }
  return null; // potasio y fósforo: sin cifra universal
}

// "3" | "4" | "5" | "hemodialisis" | "peritoneal" | null (no declarada)
function situacionActual() {
  return ensurePerfil().datosClinicos.etapaERC || null;
}

// Solo hemodiálisis y diálisis peritoneal activan el registro de líquidos:
// son las situaciones donde la restricción depende de la diuresis residual.
function requiereDiuresis() {
  if (!LIMITES) return false;
  const s = situacionActual();
  const cfg = s && LIMITES.situaciones[s];
  return !!(cfg && cfg.requiere_diuresis);
}

// Meta de líquidos del día, o null si la situación no la activa.
// Fórmula clínica: diuresis residual + margen fijo (LIMITES.liquidos.margen_ml).
// Si el paciente no registró su diuresis, se asume anúrico (0 ml) por ser el
// supuesto más restrictivo — pero se marca como provisional en la UI, porque
// restringir de más a alguien que sí orina también hace daño.
function metaLiquidos() {
  if (!LIMITES || !requiereDiuresis()) return null;
  const raw = ensurePerfil().datosClinicos.diuresisMl;
  const esSupuesto = raw === null || raw === undefined || raw === "";
  const diuresis = esSupuesto ? LIMITES.liquidos.sin_dato.asumir_diuresis_ml : Number(raw);
  return { ml: diuresis + LIMITES.liquidos.margen_ml, esSupuesto };
}

// Umbral por porción derivado de la meta diaria: el día se reparte en varias
// comidas y un alimento que usa hasta la mitad de ese presupuesto es verde.
function umbralPorcion(metaDia) {
  const r = LIMITES.regla_porcion;
  const amarillo = metaDia / r.comidas_por_dia;
  return { verde: amarillo * r.fraccion_verde, amarillo };
}

// Clasifica un nutriente. Devuelve el nivel y en qué modo se evaluó, porque
// el texto que se le muestra al paciente cambia según el caso.
//   modo "meta"      -> la porción se comparó con su presupuesto real
//   modo "contenido" -> se describe cuán alto es el alimento (mg/100 g)
function clasificar(nutriente, valorPorcion, densidad100g) {
  if (!LIMITES) {
    const t = umbralesActivos()[nutriente];
    if (!t) return { nivel: null, modo: "ninguno" };
    const nivel = valorPorcion <= t.verde ? "verde" : valorPorcion <= t.amarillo ? "amarillo" : "rojo";
    return { nivel, modo: "meta" };
  }

  const meta = metaDiaria(nutriente);
  if (meta != null) {
    const t = umbralPorcion(meta);
    const nivel = valorPorcion <= t.verde ? "verde" : valorPorcion <= t.amarillo ? "amarillo" : "rojo";
    return { nivel, modo: "meta" };
  }

  // Sin meta: se clasifica el contenido del alimento, no la porción.
  const cfg = nutriente === "potasio_mg" ? LIMITES.potasio
            : nutriente === "fosforo_mg" ? LIMITES.fosforo : null;
  if (!cfg || densidad100g == null) return { nivel: null, modo: "ninguno" };

  const c = (nutriente === "potasio_mg" && riesgoHiperkalemia() && cfg.clasificacion_contenido_estricta)
    ? cfg.clasificacion_contenido_estricta
    : cfg.clasificacion_contenido;

  const nivel = densidad100g <= c.bajo_hasta ? "verde"
              : densidad100g <= c.moderado_hasta ? "amarillo" : "rojo";
  return { nivel, modo: "contenido" };
}

function renderPlan() {
  const plan = getPlanActual();
  els.planBadge.textContent = plan.nombre;
  els.aboutPlan.textContent = `Tu plan actual: ${plan.nombre} (${plan.precio}).`;
}

function renderDatosClinicos() {
  const perfil = ensurePerfil();
  const d = perfil.datosClinicos;
  els.enDialisis.value = d.enDialisis || "";
  els.diabetes.checked = !!d.diabetes;
  els.hipertension.checked = !!d.hipertension;
  els.farmacosK.checked = !!d.farmacosRetenedoresK;
  els.datoDiuresis.value = d.diuresisMl ?? "";
  els.modoEtapaCalculada.checked = d.modoEtapa !== "manual";
  els.modoEtapaManual.checked = d.modoEtapa === "manual";
  els.egfrEdad.value = d.edad ?? "";
  els.egfrSexo.value = d.sexoBiologico || "";
  els.egfrCreatinina.value = d.creatininaMgDl ?? "";
  els.egfrCistatina.value = d.cistatinaMgL ?? "";
  els.etapaERC.value = ["3a", "3b", "4", "5"].includes(d.etapaERC) ? d.etapaERC : "";
  actualizarVisibilidadEtapa();
  renderResultadoEgfr();
  renderEtapaSello();
  actualizarVisibilidadDiuresis();
  renderPlanUpsell();
}

// Diálisis oculta todo el bloque de etapa (la modalidad la define
// directamente); si no hay diálisis, se alterna entre la calculadora de
// eGFR y la declaración manual según lo que eligió el paciente.
function actualizarVisibilidadEtapa() {
  const d = ensurePerfil().datosClinicos;
  const enDialisis = !!d.enDialisis;
  els.bloqueEtapa.hidden = enDialisis;
  if (enDialisis) return;
  const manual = d.modoEtapa === "manual";
  els.calculadoraEgfr.hidden = manual;
  els.etapaManualCampo.hidden = !manual;
}

function renderResultadoEgfr() {
  const d = ensurePerfil().datosClinicos;
  els.egfrResultado.classList.remove("egfr-resultado-listo");
  if (d.enDialisis || d.modoEtapa === "manual") {
    els.egfrResultado.innerHTML = "";
    return;
  }
  const egfr = calcularEgfr(d);
  if (egfr == null) {
    els.egfrResultado.textContent = "Ingresa edad, sexo biológico y al menos un valor (creatinina o cistatina C) para calcular tu eGFR.";
    return;
  }
  const { key, etiqueta } = etapaPorEgfr(egfr);
  const extra = key
    ? ""
    : " Esta app está pensada para ERC etapa 3 en adelante; conversa con tu equipo tratante sobre cómo interpretar este resultado.";
  els.egfrResultado.classList.add("egfr-resultado-listo");
  els.egfrResultado.innerHTML = `
    <div class="egfr-valor-grande">${Math.round(egfr)}<span class="egfr-unidad">mL/min/1.73&nbsp;m²</span></div>
    <p class="egfr-detalle">${etiqueta}.${extra}</p>`;
}

// Datos del círculo de etapa: un valor corto (cabe en el círculo, ej. "3B",
// "HD") más la etiqueta completa que se lee debajo. Prioriza la modalidad de
// diálisis, luego la etapa manual, luego la calculada. Usa las etiquetas de
// limites-clinicos.json cuando está cargado, para no duplicar el texto.
function datosSelloEtapa() {
  const d = ensurePerfil().datosClinicos;
  if (d.enDialisis === "hemodialisis") {
    return { superior: "EN", valor: "HD", label: (LIMITES && LIMITES.situaciones.hemodialisis.etiqueta) || "En hemodiálisis" };
  }
  if (d.enDialisis === "peritoneal") {
    return { superior: "EN", valor: "DP", label: (LIMITES && LIMITES.situaciones.peritoneal.etiqueta) || "En diálisis peritoneal" };
  }
  if (d.modoEtapa === "manual") {
    if (!d.etapaERC) return null;
    const label = LIMITES && LIMITES.situaciones[d.etapaERC] && LIMITES.situaciones[d.etapaERC].etiqueta;
    return label ? { superior: "ERC", valor: d.etapaERC.toUpperCase(), label } : null;
  }
  const egfr = calcularEgfr(d);
  if (egfr == null) return null;
  const { key, selloCorto, etiqueta } = etapaPorEgfr(egfr);
  if (!key) return { superior: "eGFR", valor: egfr >= 90 ? "G1" : "G2", label: etiqueta };
  const label = (LIMITES && LIMITES.situaciones[key] && LIMITES.situaciones[key].etiqueta) || selloCorto;
  return { superior: "ERC", valor: key.toUpperCase(), label };
}

function renderEtapaSello() {
  const datos = datosSelloEtapa();
  els.etapaSello.classList.toggle("etapa-sello-vacio", !datos);
  els.etapaCirculoSuperior.textContent = datos ? datos.superior : "";
  els.etapaCirculoValor.textContent = datos ? datos.valor : "—";
  els.etapaSelloLabel.textContent = datos ? datos.label : "Sin etapa registrada";
}

function actualizarVisibilidadDiuresis() {
  els.campoDiuresis.hidden = !requiereDiuresis();
}

function guardarDatosClinicos() {
  const perfil = ensurePerfil();
  const diuresisRaw = els.datoDiuresis.value;
  const d = {
    diabetes: els.diabetes.checked,
    hipertension: els.hipertension.checked,
    farmacosRetenedoresK: els.farmacosK.checked,
    diuresisMl: diuresisRaw === "" ? null : Number(diuresisRaw),
    enDialisis: els.enDialisis.value || null,
    modoEtapa: els.modoEtapaManual.checked ? "manual" : "calculada",
    edad: els.egfrEdad.value === "" ? null : Number(els.egfrEdad.value),
    sexoBiologico: els.egfrSexo.value || null,
    creatininaMgDl: els.egfrCreatinina.value === "" ? null : Number(els.egfrCreatinina.value),
    cistatinaMgL: els.egfrCistatina.value === "" ? null : Number(els.egfrCistatina.value),
  };

  if (d.enDialisis) {
    d.etapaERC = d.enDialisis;
  } else if (d.modoEtapa === "manual") {
    d.etapaERC = els.etapaERC.value || null;
  } else {
    const egfr = calcularEgfr(d);
    d.etapaERC = egfr != null ? etapaPorEgfr(egfr).key : null;
  }

  perfil.datosClinicos = d;
  guardarPerfil(perfil);
  actualizarVisibilidadEtapa();
  renderResultadoEgfr();
  renderEtapaSello();
  actualizarVisibilidadDiuresis();
  renderPlanUpsell();
  renderCalculadora();
}

function renderPlanUpsell() {
  const perfil = ensurePerfil();
  const plan = getPlanActual();
  if (plan.features.umbralesPersonalizados) {
    els.planUpsell.hidden = true;
    return;
  }
  const { etapaERC, diabetes, hipertension, farmacosRetenedoresK } = perfil.datosClinicos;
  const detalles = [];
  if (etapaERC) detalles.push(`ERC etapa ${etapaERC}`);
  if (diabetes) detalles.push("diabetes");
  if (hipertension) detalles.push("hipertensión");
  if (farmacosRetenedoresK) detalles.push("medicamentos que elevan el potasio");
  els.planUpsellText.textContent = detalles.length
    ? `Con ${detalles.join(", ")}, tu nefrólogo(a) o nutricionista podría ajustar tus umbrales de potasio/fósforo/sodio con el Plan Clínico, además de reportes exportables y varios perfiles.`
    : "El Plan Clínico permite que tu nefrólogo(a) o nutricionista ajuste tus umbrales de potasio/fósforo/sodio a tu caso, además de reportes exportables y varios perfiles.";
  els.planUpsell.hidden = false;
}

// --- Equipo tratante: vínculo real con el backend -----------------------
// El paciente no tiene login: se identifica con un código de cliente y un
// secreto de dispositivo que el backend genera al activar el Plan Clínico
// (guardados en perfil.vinculacion). Un vínculo con un tratante queda
// 'pendiente' hasta que el propio paciente lo acepta ACÁ — es el paso de
// confirmación legal (Ley 20.584): sin esto, el tratante nunca ve datos
// clínicos de este paciente.

function authHeadersPaciente() {
  const perfil = ensurePerfil();
  const v = perfil.vinculacion || {};
  return {
    "X-App-Key": APP_KEY,
    "X-Codigo-Cliente": v.codigoCliente || "",
    "X-Device-Secret": v.deviceSecret || "",
  };
}

function renderVinculacion() {
  const perfil = ensurePerfil();
  els.activarPlanClinico.checked = perfil.planId === "clinico";
  const codigo = perfil.vinculacion && perfil.vinculacion.codigoCliente;
  els.codigoClienteBloque.hidden = !codigo;
  els.codigoClienteValor.textContent = codigo || "—";
}

async function activarPlanClinico() {
  const perfil = ensurePerfil();
  perfil.planId = els.activarPlanClinico.checked ? "clinico" : "basico";
  guardarPerfil(perfil);
  renderPlan();
  renderPlanUpsell();
  renderCalculadora();
  if (!els.results.hidden) renderResults();

  if (perfil.planId === "clinico" && !perfil.vinculacion.codigoCliente) {
    try {
      const res = await fetch(`${API_BASE}/api/pacientes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo activar el Plan Clínico");
      perfil.vinculacion = { codigoCliente: data.codigo_cliente, deviceSecret: data.device_secret };
      guardarPerfil(perfil);
    } catch (err) {
      setStatus(err.message, true);
    }
  }
  renderVinculacion();
  refrescarVinculos();
  refrescarMetasSincronizadas();
}

function tipoTratanteLabel(tipo) {
  if (tipo === "nefrologo") return "Tu nefrólogo(a)";
  if (tipo === "nutricionista") return "Tu nutricionista";
  return "Tu equipo tratante";
}

function formatFecha(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
}

async function refrescarVinculos() {
  const perfil = ensurePerfil();
  if (!perfil.vinculacion.codigoCliente) {
    els.vinculosPendientes.innerHTML = "";
    els.vinculosActivos.innerHTML = "";
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/vinculos`, {
      headers: authHeadersPaciente(),
    });
    if (!res.ok) return; // credenciales inválidas o sin conexión: no rompe la app local
    const data = await res.json();
    const vinculos = data.vinculos || [];

    els.vinculosPendientes.innerHTML = vinculos
      .filter((v) => v.estado === "pendiente")
      .map((v) => `
        <div class="vinculo-item">
          <div class="vinculo-item-texto">
            <strong>${escapeHtml(v.tratante_nombre || "Equipo tratante")}</strong>
            <small>${escapeHtml(tipoTratanteLabel(v.tratante_tipo))} quiere vincularse contigo</small>
          </div>
          <div class="vinculo-item-acciones">
            <button class="btn btn-primary" data-vinculo-aceptar="${v.id}">Aceptar</button>
            <button class="btn btn-ghost" data-vinculo-rechazar="${v.id}">Rechazar</button>
          </div>
        </div>`)
      .join("");

    els.vinculosActivos.innerHTML = vinculos
      .filter((v) => v.estado === "activo")
      .map((v) => `
        <div class="vinculo-item">
          <div class="vinculo-item-texto">
            <strong>${escapeHtml(v.tratante_nombre || "Equipo tratante vinculado")}</strong>
            <small>Vinculado desde ${formatFecha(v.creado_at)}</small>
          </div>
          <div class="vinculo-item-acciones">
            <button class="btn btn-ghost" data-vinculo-revocar="${v.id}">Revocar</button>
          </div>
        </div>`)
      .join("");

    wireVinculoBotones();
  } catch {
    // sin conexión: se reintenta en el próximo refresco
  }
}

function wireVinculoBotones() {
  els.vinculosPendientes.querySelectorAll("[data-vinculo-aceptar]").forEach((btn) => {
    btn.addEventListener("click", () => actualizarVinculo(btn.dataset.vinculoAceptar, "activo"));
  });
  els.vinculosPendientes.querySelectorAll("[data-vinculo-rechazar]").forEach((btn) => {
    btn.addEventListener("click", () => actualizarVinculo(btn.dataset.vinculoRechazar, "rechazado"));
  });
  els.vinculosActivos.querySelectorAll("[data-vinculo-revocar]").forEach((btn) => {
    btn.addEventListener("click", () => actualizarVinculo(btn.dataset.vinculoRevocar, "revocado"));
  });
}

async function actualizarVinculo(id, estado) {
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/vinculos/${id}`, {
      method: "PATCH",
      headers: { ...authHeadersPaciente(), "Content-Type": "application/json" },
      body: JSON.stringify({ estado }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo actualizar el vínculo");
    await refrescarVinculos();
    await refrescarMetasSincronizadas();
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function refrescarMetasSincronizadas() {
  const perfil = ensurePerfil();
  if (!perfil.vinculacion.codigoCliente) {
    els.metasSincronizadas.hidden = true;
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me`, {
      headers: authHeadersPaciente(),
    });
    if (!res.ok) return;
    const data = await res.json();
    perfil.metasDiarias = data.metasDiarias || null;
    guardarPerfil(perfil);

    const metas = perfil.metasDiarias || {};
    const hayMetas = metas.potasio_mg != null || metas.fosforo_mg != null;
    els.metasSincronizadas.hidden = !hayMetas;
    els.metaPotasioValor.textContent = metas.potasio_mg != null ? `${metas.potasio_mg} mg/día` : "sin fijar";
    els.metaFosforoValor.textContent = metas.fosforo_mg != null ? `${metas.fosforo_mg} mg/día` : "sin fijar";

    renderCalculadora();
    if (!els.results.hidden) renderResults();
  } catch {
    // offline: se reintenta en el próximo refresco
  }
}

function copiarCodigoCliente() {
  const perfil = ensurePerfil();
  const codigo = perfil.vinculacion.codigoCliente;
  if (!codigo) return;
  navigator.clipboard?.writeText(codigo).then(
    () => setStatus("Código copiado."),
    () => setStatus("No se pudo copiar el código.", true)
  );
}

const TIPS_DEL_DIA = [
  "Elegir alimentos frescos y cocinar en casa te ayuda a controlar el sodio y mejorar tu salud renal.",
  "Remojar y hervir las verduras (doble cocción, descartando el agua) reduce su contenido de potasio.",
  "Lee las etiquetas: el sodio se esconde en salsas, conservas, embutidos y panes procesados.",
  "Lácteos, frutos secos y bebidas de cola son ricos en fósforo; modera sus porciones.",
  "El agua de cocción de legumbres y verduras concentra potasio — evita reutilizarla en sopas o salsas.",
  "Las especias y hierbas frescas son una buena forma de dar sabor sin recurrir a la sal.",
  "Revisa siempre el alimento que identifica la app: la confirmación manual evita errores importantes.",
];

let FOODS = [];
let currentImageDataUrl = null;
let pendingManualTarget = null; // { itemIndex } when correcting a specific result

const els = {
  cameraInput: document.getElementById("camera-input"),
  preview: document.getElementById("preview"),
  previewPlaceholder: document.getElementById("preview-placeholder"),
  analyzeBtn: document.getElementById("analyze-btn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  resultsList: document.getElementById("results-list"),
  calculadora: document.getElementById("calculadora"),
  registroLiquidos: document.getElementById("registro-liquidos"),
  liquidoManual: document.getElementById("liquido-manual"),
  liquidoAgregarBtn: document.getElementById("liquido-agregar"),
  liquidosDeshacerBtn: document.getElementById("liquidos-deshacer"),
  campoDiuresis: document.getElementById("campo-diuresis"),
  datoDiuresis: document.getElementById("dato-diuresis"),
  historyList: document.getElementById("history-list"),
  clearHistoryBtn: document.getElementById("clear-history"),
  modal: document.getElementById("manual-select-modal"),
  manualSearch: document.getElementById("manual-search"),
  foodDatalist: document.getElementById("food-datalist"),
  manualCancel: document.getElementById("manual-cancel"),
  manualConfirm: document.getElementById("manual-confirm"),
  aboutBtn: document.getElementById("about-btn"),
  aboutModal: document.getElementById("about-modal"),
  aboutClose: document.getElementById("about-close"),
  tipText: document.getElementById("tip-text"),
  planBadge: document.getElementById("plan-badge"),
  aboutPlan: document.getElementById("about-plan"),
  etapaSello: document.getElementById("etapa-sello"),
  etapaCirculoSuperior: document.getElementById("etapa-circulo-superior"),
  etapaCirculoValor: document.getElementById("etapa-circulo-valor"),
  etapaSelloLabel: document.getElementById("etapa-sello-label"),
  enDialisis: document.getElementById("en-dialisis"),
  bloqueEtapa: document.getElementById("bloque-etapa"),
  modoEtapaCalculada: document.getElementById("modo-etapa-calculada"),
  modoEtapaManual: document.getElementById("modo-etapa-manual"),
  calculadoraEgfr: document.getElementById("calculadora-egfr"),
  egfrEdad: document.getElementById("egfr-edad"),
  egfrSexo: document.getElementById("egfr-sexo"),
  egfrCreatinina: document.getElementById("egfr-creatinina"),
  egfrCistatina: document.getElementById("egfr-cistatina"),
  egfrResultado: document.getElementById("egfr-resultado"),
  etapaManualCampo: document.getElementById("etapa-manual-campo"),
  etapaERC: document.getElementById("etapa-erc"),
  diabetes: document.getElementById("dato-diabetes"),
  hipertension: document.getElementById("dato-hipertension"),
  farmacosK: document.getElementById("dato-farmacos-k"),
  planUpsell: document.getElementById("plan-upsell"),
  planUpsellText: document.getElementById("plan-upsell-text"),
  activarPlanClinico: document.getElementById("activar-plan-clinico"),
  codigoClienteBloque: document.getElementById("codigo-cliente-bloque"),
  codigoClienteValor: document.getElementById("codigo-cliente-valor"),
  copiarCodigoBtn: document.getElementById("copiar-codigo-btn"),
  vinculosPendientes: document.getElementById("vinculos-pendientes"),
  vinculosActivos: document.getElementById("vinculos-activos"),
  metasSincronizadas: document.getElementById("metas-sincronizadas"),
  metaPotasioValor: document.getElementById("meta-potasio-valor"),
  metaFosforoValor: document.getElementById("meta-fosforo-valor"),
};

// Sin infraestructura de push, se refresca por polling mientras la app está
// abierta — así una solicitud de vínculo nueva aparece sin que el paciente
// tenga que cerrar y volver a abrir la app.
const VINCULOS_POLL_MS = 60000;

let lastAnalysis = []; // current analysis results, mutable for manual correction

init();

async function init() {
  FOODS = await fetch("nutrientes.json").then((r) => r.json());
  // Si el modelo clínico no carga, la app sigue funcionando con los umbrales
  // fijos de UMBRALES en vez de quedarse sin semáforo.
  try {
    LIMITES = await fetch("limites-clinicos.json").then((r) => r.json());
  } catch (e) {
    console.warn("No se pudo cargar limites-clinicos.json, se usan umbrales por defecto", e);
  }
  populateDatalist();
  renderHistory();
  renderTipOfDay();
  renderPlan();
  renderDatosClinicos();
  renderVinculacion();
  refrescarVinculos();
  refrescarMetasSincronizadas();
  setInterval(refrescarVinculos, VINCULOS_POLL_MS);

  els.cameraInput.addEventListener("change", (e) => handleFileSelected(e.target.files[0]));
  els.analyzeBtn.addEventListener("click", analyzeImage);
  els.clearHistoryBtn.addEventListener("click", clearHistory);
  els.manualCancel.addEventListener("click", closeModal);
  els.manualConfirm.addEventListener("click", confirmManualSelection);
  els.aboutBtn.addEventListener("click", () => { els.aboutModal.hidden = false; });
  els.aboutClose.addEventListener("click", () => { els.aboutModal.hidden = true; });
  els.etapaERC.addEventListener("change", guardarDatosClinicos);
  els.diabetes.addEventListener("change", guardarDatosClinicos);
  els.hipertension.addEventListener("change", guardarDatosClinicos);
  els.farmacosK.addEventListener("change", guardarDatosClinicos);
  els.datoDiuresis.addEventListener("change", guardarDatosClinicos);
  els.enDialisis.addEventListener("change", guardarDatosClinicos);
  els.modoEtapaCalculada.addEventListener("change", guardarDatosClinicos);
  els.modoEtapaManual.addEventListener("change", guardarDatosClinicos);
  els.egfrEdad.addEventListener("input", guardarDatosClinicos);
  els.egfrSexo.addEventListener("change", guardarDatosClinicos);
  els.egfrCreatinina.addEventListener("input", guardarDatosClinicos);
  els.egfrCistatina.addEventListener("input", guardarDatosClinicos);
  els.activarPlanClinico.addEventListener("change", activarPlanClinico);
  els.copiarCodigoBtn.addEventListener("click", copiarCodigoCliente);

  document.querySelectorAll(".btn-liquido").forEach((btn) => {
    btn.addEventListener("click", () => registrarLiquido(Number(btn.dataset.ml)));
  });
  els.liquidoAgregarBtn.addEventListener("click", () => {
    const ml = Number(els.liquidoManual.value);
    if (!ml || ml <= 0) return;
    registrarLiquido(ml);
    els.liquidoManual.value = "";
  });
  els.liquidosDeshacerBtn.addEventListener("click", deshacerUltimoLiquido);

  renderCalculadora();
}

function renderTipOfDay() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const dayOfYear = Math.floor((new Date() - start) / 86400000);
  els.tipText.textContent = TIPS_DEL_DIA[dayOfYear % TIPS_DEL_DIA.length];
}

function populateDatalist() {
  els.foodDatalist.innerHTML = FOODS.map((f) => `<option value="${escapeHtml(f.nombre)}">`).join("");
}

function handleFileSelected(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    currentImageDataUrl = reader.result;
    els.preview.src = currentImageDataUrl;
    els.preview.hidden = false;
    els.previewPlaceholder.hidden = true;
    els.analyzeBtn.disabled = false;
    els.results.hidden = true;
    setStatus("");
  };
  reader.readAsDataURL(file);
}

async function analyzeImage() {
  if (!currentImageDataUrl) return;
  els.analyzeBtn.disabled = true;
  setStatus("Analizando la foto con IA…");

  try {
    const res = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
      body: JSON.stringify({ image: currentImageDataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");

    lastAnalysis = (data.items || []).map((item) => ({
      alimentoIA: item.alimento,
      porcionG: Number(item.porcion_g) || 100,
      confianza: item.confianza,
      alternativas: Array.isArray(item.alternativas) ? item.alternativas : [],
      match: matchFood(item.alimento),
    }));

    if (lastAnalysis.length === 0) {
      setStatus("No se identificó ningún alimento en la foto. Intenta con otra imagen.", true);
    } else {
      setStatus("");
      renderResults();
    }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function matchFood(name) {
  if (!name) return null;
  const n = normalize(name);

  for (const food of FOODS) {
    const candidates = [food.nombre, ...(food.alias || [])].map(normalize);
    if (candidates.includes(n)) return food;
  }

  // No exact match: pick the most specific partial match (longest overlap wins),
  // so e.g. "papas fritas" prefers "Papas fritas / Chips" over "Papa / Patata".
  let best = null;
  let bestOverlap = 0;
  for (const food of FOODS) {
    const candidates = [food.nombre, ...(food.alias || [])].map(normalize);
    for (const c of candidates) {
      let overlap = 0;
      if (n.includes(c)) overlap = c.length;
      else if (c.includes(n)) overlap = n.length;
      if (overlap > bestOverlap) {
        best = food;
        bestOverlap = overlap;
      }
    }
  }
  return best;
}

function nivelFor(nutriente, valorMg) {
  const t = umbralesActivos()[nutriente];
  if (valorMg <= t.verde) return "verde";
  if (valorMg <= t.amarillo) return "amarillo";
  return "rojo";
}

function nivelTag(nivel) {
  return { verde: "Bajo", amarillo: "Moderado", rojo: "Alto" }[nivel];
}

// Cuando no hay meta personal, el semáforo describe el contenido del alimento
// en vez de afirmar que se excedió un límite que la app no conoce.
function nivelTagContenido(nivel) {
  return { verde: "Bajo", amarillo: "Medio", rojo: "Alto" }[nivel];
}

function renderResults() {
  els.results.hidden = false;
  els.resultsList.innerHTML = lastAnalysis
    .map((item, idx) => renderFoodResult(item, idx))
    .join("");

  lastAnalysis.forEach((item, idx) => {
    const btn = document.getElementById(`correct-${idx}`);
    if (btn) btn.addEventListener("click", () => openModal(idx));
    if (item.match) {
      const saveBtn = document.getElementById(`save-${idx}`);
      if (saveBtn) saveBtn.addEventListener("click", () => saveToHistory(idx));
    }
    (item.alternativas || []).forEach((alt, altIdx) => {
      const altBtn = document.getElementById(`alt-${idx}-${altIdx}`);
      if (altBtn) altBtn.addEventListener("click", () => useAlternative(idx, alt));
    });
  });
}

function confidenceNote(confianza) {
  if (confianza === undefined || confianza === null) return "";
  const pct = Math.round(confianza * 100);
  if (confianza < 0.5) {
    return `<p class="confidence-note confidence-low">⚠️ Confianza baja (${pct}%) — verifica que el alimento sea correcto.</p>`;
  }
  return `<p class="confidence-note">Confianza de la IA: ${pct}%</p>`;
}

function alternativesRow(item, idx) {
  const alts = (item.alternativas || []).filter((a) => normalize(a) !== normalize(item.match ? item.match.nombre : ""));
  if (alts.length === 0) return "";
  const chips = alts
    .map((alt, altIdx) => `<button class="alt-chip" id="alt-${idx}-${altIdx}">¿Era "${escapeHtml(alt)}"?</button>`)
    .join("");
  return `<div class="alternatives-row">${chips}</div>`;
}

function useAlternative(idx, altName) {
  const found = matchFood(altName);
  if (!found) return;
  lastAnalysis[idx].match = found;
  lastAnalysis[idx].alimentoIA = altName;
  lastAnalysis[idx].alternativas = [];
  lastAnalysis[idx].confianza = null;
  renderResults();
}

function renderFoodResult(item, idx) {
  const { match, porcionG, alimentoIA } = item;
  if (!match) {
    return `
      <div class="food-result">
        <div class="food-result-header">
          <h3>${escapeHtml(alimentoIA || "Alimento no identificado")}</h3>
          <button id="correct-${idx}">Elegir alimento</button>
        </div>
        <p class="no-match">No encontramos este alimento en la base de datos. Selecciónalo manualmente para ver el semáforo.</p>
        ${alternativesRow(item, idx)}
      </div>`;
  }

  const factor = porcionG / 100;
  const valores = {
    potasio_mg: Math.round(match.potasio_mg * factor),
    fosforo_mg: Math.round(match.fosforo_mg * factor),
    sodio_mg: Math.round(match.sodio_mg * factor),
  };
  if (match.carbohidratos_g != null) {
    valores.carbohidratos_g = Math.round(match.carbohidratos_g * factor);
  }

  return `
    <div class="food-result">
      <div class="food-result-header">
        <h3>${escapeHtml(match.nombre)}</h3>
        <button id="correct-${idx}">Corregir</button>
      </div>
      <p class="portion-note">Porción estimada: ${porcionG} g</p>
      ${confidenceNote(item.confianza)}
      ${alternativesRow(item, idx)}
      <div class="semaforo-row">
        ${nutrientesVisibles().map((k) => badge(k, valores[k], match[k])).join("")}
      </div>
      ${notaSinMeta()}
      ${avisoAditivos(match)}
      <button id="save-${idx}" class="btn btn-secondary" style="margin-top:0.75rem;width:100%;">Guardar en historial</button>
    </div>`;
}

// Qué semáforos se muestran: los tres de siempre, más carbohidratos cuando el
// paciente declaró diabetes.
function nutrientesVisibles() {
  const base = ["potasio_mg", "fosforo_mg", "sodio_mg"];
  const d = ensurePerfil().datosClinicos || {};
  if (d.diabetes) base.push("carbohidratos_g");
  return base;
}

// La guía prioriza reducir aditivos fosfatados por sobre el conteo de fósforo
// total, porque el fósforo inorgánico añadido se absorbe mucho más.
function avisoAditivos(match) {
  if (!match || !match.aditivos_fosfato) return "";
  const alto = match.aditivos_fosfato === "alto";
  const texto = alto
    ? "Contiene aditivos con fósforo, que se absorbe casi por completo."
    : "Puede contener aditivos con fósforo según la marca. Revisa la etiqueta.";
  return `<p class="aviso-aditivos ${alto ? "aditivos-alto" : ""}">${texto}</p>`;
}

// Cuando potasio o fósforo se muestran por contenido, hay que decirle al
// paciente qué significa esa etiqueta: describe el alimento, no que se haya
// pasado de un límite. Las guías no fijan una cifra universal para ellos.
function notaSinMeta() {
  const sinMeta = ["potasio_mg", "fosforo_mg"]
    .filter((k) => metaDiaria(k) == null)
    .map((k) => NUTRIENTE_LABEL[k].toLowerCase());
  if (!sinMeta.length || !LIMITES) return "";
  const lista = sinMeta.join(" y ");
  return `<p class="nota-sin-meta">En ${lista} se indica cuánto aporta el alimento, no si superaste tu límite: tu objetivo lo define tu equipo tratante.</p>`;
}

function badge(nutriente, valorPorcion, densidad100g) {
  const unidad = nutriente === "carbohidratos_g" ? "g" : "mg";
  const { nivel, modo } = clasificar(nutriente, valorPorcion, densidad100g);
  if (!nivel) return "";
  // En modo "contenido" el semáforo describe cuán alto es el alimento, no que
  // el paciente se haya pasado de un límite: la etiqueta lo dice explícito.
  const etiqueta = modo === "contenido" ? nivelTagContenido(nivel) : nivelTag(nivel);
  return `
    <div class="semaforo-badge nivel-${nivel}">
      <span class="label">${NUTRIENTE_LABEL[nutriente]}</span>
      <span class="badge-icon-circle">${NUTRIENTE_ICON[nutriente]}</span>
      <span class="value">${valorPorcion} ${unidad}</span>
      <span class="tag-pill">${etiqueta}</span>
    </div>`;
}

// --- Calculadora de consumo diario (K, P, Na, carbohidratos, líquidos) ---
// El total acumulado del día se compara contra la meta DIARIA completa, no
// contra el umbral de una porción (con dos o tres comidas eso siempre
// marcaba rojo). Barra verde hasta 80% de la meta, ámbar de 80% a 100%,
// roja al superarla. Potasio y fósforo solo muestran barra cuando el equipo
// tratante fijó una meta personal (Plan Clínico); si no, se muestra el
// total sin inventar un límite que la app no conoce.
function nivelPorMeta(total, meta) {
  if (total > meta) return "rojo";
  if (total >= meta * 0.8) return "amarillo";
  return "verde";
}

function filaCalculadora(nutriente, total, unidad) {
  const meta = metaDiaria(nutriente);
  const label = NUTRIENTE_LABEL[nutriente];
  const icon = NUTRIENTE_ICON[nutriente];
  const totalFmt = unidad === "g" ? Math.round(total * 10) / 10 : Math.round(total);

  if (meta == null) {
    return `
      <div class="calc-fila calc-sin-meta">
        <div class="calc-fila-head">
          <span class="calc-icon">${icon}</span>
          <span class="calc-label">${label}</span>
          <span class="calc-total">${totalFmt} ${unidad}</span>
          <span class="tag-neutro">sin meta fijada</span>
        </div>
      </div>`;
  }

  const pct = Math.min(100, Math.round((total / meta) * 100));
  const nivel = nivelPorMeta(total, meta);
  const exceso = total > meta
    ? `<p class="calc-exceso">Superaste tu meta por ${Math.round(total - meta)} ${unidad}.</p>` : "";
  return `
    <div class="calc-fila">
      <div class="calc-fila-head">
        <span class="calc-icon">${icon}</span>
        <span class="calc-label">${label}</span>
        <span class="calc-total">${totalFmt} / ${Math.round(meta)} ${unidad}</span>
      </div>
      <div class="calc-barra"><div class="calc-barra-relleno nivel-${nivel}" style="width:${pct}%"></div></div>
      ${exceso}
    </div>`;
}

function filaLiquidos(total, metaLiq) {
  const meta = metaLiq.ml;
  const pct = Math.min(100, Math.round((total / meta) * 100));
  const nivel = nivelPorMeta(total, meta);
  const exceso = total > meta
    ? `<p class="calc-exceso">Superaste tu meta por ${Math.round(total - meta)} ml.</p>` : "";
  const advertencia = metaLiq.esSupuesto
    ? `<p class="calc-advertencia">No registraste tu diuresis: se asume 0 ml/día por seguridad, el supuesto más restrictivo. Esta cifra es provisional — confírmala con tu equipo tratante, porque restringir de más también puede hacerte daño.</p>`
    : "";
  return `
    <div class="calc-fila">
      <div class="calc-fila-head">
        <span class="calc-icon">${ICONO_LIQUIDO}</span>
        <span class="calc-label">Líquidos</span>
        <span class="calc-total">${Math.round(total)} / ${Math.round(meta)} ml</span>
      </div>
      <div class="calc-barra"><div class="calc-barra-relleno nivel-${nivel}" style="width:${pct}%"></div></div>
      ${exceso}
      ${advertencia}
    </div>`;
}

function totalesNutrientesHoy() {
  const history = loadHistory().filter((h) => isToday(h.fecha));
  return history.reduce(
    (acc, h) => {
      acc.potasio_mg += h.potasio_mg || 0;
      acc.fosforo_mg += h.fosforo_mg || 0;
      acc.sodio_mg += h.sodio_mg || 0;
      acc.carbohidratos_g += h.carbohidratos_g || 0;
      return acc;
    },
    { potasio_mg: 0, fosforo_mg: 0, sodio_mg: 0, carbohidratos_g: 0 }
  );
}

function renderCalculadora() {
  if (!els.calculadora) return;
  const totals = totalesNutrientesHoy();
  const filas = [
    filaCalculadora("sodio_mg", totals.sodio_mg, "mg"),
    filaCalculadora("potasio_mg", totals.potasio_mg, "mg"),
    filaCalculadora("fosforo_mg", totals.fosforo_mg, "mg"),
  ];
  if (nutrientesVisibles().includes("carbohidratos_g")) {
    filas.push(filaCalculadora("carbohidratos_g", totals.carbohidratos_g, "g"));
  }

  const metaLiq = metaLiquidos();
  if (metaLiq) {
    filas.push(filaLiquidos(totalLiquidosHoy(), metaLiq));
    els.registroLiquidos.hidden = false;
  } else {
    els.registroLiquidos.hidden = true;
  }

  els.calculadora.innerHTML = filas.join("");
}

const LIQUIDOS_STORAGE_KEY = "kidneyChefLiquidos";

function loadLiquidos() {
  try {
    return JSON.parse(localStorage.getItem(LIQUIDOS_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function totalLiquidosHoy() {
  return loadLiquidos().filter((x) => isToday(x.fecha)).reduce((s, x) => s + x.ml, 0);
}

function registrarLiquido(ml) {
  const arr = loadLiquidos();
  arr.unshift({ ml, fecha: new Date().toISOString() });
  localStorage.setItem(LIQUIDOS_STORAGE_KEY, JSON.stringify(arr));
  renderCalculadora();
  setStatus(`${ml} ml registrados.`);
}

// Quita el registro de líquido más reciente de HOY (no de cualquier día).
function deshacerUltimoLiquido() {
  const arr = loadLiquidos();
  const idx = arr.findIndex((x) => isToday(x.fecha));
  if (idx === -1) return;
  arr.splice(idx, 1);
  localStorage.setItem(LIQUIDOS_STORAGE_KEY, JSON.stringify(arr));
  renderCalculadora();
}

function openModal(itemIndex) {
  pendingManualTarget = itemIndex;
  els.manualSearch.value = "";
  els.modal.hidden = false;
  els.manualSearch.focus();
}

function closeModal() {
  els.modal.hidden = true;
  pendingManualTarget = null;
}

function confirmManualSelection() {
  const name = els.manualSearch.value;
  const found = FOODS.find((f) => normalize(f.nombre) === normalize(name));
  if (!found) {
    els.manualSearch.setCustomValidity("Elige un alimento de la lista");
    els.manualSearch.reportValidity();
    return;
  }
  lastAnalysis[pendingManualTarget].match = found;
  lastAnalysis[pendingManualTarget].alternativas = [];
  lastAnalysis[pendingManualTarget].confianza = null;
  closeModal();
  renderResults();
}

function saveToHistory(idx) {
  const item = lastAnalysis[idx];
  if (!item.match) return;
  const factor = item.porcionG / 100;
  const entry = {
    nombre: item.match.nombre,
    porcionG: item.porcionG,
    potasio_mg: Math.round(item.match.potasio_mg * factor),
    fosforo_mg: Math.round(item.match.fosforo_mg * factor),
    sodio_mg: Math.round(item.match.sodio_mg * factor),
    carbohidratos_g: item.match.carbohidratos_g != null
      ? Math.round(item.match.carbohidratos_g * factor) : null,
    // Densidades por 100 g: sin ellas no se puede reclasificar una entrada
    // guardada cuando el nutriente se evalúa por contenido y no por meta.
    por100g: {
      potasio_mg: item.match.potasio_mg,
      fosforo_mg: item.match.fosforo_mg,
      sodio_mg: item.match.sodio_mg,
      carbohidratos_g: item.match.carbohidratos_g,
    },
    fecha: new Date().toISOString(),
  };
  const history = loadHistory();
  history.unshift(entry);
  localStorage.setItem("dietaRenalHistorial", JSON.stringify(history));
  renderHistory();
  setStatus("Guardado en el historial de hoy.");
  sincronizarConsumoHoy();
}

// Sube el total de HOY (potasio/fósforo) para que el tratante lo vea en su
// gráfico. El backend rechaza esto si el paciente no tiene ningún vínculo
// activo (ver handle_upsert_consumo en server.py) — antes de eso el consumo
// se queda solo en este celular, como siempre.
async function sincronizarConsumoHoy() {
  const perfil = ensurePerfil();
  if (!perfil.vinculacion.codigoCliente) return;
  const totals = totalesNutrientesHoy();
  const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    await fetch(`${API_BASE}/api/pacientes/me/consumo/${fecha}`, {
      method: "PUT",
      headers: { ...authHeadersPaciente(), "Content-Type": "application/json" },
      body: JSON.stringify({
        potasio_mg: Math.round(totals.potasio_mg),
        fosforo_mg: Math.round(totals.fosforo_mg),
      }),
    });
  } catch {
    // sin conexión, o sin vínculo activo todavía: no rompe el guardado local
  }
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem("dietaRenalHistorial") || "[]");
  } catch {
    return [];
  }
}

function isToday(isoDate) {
  const d = new Date(isoDate);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function renderHistory() {
  const history = loadHistory();
  renderCalculadora();

  if (history.length === 0) {
    els.historyList.innerHTML = `<p class="history-empty">Aún no has guardado ningún alimento.</p>`;
    return;
  }

  els.historyList.innerHTML = history
    .slice(0, 30)
    .map((h) => {
      const time = new Date(h.fecha).toLocaleString("es", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
      const dots = nutrientesVisibles()
        .map((k) => {
          const d = h.por100g ? h.por100g[k] : null;
          const { nivel } = clasificar(k, h[k] || 0, d);
          if (!nivel) return "";
          const u = k === "carbohidratos_g" ? "g" : "mg";
          return `<span class="dot-${nivel}" title="${NUTRIENTE_LABEL[k]}: ${h[k] || 0} ${u}"></span>`;
        })
        .join("");
      return `
        <div class="history-item">
          <div>
            <div class="hi-name">${escapeHtml(h.nombre)}</div>
            <div class="hi-meta">${h.porcionG} g · ${time}</div>
          </div>
          <div class="history-dots">${dots}</div>
        </div>`;
    })
    .join("");
}

function clearHistory() {
  if (!confirm("¿Borrar todo el historial guardado en este dispositivo, incluido el registro de líquidos de hoy?")) return;
  localStorage.removeItem("dietaRenalHistorial");
  localStorage.removeItem(LIQUIDOS_STORAGE_KEY);
  renderHistory();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}
