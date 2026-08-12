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

// --- Suscripción vía RevenueCat (@revenuecat/purchases-capacitor) ----------
// El proyecto no usa bundler (app.js se sirve tal cual con <script>), así que
// en vez de `import { Purchases } from "@revenuecat/purchases-capacitor"` se
// llama al plugin directo por su nombre de registro ("Purchases") en
// window.Capacitor.Plugins — así es como Capacitor expone cualquier plugin
// nativo en el WebView, con o sin el wrapper JS del paquete npm. Ese wrapper
// solo aporta tipos; no hace falta para que el plugin funcione.
//
// Pendiente de Camilo antes de que esto sirva de algo (no se puede crear
// cuentas de terceros): crear el proyecto en RevenueCat, vincularlo a las
// cuentas de App Store Connect / Google Play Console (aún no creadas),
// definir el producto de suscripción única ($9.990/mes) en cada tienda, y
// completar las dos API keys públicas de RevenueCat de abajo (una por
// plataforma — son públicas, igual que APP_KEY o las keys de Supabase en
// tratante/config.js). Mientras estén vacías, initRevenueCat() no hace nada
// y la app sigue funcionando solo con el trial local ya implementado.
const REVENUECAT_API_KEY_IOS = "";
const REVENUECAT_API_KEY_ANDROID = "";
const REVENUECAT_ENTITLEMENT_ID = "premium"; // debe coincidir con el entitlement creado en RevenueCat

async function initRevenueCat() {
  if (!esAppNativa()) return;
  const platform = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : null;
  const apiKey = platform === "ios" ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;
  if (!apiKey) return;
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    await Purchases.configure({ apiKey });
    await sincronizarSuscripcionRevenueCat();
  } catch (e) {
    console.warn("No se pudo inicializar RevenueCat", e);
  }
}

// Dispara la compra real si RevenueCat ya está configurado (requiere las API
// keys de arriba y el producto ya creado en las tiendas); si no, deja un
// mensaje de que todavía no está disponible en vez de romper la app.
async function comprarSuscripcion() {
  const platform = esAppNativa() && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : null;
  const apiKey = platform === "ios" ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;
  if (apiKey) {
    try {
      const Purchases = window.Capacitor.Plugins.Purchases;
      const { current } = await Purchases.getOfferings();
      const paquete = current?.availablePackages?.[0];
      if (paquete) {
        await Purchases.purchasePackage({ aPackage: paquete });
        await sincronizarSuscripcionRevenueCat();
        return;
      }
    } catch (e) {
      console.warn("No se pudo completar la compra de la suscripción", e);
    }
  }
  els.paywallMsg.hidden = false;
  els.paywallMsg.textContent = "La suscripción estará disponible muy pronto en esta app.";
}

// Refleja en perfil.suscripcion.activa el entitlement real de RevenueCat. Se
// guarda en localStorage (no solo en memoria) para que el paywall pueda
// evaluarse en el siguiente arranque sin depender de que la llamada a
// RevenueCat ya haya vuelto.
async function sincronizarSuscripcionRevenueCat() {
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { customerInfo } = await Purchases.getCustomerInfo();
    const activa = Boolean(customerInfo?.entitlements?.active?.[REVENUECAT_ENTITLEMENT_ID]);
    const perfil = ensurePerfil();
    perfil.suscripcion.activa = activa;
    guardarPerfil(perfil);
    renderSuscripcion();
  } catch (e) {
    console.warn("No se pudo sincronizar el estado de suscripción de RevenueCat", e);
  }
}

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
  if (d.sexoBiologico === undefined) d.sexoBiologico = null;
  if (d.creatininaMgDl === undefined) d.creatininaMgDl = null;
  if (d.cistatinaMgL === undefined) d.cistatinaMgL = null;
  if (d.cardiovascular === undefined) d.cardiovascular = false;
  if (d.dislipidemia === undefined) d.dislipidemia = false;
  if (d.gota === undefined) d.gota = false;
  if (d.anemia === undefined) d.anemia = false;
  if (d.trasplanteRenal === undefined) d.trasplanteRenal = false;
  if (perfil.umbralesPersonalizados === undefined) perfil.umbralesPersonalizados = null;
  if (perfil.metasDiarias === undefined) perfil.metasDiarias = null;
  if (perfil.vinculacion === undefined) {
    perfil.vinculacion = { codigoCliente: null, deviceSecret: null };
  }
  if (perfil.suscripcion === undefined) {
    perfil.suscripcion = { activa: false };
  }
  if (perfil.terminos === undefined) {
    perfil.terminos = { version: null, aceptadoEn: null };
  }
  if (perfil.datosPersonales === undefined) {
    perfil.datosPersonales = { nombre: "", fechaNacimiento: null };
  }
  if (perfil.confirmacionClinica === undefined) {
    perfil.confirmacionClinica = { confirmado: false, confirmadoEn: null };
  }
  return perfil;
}

// Edad en años cumplidos a partir de una fecha de nacimiento ISO (yyyy-mm-dd),
// o null si no hay fecha. Reemplaza el campo "Edad" que antes se ingresaba a
// mano solo para la calculadora de eGFR — ahora se deriva del perfil, para no
// pedir el mismo dato dos veces y que quede siempre consistente.
function calcularEdad(fechaNacimientoIso) {
  if (!fechaNacimientoIso) return null;
  const nacimiento = new Date(fechaNacimientoIso);
  if (isNaN(nacimiento.getTime())) return null;
  const hoy = new Date();
  let edad = hoy.getFullYear() - nacimiento.getFullYear();
  const cumpleEsteAno = new Date(hoy.getFullYear(), nacimiento.getMonth(), nacimiento.getDate());
  if (hoy < cumpleEsteAno) edad--;
  return edad;
}

function edadActual() {
  return calcularEdad(ensurePerfil().datosPersonales.fechaNacimiento);
}

function renderDatosPersonales() {
  const { nombre, fechaNacimiento } = ensurePerfil().datosPersonales;
  els.perfilNombre.value = nombre || "";
  els.perfilFechaNacimiento.value = fechaNacimiento || "";
  const edad = calcularEdad(fechaNacimiento);
  els.perfilEdadCalculada.textContent = edad != null ? `${edad} años` : "";
}

function guardarDatosPersonales() {
  const perfil = ensurePerfil();
  perfil.datosPersonales = {
    nombre: els.perfilNombre.value,
    fechaNacimiento: els.perfilFechaNacimiento.value || null,
  };
  guardarPerfil(perfil);
  renderDatosPersonales();
  renderResultadoEgfr();
  renderEtapaSello();
}

// Bloquea toda la app (por encima incluso del paywall) hasta que el usuario
// acepte los Términos y Condiciones y la Política de Privacidad vigentes.
// Subir TERMINOS_VERSION cuando cambie el contenido de terminos.html o
// privacidad.html de forma relevante vuelve a pedir la aceptación a todos,
// incluidos quienes ya la habían dado para una versión anterior.
const TERMINOS_VERSION = "1.0";

function terminosAceptados() {
  return ensurePerfil().terminos.version === TERMINOS_VERSION;
}

function renderTerminos() {
  const aceptados = terminosAceptados();
  els.terminosOverlay.hidden = aceptados;
  if (!aceptados) {
    els.terminosCheckbox.checked = false;
    els.terminosAceptarBtn.disabled = true;
  }
}

function aceptarTerminos() {
  if (!els.terminosCheckbox.checked) return;
  const perfil = ensurePerfil();
  perfil.terminos = { version: TERMINOS_VERSION, aceptadoEn: new Date().toISOString() };
  guardarPerfil(perfil);
  renderTerminos();
  renderPerfilOverlay();
}

// Tras aceptar los Términos, se pide nombre y fecha de nacimiento antes de
// dejar usar el resto de la app — igual de bloqueante que terminosOverlay,
// pero solo hasta que ambos campos queden completos una vez (después el
// paciente los edita, si quiere, desde "Tu perfil" en la pestaña Clínico).
function perfilCompleto() {
  const { nombre, fechaNacimiento } = ensurePerfil().datosPersonales;
  return Boolean(nombre && nombre.trim() && fechaNacimiento);
}

function renderPerfilOverlay() {
  const completo = perfilCompleto();
  els.perfilOverlay.hidden = !terminosAceptados() || completo;
  if (completo) return;
  const { nombre, fechaNacimiento } = ensurePerfil().datosPersonales;
  els.perfilOverlayNombre.value = nombre || "";
  els.perfilOverlayFechaNacimiento.value = fechaNacimiento || "";
  actualizarBotonPerfilOverlay();
}

function actualizarBotonPerfilOverlay() {
  els.perfilOverlayContinuarBtn.disabled = !(
    els.perfilOverlayNombre.value.trim() && els.perfilOverlayFechaNacimiento.value
  );
}

function continuarPerfilOverlay() {
  if (els.perfilOverlayContinuarBtn.disabled) return;
  const perfil = ensurePerfil();
  perfil.datosPersonales = {
    nombre: els.perfilOverlayNombre.value.trim(),
    fechaNacimiento: els.perfilOverlayFechaNacimiento.value || null,
  };
  guardarPerfil(perfil);
  renderDatosPersonales();
  renderResultadoEgfr();
  renderEtapaSello();
  renderPerfilOverlay();
}

// Una vez confirmados, "Tu perfil" y "Tus antecedentes clínicos" quedan como
// vista fija (campos deshabilitados) en vez de un formulario siempre abierto
// — evita ediciones accidentales al mirar los datos. Se reabren solo desde
// el ícono de lápiz en la esquina superior, pensado para cuando cambien los
// exámenes y haya que declarar una etapa ERC nueva; al terminar se vuelve a
// confirmar, y así sucesivamente.
const CAMPOS_CLINICOS_BLOQUEABLES = [
  "perfilNombre", "perfilFechaNacimiento",
  "enDialisis", "modoEtapaCalculada", "modoEtapaManual", "etapaERC",
  "egfrSexo", "egfrCreatinina", "egfrCistatina", "datoDiuresis",
  "diabetes", "hipertension", "cardiovascular", "dislipidemia", "gota", "anemia", "trasplanteRenal",
  "farmacosK",
];

function datosClinicosConfirmados() {
  return ensurePerfil().confirmacionClinica.confirmado;
}

function renderModoClinico() {
  const confirmado = datosClinicosConfirmados();
  CAMPOS_CLINICOS_BLOQUEABLES.forEach((campo) => { els[campo].disabled = confirmado; });
  els.confirmarClinicoBtn.hidden = confirmado;
  els.clinicoConfirmadoNota.hidden = !confirmado;
  els.editarClinicoBtn.hidden = !confirmado;
}

function confirmarDatosClinicos() {
  const perfil = ensurePerfil();
  perfil.confirmacionClinica = { confirmado: true, confirmadoEn: new Date().toISOString() };
  guardarPerfil(perfil);
  renderModoClinico();
}

function habilitarEdicionClinica() {
  const perfil = ensurePerfil();
  perfil.confirmacionClinica = { confirmado: false, confirmadoEn: null };
  guardarPerfil(perfil);
  renderModoClinico();
  irATab("clinico");
}

// Suscripción: toda la app es gratis por TRIAL_DIAS desde la primera vez que
// se abre (perfil.creadoEn), y de ahí en adelante requiere perfil.suscripcion.activa
// (hoy siempre false — se pondrá en true cuando se conecte el SDK de compras real).
// El precio sube con el tiempo a medida que se agregan features grandes (recetas del
// refrigerador, Cookidoo); no hay precio legado para quien ya estaba suscrito.
const TRIAL_DIAS = 30;
const PRECIO_SUSCRIPCION_CLP = 9990;

function estadoSuscripcion() {
  const perfil = ensurePerfil();
  const diasTranscurridos = Math.floor(
    (Date.now() - new Date(perfil.creadoEn).getTime()) / 86400000
  );
  const diasRestantes = Math.max(0, TRIAL_DIAS - diasTranscurridos);
  const enTrial = diasRestantes > 0;
  const bloqueado = !enTrial && !perfil.suscripcion.activa;
  return { diasRestantes, enTrial, bloqueado };
}

function renderSuscripcion() {
  const { diasRestantes, enTrial, bloqueado } = estadoSuscripcion();

  els.paywallOverlay.hidden = !bloqueado;
  els.paywallPrecio.textContent = `$${PRECIO_SUSCRIPCION_CLP.toLocaleString("es-CL")} CLP / mes`;

  els.trialBanner.hidden = !enTrial || bloqueado;
  if (enTrial) {
    els.trialBannerText.textContent =
      diasRestantes === 1
        ? "Te queda 1 día de prueba gratis"
        : `Te quedan ${diasRestantes} días de prueba gratis`;
  }
}

function datosClinicosPorDefecto() {
  return {
    etapaERC: null,
    diabetes: false,
    hipertension: false,
    cardiovascular: false,
    dislipidemia: false,
    gota: false,
    anemia: false,
    trasplanteRenal: false,
    diuresisMl: null,
    enDialisis: null,
    modoEtapa: "calculada",
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
// Sodio siempre tiene meta universal. Potasio y fósforo la tienen desde
// ciertas etapas de ERC (metaPorDefectoDesdeEtapa) salvo que el tratante ya
// haya fijado una propia, que siempre prima.
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
  if (nutriente === "potasio_mg") return metaPorDefectoDesdeEtapa(LIMITES.potasio);
  if (nutriente === "fosforo_mg") return metaPorDefectoDesdeEtapa(LIMITES.fosforo);
  return null;
}

// Meta automática de K/P desde ciertas etapas de ERC
// (config.etapas_aplicables en limites-clinicos.json), salvo que el paciente
// tenga riesgo de hiperkalemia (diabetes o fármacos retenedores de potasio):
// ahí Camilo prefirió individualización real por el tratante en vez de un
// número fijo, dado que el riesgo es más impredecible. No se activa en
// diálisis peritoneal ni en 3a/3b porque no están en etapas_aplicables.
// Pedido explícito de Camilo, 2026-08-02 — ver _nota_objetivo_por_defecto.
function metaPorDefectoDesdeEtapa(config) {
  if (!config || config.objetivo_mg_dia_por_defecto == null) return null;
  if (riesgoHiperkalemia()) return null;
  const etapa = situacionActual();
  if (!etapa || !config.etapas_aplicables.includes(etapa)) return null;
  return config.objetivo_mg_dia_por_defecto;
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
  els.cardiovascular.checked = !!d.cardiovascular;
  els.dislipidemia.checked = !!d.dislipidemia;
  els.gota.checked = !!d.gota;
  els.anemia.checked = !!d.anemia;
  els.trasplanteRenal.checked = !!d.trasplanteRenal;
  els.farmacosK.checked = !!d.farmacosRetenedoresK;
  els.datoDiuresis.value = d.diuresisMl ?? "";
  els.modoEtapaCalculada.checked = d.modoEtapa !== "manual";
  els.modoEtapaManual.checked = d.modoEtapa === "manual";
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
  const egfr = calcularEgfr({ ...d, edad: edadActual() });
  if (egfr == null) {
    els.egfrResultado.textContent = "Completa tu fecha de nacimiento (en Tu perfil), tu sexo biológico y al menos un valor (creatinina o cistatina C) para calcular tu eGFR.";
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
  const egfr = calcularEgfr({ ...d, edad: edadActual() });
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
    cardiovascular: els.cardiovascular.checked,
    dislipidemia: els.dislipidemia.checked,
    gota: els.gota.checked,
    anemia: els.anemia.checked,
    trasplanteRenal: els.trasplanteRenal.checked,
    farmacosRetenedoresK: els.farmacosK.checked,
    diuresisMl: diuresisRaw === "" ? null : Number(diuresisRaw),
    enDialisis: els.enDialisis.value || null,
    modoEtapa: els.modoEtapaManual.checked ? "manual" : "calculada",
    sexoBiologico: els.egfrSexo.value || null,
    creatininaMgDl: els.egfrCreatinina.value === "" ? null : Number(els.egfrCreatinina.value),
    cistatinaMgL: els.egfrCistatina.value === "" ? null : Number(els.egfrCistatina.value),
  };

  if (d.enDialisis) {
    d.etapaERC = d.enDialisis;
  } else if (d.modoEtapa === "manual") {
    d.etapaERC = els.etapaERC.value || null;
  } else {
    const egfr = calcularEgfr({ ...d, edad: edadActual() });
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
  egfrSexo: document.getElementById("egfr-sexo"),
  egfrCreatinina: document.getElementById("egfr-creatinina"),
  egfrCistatina: document.getElementById("egfr-cistatina"),
  egfrResultado: document.getElementById("egfr-resultado"),
  etapaManualCampo: document.getElementById("etapa-manual-campo"),
  etapaERC: document.getElementById("etapa-erc"),
  diabetes: document.getElementById("dato-diabetes"),
  hipertension: document.getElementById("dato-hipertension"),
  cardiovascular: document.getElementById("dato-cardiovascular"),
  dislipidemia: document.getElementById("dato-dislipidemia"),
  gota: document.getElementById("dato-gota"),
  anemia: document.getElementById("dato-anemia"),
  trasplanteRenal: document.getElementById("dato-trasplante"),
  farmacosK: document.getElementById("dato-farmacos-k"),
  perfilNombre: document.getElementById("perfil-nombre"),
  perfilFechaNacimiento: document.getElementById("perfil-fecha-nacimiento"),
  perfilEdadCalculada: document.getElementById("perfil-edad-calculada"),
  planUpsell: document.getElementById("plan-upsell"),
  planUpsellText: document.getElementById("plan-upsell-text"),
  trialBanner: document.getElementById("trial-banner"),
  trialBannerText: document.getElementById("trial-banner-text"),
  paywallOverlay: document.getElementById("paywall-overlay"),
  paywallPrecio: document.getElementById("paywall-precio"),
  paywallSuscribirBtn: document.getElementById("paywall-suscribir-btn"),
  paywallMsg: document.getElementById("paywall-msg"),
  terminosOverlay: document.getElementById("terminos-overlay"),
  terminosCheckbox: document.getElementById("terminos-checkbox"),
  terminosAceptarBtn: document.getElementById("terminos-aceptar-btn"),
  perfilOverlay: document.getElementById("perfil-overlay"),
  perfilOverlayNombre: document.getElementById("perfil-overlay-nombre"),
  perfilOverlayFechaNacimiento: document.getElementById("perfil-overlay-fecha-nacimiento"),
  perfilOverlayContinuarBtn: document.getElementById("perfil-overlay-continuar-btn"),
  confirmarClinicoBtn: document.getElementById("confirmar-clinico-btn"),
  clinicoConfirmadoNota: document.getElementById("clinico-confirmado-nota"),
  editarClinicoBtn: document.getElementById("editar-clinico-btn"),
  refrigeradorChecklist: document.getElementById("refrigerador-checklist"),
  refrigeradorBuscarBtn: document.getElementById("refrigerador-buscar-btn"),
  refrigeradorResultados: document.getElementById("refrigerador-resultados"),
  refrigeradorPreviewWrap: document.getElementById("refrigerador-preview-wrap"),
  refrigeradorPreview: document.getElementById("refrigerador-preview"),
  refrigeradorCameraInput: document.getElementById("refrigerador-camera-input"),
  refrigeradorIdentificarBtn: document.getElementById("refrigerador-identificar-btn"),
  refrigeradorIaStatus: document.getElementById("refrigerador-ia-status"),
  refrigeradorIdentificados: document.getElementById("refrigerador-identificados"),
  refrigeradorGenerarBtn: document.getElementById("refrigerador-generar-btn"),
  refrigeradorRecetaIa: document.getElementById("refrigerador-receta-ia"),
  refrigeradorLimpiarBtn: document.getElementById("refrigerador-limpiar-btn"),
  recetasGuardadasWrap: document.getElementById("recetas-guardadas-wrap"),
  recetasGuardadasList: document.getElementById("recetas-guardadas-list"),
  tabBar: document.getElementById("tab-bar"),
  superChecklist: document.getElementById("super-checklist"),
  superItemNombre: document.getElementById("super-item-nombre"),
  superItemPrecio: document.getElementById("super-item-precio"),
  superAgregarBtn: document.getElementById("super-agregar-btn"),
  superCantidad: document.getElementById("super-cantidad"),
  superTotal: document.getElementById("super-total"),
  superProyeccion: document.getElementById("super-proyeccion"),
  superTotalesCadena: document.getElementById("super-totales-cadena"),
  superLimpiarBtn: document.getElementById("super-limpiar-btn"),
  superFotoPreviewWrap: document.getElementById("super-foto-preview-wrap"),
  superFotoPreview: document.getElementById("super-foto-preview"),
  superFotoInput: document.getElementById("super-foto-input"),
  superFotoIdentificarBtn: document.getElementById("super-foto-identificar-btn"),
  superFotoStatus: document.getElementById("super-foto-status"),
};

let lastAnalysis = []; // current analysis results, mutable for manual correction

init();

async function init() {
  FOODS = await fetch("nutrientes.json").then((r) => r.json());
  try {
    RECETAS_DATA = await fetch("recetas.json").then((r) => r.json());
    INGREDIENTES_REFRIGERADOR = await fetch("ingredientes-refrigerador.json").then((r) => r.json());
  } catch (e) {
    console.warn("No se pudo cargar recetas.json / ingredientes-refrigerador.json", e);
  }
  try {
    PRECIOS_REFERENCIA = await fetch("precios-referencia.json").then((r) => r.json());
  } catch (e) {
    console.warn("No se pudo cargar precios-referencia.json", e);
  }
  // Ambos catálogos deben estar cargados antes de renderizar cualquiera de
  // los dos checklists: "Más comprados" del refrigerador agrega frecuencia
  // de cortes de PRECIOS_REFERENCIA a nivel de INGREDIENTES_REFRIGERADOR.
  renderRefrigeradorChecklist();
  renderSuperChecklist();
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
  renderDatosPersonales();
  renderDatosClinicos();
  renderModoClinico();
  renderTerminos();
  renderPerfilOverlay();
  renderSuscripcion();
  initRevenueCat();
  initTabs();
  renderRecetasGuardadas();

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
  els.cardiovascular.addEventListener("change", guardarDatosClinicos);
  els.dislipidemia.addEventListener("change", guardarDatosClinicos);
  els.gota.addEventListener("change", guardarDatosClinicos);
  els.anemia.addEventListener("change", guardarDatosClinicos);
  els.trasplanteRenal.addEventListener("change", guardarDatosClinicos);
  els.farmacosK.addEventListener("change", guardarDatosClinicos);
  els.datoDiuresis.addEventListener("change", guardarDatosClinicos);
  els.enDialisis.addEventListener("change", guardarDatosClinicos);
  els.modoEtapaCalculada.addEventListener("change", guardarDatosClinicos);
  els.modoEtapaManual.addEventListener("change", guardarDatosClinicos);
  els.perfilNombre.addEventListener("input", guardarDatosPersonales);
  els.perfilFechaNacimiento.addEventListener("change", guardarDatosPersonales);
  els.egfrSexo.addEventListener("change", guardarDatosClinicos);
  els.egfrCreatinina.addEventListener("input", guardarDatosClinicos);
  els.egfrCistatina.addEventListener("input", guardarDatosClinicos);
  els.paywallSuscribirBtn.addEventListener("click", comprarSuscripcion);
  els.terminosCheckbox.addEventListener("change", () => {
    els.terminosAceptarBtn.disabled = !els.terminosCheckbox.checked;
  });
  els.terminosAceptarBtn.addEventListener("click", aceptarTerminos);
  els.perfilOverlayNombre.addEventListener("input", actualizarBotonPerfilOverlay);
  els.perfilOverlayFechaNacimiento.addEventListener("input", actualizarBotonPerfilOverlay);
  els.perfilOverlayContinuarBtn.addEventListener("click", continuarPerfilOverlay);
  els.confirmarClinicoBtn.addEventListener("click", confirmarDatosClinicos);
  els.editarClinicoBtn.addEventListener("click", habilitarEdicionClinica);
  els.refrigeradorBuscarBtn.addEventListener("click", buscarRecetasRefrigerador);
  els.refrigeradorCameraInput.addEventListener("change", (e) => handleRefrigeradorFileSelected(e.target.files[0]));
  els.refrigeradorIdentificarBtn.addEventListener("click", identificarIngredientesRefrigerador);
  els.refrigeradorGenerarBtn.addEventListener("click", generarRecetaIA);
  els.refrigeradorLimpiarBtn.addEventListener("click", limpiarSeleccionRefrigerador);

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

  els.superAgregarBtn.addEventListener("click", agregarItemPersonalizadoSuper);
  els.superLimpiarBtn.addEventListener("click", limpiarSeleccionSuper);
  els.superFotoInput.addEventListener("change", (e) => handleSuperFotoSelected(e.target.files[0]));
  els.superFotoIdentificarBtn.addEventListener("click", identificarProductoSuper);

  renderCalculadora();
}

// --- Navegación por pestañas ---
const TAB_STORAGE_KEY = "kidneyChefTabActiva";

function initTabs() {
  const tabGuardada = localStorage.getItem(TAB_STORAGE_KEY);
  const tabs = Array.from(els.tabBar.querySelectorAll(".tab-btn")).map((btn) => btn.dataset.tabTarget);
  irATab(tabGuardada && tabs.includes(tabGuardada) ? tabGuardada : "hoy");

  els.tabBar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => irATab(btn.dataset.tabTarget));
  });
}

function irATab(tab) {
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.classList.toggle("tab-inactive", el.dataset.tab !== tab);
  });
  els.tabBar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.tabTarget === tab));
  });
  localStorage.setItem(TAB_STORAGE_KEY, tab);
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

// --- Recetas con lo que tienes en el refrigerador ---
let RECETAS_DATA = [];
let INGREDIENTES_REFRIGERADOR = [];
let PRECIOS_REFERENCIA = [];
let recetaActualIA = null; // última receta generada por IA, pendiente o ya guardada
const MAX_INGREDIENTES_FALTANTES = 2; // "casi listas": les falta esto o menos
// Sin foto no hay gramos reales de porción: se asume un plato individual
// estándar para poder mostrar el mismo semáforo verde/ámbar/rojo que el resto
// de la app, y se avisa en la UI que hay que ajustar según cuánto se sirva.
const PORCION_REFERENCIA_RECETA_G = 300;

// Mismo historial de frecuencia que Súper (kidneyChefFrecuenciaCompra), pero
// agregado al id de producto genérico: un corte marcado seguido en Súper
// (ej. posta_negra_vacuno) suma para "vacuno" acá, porque el checklist del
// refrigerador no distingue cortes. Devuelve ids de INGREDIENTES_REFRIGERADOR,
// no objetos, para no depender de que PRECIOS_REFERENCIA ya esté cargado.
function idsIngredientesMasComprados() {
  const frecuencia = loadFrecuenciaCompra();
  const porIdBase = new Map();
  for (const [id, veces] of Object.entries(frecuencia)) {
    const idBase = idCatalogoBase(id);
    porIdBase.set(idBase, (porIdBase.get(idBase) || 0) + veces);
  }
  return [...porIdBase.entries()]
    .filter(([idBase]) => INGREDIENTES_REFRIGERADOR.some((ing) => ing.id === idBase))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAS_COMPRADOS_MAX)
    .map(([idBase]) => idBase);
}

function renderRefrigeradorChecklist() {
  const porCategoria = new Map();
  for (const ing of INGREDIENTES_REFRIGERADOR) {
    if (!porCategoria.has(ing.categoria)) porCategoria.set(ing.categoria, []);
    porCategoria.get(ing.categoria).push(ing);
  }

  const destacadosIds = idsIngredientesMasComprados();
  const destacados = destacadosIds
    .map((id) => INGREDIENTES_REFRIGERADOR.find((ing) => ing.id === id))
    .filter(Boolean);

  const bloqueDestacados = destacados.length
    ? `<div class="mas-comprados">
        <p class="super-categoria-titulo">Tus productos más comprados</p>
        <div class="frecuentes-chips">
          ${destacados
            .map(
              (ing) => `
            <label class="super-frecuente-chip">
              <input type="checkbox" id="refrigerador-check-freq-${ing.id}">
              <span>${escapeHtml(ing.nombre)}</span>
            </label>`
            )
            .join("")}
        </div>
      </div>`
    : "";

  els.refrigeradorChecklist.innerHTML = bloqueDestacados + [...porCategoria.entries()]
    .map(([categoria, ingredientes]) => `
      <div class="refrigerador-categoria">
        <h4>${escapeHtml(categoria)}</h4>
        <div class="clinical-checks">
          ${ingredientes
            .map((ing) => `
              <label class="clinical-check">
                <input type="checkbox" class="refrigerador-ingrediente" id="refrigerador-check-${ing.id}" value="${ing.id}">
                ${escapeHtml(ing.nombre)}
              </label>`)
            .join("")}
        </div>
      </div>`)
    .join("");

  destacados.forEach((ing) => {
    const checkbox = document.getElementById(`refrigerador-check-${ing.id}`);
    const chipCheckbox = document.getElementById(`refrigerador-check-freq-${ing.id}`);
    const onToggle = (checked) => {
      checkbox.checked = checked;
      chipCheckbox.checked = checked;
    };
    checkbox.addEventListener("change", (e) => onToggle(e.target.checked));
    chipCheckbox.addEventListener("change", (e) => onToggle(e.target.checked));
  });
}

// Ingredientes para el matching contra las 35 recetas fijas: lo marcado a
// mano MÁS lo identificado por foto, traducido de vuelta al id canónico del
// checklist (nutrientes_id -> id) cuando existe equivalencia. Antes solo
// miraba el checklist e ignoraba por completo la foto, lo que hacía parecer
// que "Buscar entre recetas conocidas" tiraba resultados sin relación con lo
// recién fotografiado.
function ingredientesSeleccionados() {
  const ids = new Set(
    [...document.querySelectorAll(".refrigerador-ingrediente:checked")].map((el) => el.value)
  );
  for (const item of ingredientesIdentificados) {
    for (const ing of INGREDIENTES_REFRIGERADOR) {
      if (ing.nutrientes_id === item.match.id) ids.add(ing.id);
    }
  }
  return ids;
}

function buscarRecetasRefrigerador() {
  const tiene = ingredientesSeleccionados();
  const completas = [];
  const casiListas = [];

  for (const receta of RECETAS_DATA) {
    if (!receta.armable) continue;
    const faltantes = receta.ingredientes.filter((id) => !tiene.has(id));
    const tieneAlgunoEnComun = faltantes.length < receta.ingredientes.length;
    if (faltantes.length === 0) completas.push(receta);
    // "Casi lista" exige además tener al menos un ingrediente en común: sin
    // esto, una receta de 1-2 ingredientes en total calificaba igual aunque
    // no tuvieras NINGUNO de ellos, mostrando resultados sin relación real
    // con lo que el paciente marcó.
    else if (faltantes.length <= MAX_INGREDIENTES_FALTANTES && tieneAlgunoEnComun) {
      casiListas.push({ receta, faltantes });
    }
  }

  renderRefrigeradorResultados(completas, casiListas);
}

function nombreIngrediente(id) {
  const ing = INGREDIENTES_REFRIGERADOR.find((i) => i.id === id);
  return ing ? ing.nombre : id;
}

function renderRefrigeradorResultados(completas, casiListas) {
  els.refrigeradorResultados.hidden = false;

  if (completas.length === 0 && casiListas.length === 0) {
    els.refrigeradorResultados.innerHTML = `
      <p class="no-match">No encontramos recetas con esos ingredientes. Marca más ingredientes e intenta de nuevo.</p>`;
    return;
  }

  const nota = `
    <p class="summary-caption">
      Semáforo calculado para una porción de referencia de ${PORCION_REFERENCIA_RECETA_G} g.
      Ajusta según cuánto te sirvas.
    </p>`;
  const seccionCompletas = completas.length
    ? `<h3>Puedes prepararlas ahora</h3>${completas.map((r) => tarjetaReceta(r)).join("")}`
    : "";
  const seccionCasi = casiListas.length
    ? `<h3>Te falta poco</h3>${casiListas.map(({ receta, faltantes }) => tarjetaReceta(receta, faltantes)).join("")}`
    : "";

  els.refrigeradorResultados.innerHTML = nota + seccionCompletas + seccionCasi;
}

function tarjetaReceta(receta, faltantes) {
  const match = FOODS.find((f) => f.id === receta.id);
  const factor = PORCION_REFERENCIA_RECETA_G / 100;
  const semaforo = match
    ? `<div class="semaforo-row">
        ${nutrientesVisibles()
          .filter((k) => match[k] != null)
          .map((k) => badge(k, Math.round(match[k] * factor), match[k]))
          .join("")}
      </div>${notaSinMeta()}`
    : `<p class="no-match">Sin datos nutricionales cargados para esta receta.</p>`;

  const faltantesHtml = faltantes && faltantes.length
    ? `<p class="portion-note">Te falta: ${faltantes.map((id) => escapeHtml(nombreIngrediente(id))).join(", ")}</p>`
    : "";

  return `
    <div class="food-result">
      <div class="food-result-header"><h3>${escapeHtml(receta.nombre)}</h3></div>
      ${faltantesHtml}
      ${semaforo}
    </div>`;
}

// --- Identificar ingredientes por foto y generar una receta a medida con IA ---
let refrigeradorImagenDataUrl = null;
let ingredientesIdentificados = []; // [{ alimentoIA, match }], match siempre resuelto en FOODS

function handleRefrigeradorFileSelected(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    refrigeradorImagenDataUrl = reader.result;
    els.refrigeradorPreview.src = refrigeradorImagenDataUrl;
    els.refrigeradorPreviewWrap.hidden = false;
    els.refrigeradorIdentificarBtn.disabled = false;
    setRefrigeradorStatus("");
  };
  reader.readAsDataURL(file);
}

function setRefrigeradorStatus(msg, isError = false, isLoading = false) {
  els.refrigeradorIaStatus.innerHTML = isLoading
    ? `<span class="status-spinner" aria-hidden="true"></span>${escapeHtml(msg)}`
    : escapeHtml(msg);
  els.refrigeradorIaStatus.classList.toggle("error", isError);
}

async function identificarIngredientesRefrigerador() {
  if (!refrigeradorImagenDataUrl) return;
  els.refrigeradorIdentificarBtn.disabled = true;
  setRefrigeradorStatus("Identificando ingredientes con IA…", false, true);

  try {
    const res = await fetch(`${API_BASE}/api/identificar-ingredientes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
      body: JSON.stringify({ image: refrigeradorImagenDataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");

    const nuevos = (data.items || [])
      .map((item) => ({ alimentoIA: item.alimento, match: matchFood(item.alimento) }))
      .filter((item) => item.match);

    if (nuevos.length === 0) {
      setRefrigeradorStatus("No identificamos ningún ingrediente conocido en la foto. Intenta con otra imagen o márcalos a mano.", true);
      return;
    }
    // Cada foto reemplaza a la anterior, no se acumulan: una foto nueva
    // significa "esto es lo que tengo ahora", no "agrega esto a lo de antes"
    // — acumular en silencio hacía que una receta generada mezclara
    // ingredientes de fotos distintas sin que se notara en la UI.
    ingredientesIdentificados = nuevos;
    setRefrigeradorStatus("");
    renderIngredientesIdentificados();
  } catch (err) {
    setRefrigeradorStatus(err.message, true);
  } finally {
    els.refrigeradorIdentificarBtn.disabled = false;
  }
}

function renderIngredientesIdentificados() {
  els.refrigeradorIdentificados.innerHTML = ingredientesIdentificados
    .map((item, idx) => `<button class="alt-chip alt-chip-removable" id="refrigerador-quitar-${idx}">${escapeHtml(item.match.nombre)} ✕</button>`)
    .join("");
  ingredientesIdentificados.forEach((_, idx) => {
    const btn = document.getElementById(`refrigerador-quitar-${idx}`);
    if (btn) btn.addEventListener("click", () => {
      ingredientesIdentificados.splice(idx, 1);
      renderIngredientesIdentificados();
    });
  });
}

function limpiarSeleccionRefrigerador() {
  ingredientesIdentificados = [];
  renderIngredientesIdentificados();
  document.querySelectorAll(".refrigerador-ingrediente:checked").forEach((el) => { el.checked = false; });
  document.querySelectorAll('[id^="refrigerador-check-freq-"]:checked').forEach((el) => { el.checked = false; });
  refrigeradorImagenDataUrl = null;
  els.refrigeradorPreviewWrap.hidden = true;
  els.refrigeradorIdentificarBtn.disabled = true;
  els.refrigeradorResultados.hidden = true;
  els.refrigeradorRecetaIa.hidden = true;
  setRefrigeradorStatus("");
}

// --- Lista de supermercado con precios de referencia ---
const SUPER_SELECCION_STORAGE_KEY = "kidneyChefSuperSeleccion";
const SUPER_CUSTOM_STORAGE_KEY = "kidneyChefSuperCustom";
const SUPER_FRECUENCIA_STORAGE_KEY = "kidneyChefFrecuenciaCompra";
const MAS_COMPRADOS_MAX = 6;
const SEMANAS_POR_MES = 4.33;

// Cuántas veces marcó el paciente cada producto a lo largo del tiempo — no
// se resetea con "Limpiar selección" (esa borra la lista de esta semana, no
// el historial de qué compra seguido). Base de "Más comprados" en Súper y,
// agregada a nivel de producto genérico, también en el checklist manual del
// Refrigerador.
function loadFrecuenciaCompra() {
  try {
    return JSON.parse(localStorage.getItem(SUPER_FRECUENCIA_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function registrarCompraFrecuente(id) {
  const frecuencia = loadFrecuenciaCompra();
  frecuencia[id] = (frecuencia[id] || 0) + 1;
  localStorage.setItem(SUPER_FRECUENCIA_STORAGE_KEY, JSON.stringify(frecuencia));
}

// El id de catálogo "base" de un id de Súper: para un corte (ej.
// posta_negra_vacuno) es el producto padre (vacuno), que es el nivel al que
// existe en ingredientes-refrigerador.json; para un producto sin cortes es
// el mismo id.
function idCatalogoBase(id) {
  for (const item of PRECIOS_REFERENCIA) {
    if (item.id === id) return item.id;
    if (item.cortes && item.cortes.some((corte) => corte.id === id)) return item.id;
  }
  return id;
}
const CADENAS_SUPER = [
  { id: "jumbo", label: "Jumbo" },
  { id: "lider", label: "Líder" },
  { id: "unimarc", label: "Unimarc" },
  { id: "tottus", label: "Tottus" },
];

// La cadena más barata para ESE producto puntual — no asume que el paciente
// compra todo en la misma cadena (ver totalesPorCadena() para esa otra vista).
function cadenaMasBarata(item) {
  let mejor = null;
  for (const cadena of CADENAS_SUPER) {
    const precio = item.precios[cadena.id];
    if (!mejor || precio < mejor.precio) mejor = { cadena: cadena.id, precio };
  }
  return mejor;
}

const PORCION_REFERENCIA_SUPER_G = 150;

function foodDeCatalogo(catalogoId) {
  const ing = INGREDIENTES_REFRIGERADOR.find((i) => i.id === catalogoId);
  const nutrientesId = ing && ing.nutrientes_id;
  return nutrientesId ? FOODS.find((f) => f.id === nutrientesId) : null;
}

// Los cortes específicos (y algún ítem de nivel superior, como "vacuno") ya
// traen su propio nutrientes_id embebido en precios-referencia.json — solo
// el resto de los productos genéricos depende del reverso vía
// ingredientes-refrigerador.json.
function foodDeItem(item) {
  if (item.nutrientes_id) return FOODS.find((f) => f.id === item.nutrientes_id) || null;
  return foodDeCatalogo(item.id);
}

// Todos los productos con precio propio, aplanando los cortes específicos
// dentro de sus productos padre — así el resto del código (selección,
// totales) no necesita distinguir entre un producto genérico y un corte.
function itemsPreciables() {
  const flat = [];
  for (const item of PRECIOS_REFERENCIA) {
    flat.push(item);
    if (item.cortes) flat.push(...item.cortes);
  }
  return flat;
}

// Los 3 nutrientes por separado (potasio, fósforo, sodio), no solo el peor —
// un paciente puede necesitar cuidar uno en particular aunque no sea el más
// alto de los tres. Misma lógica clínica que el resto de la app
// (clasificar() por contenido, mg/100g, cuando no hay meta personal), no un
// umbral inventado para esta pantalla.
function semaforosCompactos(food) {
  if (!food) return "";
  const factor = PORCION_REFERENCIA_SUPER_G / 100;
  const chips = ["potasio_mg", "fosforo_mg", "sodio_mg"]
    .map((nutriente) => {
      const densidad100g = food[nutriente];
      if (densidad100g == null) return "";
      const valorPorcion = Math.round(densidad100g * factor);
      const { nivel } = clasificar(nutriente, valorPorcion, densidad100g);
      if (!nivel) return "";
      const etiqueta = nivelTagContenido(nivel);
      return `<span class="super-semaforo nivel-${nivel}">${escapeHtml(NUTRIENTE_LABEL[nutriente])} ${escapeHtml(etiqueta)}</span>`;
    })
    .join("");
  return chips ? `<div class="super-semaforos">${chips}</div>` : "";
}

function loadSuperSeleccion() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SUPER_SELECCION_STORAGE_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSuperSeleccion(set) {
  localStorage.setItem(SUPER_SELECCION_STORAGE_KEY, JSON.stringify([...set]));
}

function loadSuperCustom() {
  try {
    return JSON.parse(localStorage.getItem(SUPER_CUSTOM_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSuperCustom(arr) {
  localStorage.setItem(SUPER_CUSTOM_STORAGE_KEY, JSON.stringify(arr));
}

function formatoCLP(n) {
  return `$${Math.round(n).toLocaleString("es-CL")}`;
}

function renderSuperChecklist() {
  const seleccion = loadSuperSeleccion();
  const custom = loadSuperCustom();

  const categorias = [];
  PRECIOS_REFERENCIA.forEach((item) => {
    if (!categorias.includes(item.categoria)) categorias.push(item.categoria);
  });

  const filaPrecios = (preciable) => {
    const masBarata = cadenaMasBarata(preciable);
    return CADENAS_SUPER.map((cadena) => {
      const precio = preciable.precios[cadena.id];
      const esMin = cadena.id === masBarata.cadena;
      return `<span class="super-chip-precio${esMin ? " super-chip-min" : ""}">${escapeHtml(cadena.label)} <strong>${formatoCLP(precio)}</strong></span>`;
    }).join("");
  };

  const filaCorte = (corte) => `
    <div class="super-item super-item-corte">
      <div class="super-item-top">
        <input type="checkbox" id="super-check-${corte.id}" ${seleccion.has(corte.id) ? "checked" : ""}>
        <span class="super-item-nombre">${escapeHtml(corte.nombre)}<small>${escapeHtml(corte.presentacion)}</small></span>
      </div>
      ${semaforosCompactos(foodDeItem(corte))}
      <div class="super-item-precios">${filaPrecios(corte)}</div>
    </div>`;

  // "Carne de vacuno" agrupa cortes con precio y aporte nutricional muy
  // distintos entre sí (una posta magra no es lo mismo que un asado de tira
  // con grasa) — ponerle un precio o semáforo único al genérico sería
  // impreciso a propósito. Queda solo como título de la categoría; los
  // cortes reales, siempre visibles debajo, son lo que se marca y compra.
  const filaConCortes = (item) => `
    <div class="super-item super-item-titulo">
      <p class="super-item-titulo-nombre">${escapeHtml(item.nombre)}</p>
      <p class="super-item-titulo-nota">Cada corte tiene su propio precio y aporte nutricional — elige uno abajo.</p>
      <div class="super-cortes">${item.cortes.map(filaCorte).join("")}</div>
    </div>`;

  const filaCatalogo = (item) => {
    if (item.cortes && item.cortes.length) return filaConCortes(item);
    return `
    <div class="super-item">
      <div class="super-item-top">
        <input type="checkbox" id="super-check-${item.id}" ${seleccion.has(item.id) ? "checked" : ""}>
        <span class="super-item-nombre">
          ${escapeHtml(item.nombre)}<small>${escapeHtml(item.presentacion)}</small>
        </span>
      </div>
      ${semaforosCompactos(foodDeItem(item))}
      <div class="super-item-precios">${filaPrecios(item)}</div>
    </div>`;
  };

  const destacados = itemsMasComprados();
  let html = destacados.length
    ? `<div class="mas-comprados">
        <p class="super-categoria-titulo">Tus productos más comprados</p>
        <div class="frecuentes-chips">
          ${destacados
            .map(
              (item) => `
            <label class="super-frecuente-chip">
              <input type="checkbox" id="super-check-freq-${item.id}" ${seleccion.has(item.id) ? "checked" : ""}>
              <span>${escapeHtml(item.nombre)}</span>
            </label>`
            )
            .join("")}
        </div>
      </div>`
    : "";

  // Cada categoría es un "pasillo" plegable (mismo <details> nativo que ya
  // usa "O márcalos a mano" en Refrigerador) — todo expandido a la vez
  // obligaba a un scroll larguísimo para llegar, por ejemplo, a Abarrotes.
  // Cerrados por defecto: el paciente entra al pasillo que necesita, como en
  // un súper real, en vez de desplazarse por los otros tres primero.
  html += categorias
    .map((categoria) => {
      const items = PRECIOS_REFERENCIA.filter((i) => i.categoria === categoria);
      const cantidad = items.reduce((acc, i) => acc + (i.cortes ? i.cortes.length : 1), 0);
      return `
      <details class="super-pasillo">
        <summary>${escapeHtml(categoria)}<span class="super-pasillo-count">${cantidad}</span></summary>
        <div class="super-pasillo-contenido">${items.map(filaCatalogo).join("")}</div>
      </details>`;
    })
    .join("");

  if (custom.length) {
    const filaCustom = (item) => `
      <div class="super-item">
        <div class="super-item-top">
          <input type="checkbox" id="super-check-${item.id}" ${item.checked ? "checked" : ""}>
          <span class="super-item-nombre">${escapeHtml(item.nombre)}</span>
          <span class="super-item-precio">${formatoCLP(item.precio_clp)}</span>
          <button class="super-item-quitar" id="super-quitar-${item.id}" aria-label="Quitar producto">✕</button>
        </div>
      </div>`;
    html += `<div><p class="super-categoria-titulo">Agregados por ti</p>${custom.map(filaCustom).join("")}</div>`;
  }

  els.superChecklist.innerHTML = html;

  itemsPreciables().forEach((item) => {
    if (item.cortes) return; // "vacuno" y similares son solo título, sin checkbox propio
    const checkbox = document.getElementById(`super-check-${item.id}`);
    const chipCheckbox = document.getElementById(`super-check-freq-${item.id}`);
    // El chip de "más comprados" y el checkbox del listado son dos <input>
    // que representan el mismo id — al mover cualquiera de los dos, el otro
    // se actualiza a mano (sin volver a renderizar toda la lista) para que
    // no queden desincronizados.
    const onToggle = (checked) => {
      toggleSuperCatalogo(item.id, checked);
      checkbox.checked = checked;
      if (chipCheckbox) chipCheckbox.checked = checked;
    };
    checkbox.addEventListener("change", (e) => onToggle(e.target.checked));
    if (chipCheckbox) chipCheckbox.addEventListener("change", (e) => onToggle(e.target.checked));
  });
  custom.forEach((item) => {
    document.getElementById(`super-check-${item.id}`).addEventListener("change", (e) => {
      toggleSuperCustom(item.id, e.target.checked);
    });
    document.getElementById(`super-quitar-${item.id}`).addEventListener("click", () => quitarItemCustom(item.id));
  });

  actualizarResumenSuper();
}

function toggleSuperCatalogo(id, checked) {
  const seleccion = loadSuperSeleccion();
  if (checked) {
    seleccion.add(id);
    registrarCompraFrecuente(id);
  } else {
    seleccion.delete(id);
  }
  saveSuperSeleccion(seleccion);
  actualizarResumenSuper();
}

// Los N productos que más veces marcó el paciente en Súper (frecuencia > 0),
// de más a menos frecuente. Solo productos con checkbox propio — un padre
// con cortes (ej. "vacuno") nunca se marca directamente, así que nunca junta
// frecuencia él mismo.
function itemsMasComprados() {
  const frecuencia = loadFrecuenciaCompra();
  return itemsPreciables()
    .filter((item) => !item.cortes && (frecuencia[item.id] || 0) > 0)
    .sort((a, b) => (frecuencia[b.id] || 0) - (frecuencia[a.id] || 0))
    .slice(0, MAS_COMPRADOS_MAX);
}

function toggleSuperCustom(id, checked) {
  const arr = loadSuperCustom();
  const item = arr.find((i) => i.id === id);
  if (item) item.checked = checked;
  saveSuperCustom(arr);
  actualizarResumenSuper();
}

function quitarItemCustom(id) {
  const arr = loadSuperCustom().filter((i) => i.id !== id);
  saveSuperCustom(arr);
  renderSuperChecklist();
}

function agregarItemPersonalizadoSuper() {
  const nombre = els.superItemNombre.value.trim();
  const precio = Number(els.superItemPrecio.value);
  if (!nombre || !precio || precio <= 0) return;

  const arr = loadSuperCustom();
  arr.push({ id: `custom-${Date.now()}`, nombre, precio_clp: precio, checked: true });
  saveSuperCustom(arr);

  els.superItemNombre.value = "";
  els.superItemPrecio.value = "";
  renderSuperChecklist();
}

function limpiarSeleccionSuper() {
  saveSuperSeleccion(new Set());
  saveSuperCustom([]);
  renderSuperChecklist();
}

function actualizarResumenSuper() {
  const seleccion = loadSuperSeleccion();
  const custom = loadSuperCustom();

  const itemsCatalogo = itemsPreciables().filter((i) => seleccion.has(i.id));
  const itemsCustom = custom.filter((i) => i.checked);
  const cantidad = itemsCatalogo.length + itemsCustom.length;
  const totalMezclado = itemsCatalogo.reduce((acc, i) => acc + cadenaMasBarata(i).precio, 0)
    + itemsCustom.reduce((acc, i) => acc + i.precio_clp, 0);

  els.superCantidad.textContent = cantidad;
  els.superTotal.textContent = formatoCLP(totalMezclado);
  els.superProyeccion.textContent = cantidad
    ? `Si compras esta lista cada semana: ≈ ${formatoCLP(totalMezclado * SEMANAS_POR_MES)} al mes.`
    : "";

  renderTotalesPorCadena(itemsCatalogo, itemsCustom);
}

// A diferencia del total mezclado (que asume que el paciente va cadena por
// cadena buscando lo más barato de cada producto, poco realista en la
// práctica), esto muestra cuánto saldría el mismo carro comprando TODO en
// una sola cadena — la comparación que de verdad sirve para elegir dónde ir.
function renderTotalesPorCadena(itemsCatalogo, itemsCustom) {
  if (itemsCatalogo.length + itemsCustom.length === 0) {
    els.superTotalesCadena.innerHTML = "";
    return;
  }

  const extraCustom = itemsCustom.reduce((acc, i) => acc + i.precio_clp, 0);
  const totales = CADENAS_SUPER.map((cadena) => ({
    cadena,
    total: itemsCatalogo.reduce((acc, i) => acc + i.precios[cadena.id], 0) + extraCustom,
  })).sort((a, b) => a.total - b.total);

  const filas = totales
    .map((t, idx) => `
      <div class="super-totales-cadena-fila${idx === 0 ? " super-totales-cadena-min" : ""}">
        <span>${escapeHtml(t.cadena.label)}</span>
        <span>${formatoCLP(t.total)}</span>
      </div>`)
    .join("");

  els.superTotalesCadena.innerHTML = `
    <p class="super-totales-cadena-titulo">Si compras todo en una sola cadena</p>
    ${filas}`;
}

// --- Agregar producto a la lista de súper con una foto ---
// Reutiliza el mismo endpoint de IA que el refrigerador (/api/identificar-
// ingredientes) — no hace falta un modelo de reconocimiento aparte solo para
// esto. La diferencia es el paso siguiente: acá el resultado de matchFood()
// (id en nutrientes.json) hay que traducirlo de vuelta al id del catálogo de
// precios (ej. "res" -> "vacuno"), mismo patrón de reverso que ya usa
// ingredientesSeleccionados() para las recetas del refrigerador.
let superFotoImagenDataUrl = null;

function handleSuperFotoSelected(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    superFotoImagenDataUrl = reader.result;
    els.superFotoPreview.src = superFotoImagenDataUrl;
    els.superFotoPreviewWrap.hidden = false;
    els.superFotoIdentificarBtn.disabled = false;
    setSuperFotoStatus("");
  };
  reader.readAsDataURL(file);
}

function setSuperFotoStatus(msg, isError = false, isLoading = false) {
  els.superFotoStatus.innerHTML = isLoading
    ? `<span class="status-spinner" aria-hidden="true"></span>${escapeHtml(msg)}`
    : escapeHtml(msg);
  els.superFotoStatus.classList.toggle("error", isError);
}

function catalogoIdDesdeNutrientesId(nutrientesId) {
  const ing = INGREDIENTES_REFRIGERADOR.find((i) => i.nutrientes_id === nutrientesId);
  if (!ing) return null;
  return PRECIOS_REFERENCIA.some((p) => p.id === ing.id) ? ing.id : null;
}

async function identificarProductoSuper() {
  if (!superFotoImagenDataUrl) return;
  els.superFotoIdentificarBtn.disabled = true;
  setSuperFotoStatus("Identificando producto con IA…", false, true);

  try {
    const res = await fetch(`${API_BASE}/api/identificar-ingredientes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
      body: JSON.stringify({ image: superFotoImagenDataUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");

    const identificados = (data.items || []).map((item) => item.alimento).filter(Boolean);
    if (identificados.length === 0) {
      setSuperFotoStatus("No identificamos ningún producto en la foto. Intenta con otra imagen o agrégalo a mano abajo.", true);
      return;
    }

    const agregados = [];
    const sinCatalogo = [];
    for (const nombreIA of identificados) {
      const match = matchFood(nombreIA);
      const catalogoId = match && catalogoIdDesdeNutrientesId(match.id);
      if (catalogoId) {
        const seleccion = loadSuperSeleccion();
        seleccion.add(catalogoId);
        saveSuperSeleccion(seleccion);
        agregados.push(PRECIOS_REFERENCIA.find((p) => p.id === catalogoId).nombre);
      } else {
        sinCatalogo.push(nombreIA);
      }
    }

    renderSuperChecklist();

    const partes = [];
    if (agregados.length) partes.push(`Marcamos en la lista: ${agregados.join(", ")}.`);
    if (sinCatalogo.length) {
      partes.push(`No tenemos precio de referencia para "${sinCatalogo.join(", ")}" — agrégalo abajo con su precio.`);
      els.superItemNombre.value = sinCatalogo[0];
      els.superItemNombre.focus();
    }
    setSuperFotoStatus(partes.join(" "), sinCatalogo.length > 0 && agregados.length === 0);
  } catch (err) {
    setSuperFotoStatus(err.message, true);
  } finally {
    els.superFotoIdentificarBtn.disabled = false;
  }
}

// Ingredientes candidatos para la receta generada: los identificados por foto
// (ya resueltos contra nutrientes.json) más los marcados a mano en el
// checklist que tengan un equivalente confiable en nutrientes.json — no todo
// ingrediente del checklist lo tiene (ver generar_recetas_json.py), y sin un
// valor auditado no se puede ofrecer como candidato a la IA.
function candidatosParaIA() {
  const ids = new Set(ingredientesIdentificados.map((item) => item.match.id));
  for (const el of document.querySelectorAll(".refrigerador-ingrediente:checked")) {
    const ing = INGREDIENTES_REFRIGERADOR.find((i) => i.id === el.value);
    if (ing && ing.nutrientes_id) ids.add(ing.nutrientes_id);
  }
  return [...ids];
}

// Lo que le queda disponible hoy: meta diaria menos lo ya registrado en el
// historial. Solo se incluyen nutrientes con meta conocida (sodio siempre,
// potasio/fósforo con Plan Clínico, carbohidratos si es diabético) — igual
// que el resto de la app, no se inventa un límite que no existe.
function presupuestoRestanteHoy() {
  const totals = totalesNutrientesHoy();
  const out = {};
  for (const n of ["sodio_mg", "potasio_mg", "fosforo_mg", "carbohidratos_g"]) {
    const meta = metaDiaria(n);
    if (meta == null) continue;
    out[n] = Math.max(0, Math.round(meta - (totals[n] || 0)));
  }
  return out;
}

// Sin meta personal de potasio/fósforo no hay un total que no superar, pero
// el semáforo del celular igual clasifica por CONTENIDO (mg/100g, ver
// clasificar()) — sin mandarle este umbral a la IA, ella no tenía con qué
// comparar para decidir si valía la pena escribir un consejo, aunque el
// semáforo ya mostrara amarillo o rojo.
function densidadMaximaSinMeta() {
  if (!LIMITES) return {};
  const out = {};
  if (metaDiaria("potasio_mg") == null) {
    const cfg = (riesgoHiperkalemia() && LIMITES.potasio.clasificacion_contenido_estricta)
      || LIMITES.potasio.clasificacion_contenido;
    out.potasio_mg = cfg.moderado_hasta;
  }
  if (metaDiaria("fosforo_mg") == null) {
    out.fosforo_mg = LIMITES.fosforo.clasificacion_contenido.moderado_hasta;
  }
  return out;
}

// La receta generada tiene que usar la situación clínica declarada (etapa
// ERC o modalidad de diálisis) — no solo umbrales genéricos de K/P/Na. Sin
// esto, la clínica del paciente es letra muerta para esta feature, que es
// justo el pilar de la app.
function situacionClinicaParaIA() {
  const s = situacionActual();
  if (!LIMITES || !s || !LIMITES.situaciones[s]) return { declarada: false };
  const cfg = LIMITES.situaciones[s];
  return { declarada: true, etiqueta: cfg.etiqueta, consideracion: cfg.consideracion };
}

async function generarRecetaIA() {
  const ingredientes = candidatosParaIA();
  if (ingredientes.length === 0) {
    setRefrigeradorStatus("Identifica o marca al menos un ingrediente antes de generar una receta.", true);
    return;
  }
  // Esta feature vive de la situación clínica del paciente — sin etapa ERC ni
  // modalidad de diálisis declarada no hay nada que ajustar de verdad, así
  // que no se genera nada hasta que la complete (no es solo una invitación).
  if (!situacionClinicaParaIA().declarada) {
    setRefrigeradorStatus("Antes de generar una receta, declara tu etapa de enfermedad renal o si estás en diálisis en \"Tus datos clínicos\".", true);
    return;
  }

  els.refrigeradorGenerarBtn.disabled = true;
  els.refrigeradorRecetaIa.hidden = true;
  setRefrigeradorStatus("Generando una receta a tu medida…", false, true);

  try {
    const res = await fetch(`${API_BASE}/api/generar-receta`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
      body: JSON.stringify({
        ingredientes,
        presupuesto: presupuestoRestanteHoy(),
        densidad_maxima: densidadMaximaSinMeta(),
        situacion_clinica: situacionClinicaParaIA(),
        riesgo_hiperkalemia: riesgoHiperkalemia(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");
    setRefrigeradorStatus("");
    renderRecetaIA(data);
  } catch (err) {
    setRefrigeradorStatus(err.message, true);
  } finally {
    els.refrigeradorGenerarBtn.disabled = false;
  }
}

// El semáforo de la receta generada usa SIEMPRE los totales que devolvió el
// backend (sumados desde nutrientes.json), nunca un número que la IA haya
// calculado por su cuenta — mismo criterio que el resto de la app.
function renderRecetaIA(receta) {
  els.refrigeradorRecetaIa.hidden = false;
  recetaActualIA = receta;
  const densidad100g = (n) => (receta.total_gramos > 0 ? (receta.totales[n] / receta.total_gramos) * 100 : 0);
  const valorPorcion = (n) => Math.round(receta.totales[n] || 0);
  const semaforo = nutrientesVisibles()
    .map((n) => badge(n, valorPorcion(n), densidad100g(n)))
    .join("");

  // El consejo de la IA solo se muestra si el semáforo REAL (recalculado con
  // datos auditados, no lo que haya dicho la IA) efectivamente marca medio o
  // alto en algo — evita mostrar una sugerencia de mejora cuando en realidad
  // todo ya está bien.
  const algoElevado = nutrientesVisibles().some(
    (n) => ["amarillo", "rojo"].includes(clasificar(n, valorPorcion(n), densidad100g(n)).nivel)
  );
  const consejoHtml = receta.consejo && algoElevado
    ? `<div class="receta-consejo"><span aria-hidden="true">💡</span><span><strong>Consejo:</strong> ${escapeHtml(receta.consejo)}</span></div>`
    : "";

  const pasos = (receta.pasos || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");
  const ingredientesHtml = (receta.ingredientes || [])
    .map((i) => `<li>${escapeHtml(i.nombre)} — ${i.gramos} g</li>`)
    .join("");

  els.refrigeradorRecetaIa.innerHTML = `
    <div class="food-result">
      <div class="food-result-header"><h3>${escapeHtml(receta.nombre)}</h3></div>
      <p class="portion-note">Porción total: ${receta.total_gramos} g</p>
      <ul class="refrigerador-receta-lista">${ingredientesHtml}</ul>
      <div class="semaforo-row">${semaforo}</div>
      ${notaSinMeta()}
      ${consejoHtml}
      <ol class="refrigerador-receta-lista">${pasos}</ol>
      <button id="receta-ia-guardar-btn" class="btn btn-secondary btn-guardar-receta">Guardar receta</button>
    </div>`;
  document.getElementById("receta-ia-guardar-btn").addEventListener("click", guardarRecetaIA);
}

// --- Recetas guardadas por el paciente (localStorage, solo en este dispositivo) ---
const RECETAS_GUARDADAS_STORAGE_KEY = "kidneyChefRecetasGuardadas";

function loadRecetasGuardadas() {
  try {
    return JSON.parse(localStorage.getItem(RECETAS_GUARDADAS_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function guardarRecetaIA() {
  if (!recetaActualIA) return;
  const arr = loadRecetasGuardadas();
  arr.unshift({ ...recetaActualIA, guardadaEn: new Date().toISOString() });
  localStorage.setItem(RECETAS_GUARDADAS_STORAGE_KEY, JSON.stringify(arr));
  renderRecetasGuardadas();

  const btn = document.getElementById("receta-ia-guardar-btn");
  if (btn) {
    btn.textContent = "Receta guardada ✓";
    btn.classList.add("guardada");
    btn.disabled = true;
  }
}

function eliminarRecetaGuardada(idx) {
  const arr = loadRecetasGuardadas();
  arr.splice(idx, 1);
  localStorage.setItem(RECETAS_GUARDADAS_STORAGE_KEY, JSON.stringify(arr));
  renderRecetasGuardadas();
}

function renderRecetasGuardadas() {
  const arr = loadRecetasGuardadas();
  els.recetasGuardadasWrap.hidden = arr.length === 0;
  if (arr.length === 0) return;

  els.recetasGuardadasList.innerHTML = arr
    .map((r, idx) => {
      const fecha = new Date(r.guardadaEn).toLocaleDateString("es-CL", { day: "numeric", month: "short" });
      return `
        <div class="receta-guardada-item">
          <span>${escapeHtml(r.nombre)}<span class="receta-guardada-fecha">Guardada el ${fecha}</span></span>
          <button class="super-item-quitar" id="receta-guardada-quitar-${idx}" aria-label="Eliminar receta guardada">✕</button>
        </div>`;
    })
    .join("");

  arr.forEach((_, idx) => {
    document.getElementById(`receta-guardada-quitar-${idx}`).addEventListener("click", () => eliminarRecetaGuardada(idx));
  });
}

// --- Calculadora de consumo diario (K, P, Na, carbohidratos, líquidos) ---
// El total acumulado del día se compara contra la meta DIARIA completa, no
// contra el umbral de una porción (con dos o tres comidas eso siempre
// marcaba rojo). Barra verde hasta 80% de la meta, ámbar de 80% a 100%,
// roja al superarla. Potasio y fósforo muestran barra cuando el equipo
// tratante fijó una meta personal (Plan Clínico) O cuando aplica la meta
// automática por etapa de ERC (metaPorDefectoDesdeEtapa); si ninguna de las
// dos corresponde, se muestra el total sin inventar un límite que la app no
// conoce realmente.
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
