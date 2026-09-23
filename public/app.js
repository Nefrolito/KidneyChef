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
// agrupar los 6 productos (gold/platinum/diamond x mensual/anual) en el
// grupo de suscripciones de cada tienda, crear ahí los 3 entitlements de
// abajo, y completar las dos API keys públicas de RevenueCat (una por
// plataforma — son públicas, igual que APP_KEY o las keys de Supabase en
// tratante/config.js). Con la de la plataforma vacía, initRevenueCat() no
// hace nada y la app usa el contador local de prueba, como la demo web.
const REVENUECAT_API_KEY_IOS = "appl_CqmSDZNWUZxeKLOQgWQGsaITuRr";
const REVENUECAT_API_KEY_ANDROID = "";

// De mayor a menor nivel — deben coincidir con los entitlements creados en
// RevenueCat. Cada producto otorga solo su propio entitlement (no son
// acumulativos), así que como los 3 niveles viven en el mismo grupo de
// suscripciones de la tienda, solo uno puede estar activo a la vez; por eso
// sincronizarSuscripcionRevenueCat() recorre esta lista de mayor a menor y
// se queda con el primero activo.
const NIVELES_SUSCRIPCION = ["diamond", "platinum", "gold"];
const RANGO_NIVEL = { gold: 1, platinum: 2, diamond: 3 };

// Pestañas que exigen un nivel; las que no aparecen acá son de todos. Se
// restringe la pestaña completa porque todo lo que vive en ella es de ese
// nivel para arriba (y lo de Diamond que hay adentro se restringe aparte).
// Tratante tiene su propia regla, con estado en pausa: ver modoTratante().
const NIVEL_MINIMO_TAB = { refrigerador: "platinum", supermercado: "platinum" };

// Copy y precios de referencia para el selector de niveles del paywall. Los
// precios se usan solo si los productos de la tienda no alcanzan a cargar (y
// en la demo web); deben coincidir con los de App Store Connect / Google Play.
const NIVELES_INFO = {
  gold: {
    nombre: "Gold",
    precioMensualClp: 5990,
    precioAnualClp: 49990,
    // Gold no incluye el equipo tratante: es de Platinum para arriba (ver
    // NIVEL_MINIMO_TRATANTE y featuresDeNivel()).
    features: [
      "Semáforo de sodio, potasio, fósforo y carbohidratos",
      "Así va tu día: metas diarias, registro por foto e historial",
    ],
  },
  platinum: {
    nombre: "Platinum",
    precioMensualClp: 7990,
    precioAnualClp: 69990,
    features: [
      "Todo lo de Gold",
      "Recetas generadas con IA desde fotos de tu refrigerador",
      "Pestaña Súper: cortes reales y precios de supermercados",
    ],
  },
  diamond: {
    nombre: "Diamond",
    precioMensualClp: 9990,
    precioAnualClp: 89990,
    // Antes decía "Integración con Cookidoo (próximamente)". Se cambió por lo
    // que la app hace de verdad: Cookidoo no tiene API pública ni permite
    // importar recetas desde fuera, así que una "integración" era una promesa
    // que no se podía cumplir — y vender un nivel por una función futura es
    // motivo de rechazo en la App Store.
    features: [
      "Todo lo de Platinum",
      "Modo robot de cocina: cada receta con la velocidad, temperatura y tiempo de tu máquina",
      "Compatible con Thermomix, Cecotec Mambo, MyCook, Monsieur Cuisine y otros",
      "Revisa cualquier receta que encuentres: semáforo, alarma y qué cambiar para bajarla",
    ],
  },
};

// Lo que se sabe de la tienda en esta sesión de la app nativa. `listo` pasa a
// true cuando RevenueCat respondió (o falló) por primera vez: antes de eso no
// se muestra el paywall, para no mostrárselo un instante a quien sí paga.
const tienda = {
  listo: false,
  error: false,
  appUserId: null,
  productos: {}, // id de producto → StoreProduct (precio y prueba reales)
  elegibleParaPrueba: {}, // id de producto → true si la tienda le da la prueba gratis
};

// Clave pública de RevenueCat de esta plataforma, o "" en el navegador. Con
// clave, el nivel y la prueba salen de la tienda; sin clave (la demo web) se
// usa el contador local de TRIAL_DIAS.
function apiKeyRevenueCat() {
  if (!esAppNativa()) return "";
  const platform = window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : null;
  return platform === "ios" ? REVENUECAT_API_KEY_IOS : REVENUECAT_API_KEY_ANDROID;
}

async function initRevenueCat() {
  const apiKey = apiKeyRevenueCat();
  if (!apiKey) return;
  const Purchases = window.Capacitor.Plugins.Purchases;
  try {
    await Purchases.configure({ apiKey });
    // ID anónimo de esta instalación. Viaja al servidor en cada llamada
    // (X-RevenueCat-Id) para que compruebe el nivel por su cuenta.
    ({ appUserID: tienda.appUserId } = await Purchases.getAppUserID());
    // Renovaciones, cancelaciones que vencen o compras hechas en otro equipo
    // llegan solas, sin que el paciente tenga que reabrir la app.
    await Purchases.addCustomerInfoUpdateListener(aplicarCustomerInfo);
  } catch (e) {
    console.warn("No se pudo inicializar RevenueCat", e);
    tienda.listo = true;
    tienda.error = true;
    renderSuscripcion();
    return;
  }
  await Promise.all([sincronizarSuscripcionRevenueCat(), cargarProductosTienda()]);
}

// Precios y prueba gratis tal como los tiene la tienda, para mostrar en el
// paywall lo que de verdad se va a cobrar. Si no cargan, el paywall usa los
// precios de referencia de NIVELES_INFO y no promete ninguna prueba.
async function cargarProductosTienda() {
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { current } = await Purchases.getOfferings();
    for (const pkg of current?.availablePackages || []) {
      if (pkg.product?.identifier) tienda.productos[pkg.product.identifier] = pkg.product;
    }
    const ids = Object.keys(tienda.productos);
    if (ids.length) {
      // Apple da la prueba una sola vez por grupo de suscripciones: quien ya
      // la usó no puede ver "1 mes gratis", porque se le cobraría al tiro.
      const eleg = await Purchases.checkTrialOrIntroductoryPriceEligibility({ productIdentifiers: ids });
      for (const id of ids) {
        tienda.elegibleParaPrueba[id] = eleg?.[id]?.status === 2; // INTRO_ELIGIBILITY_STATUS_ELIGIBLE
      }
    }
  } catch (e) {
    console.warn("No se pudieron cargar los productos de la tienda", e);
  }
  renderSuscripcion();
}

// Nivel y periodo elegidos en el selector del paywall — ver renderPaywallNiveles().
let paywallNivelSeleccionado = "platinum";
let paywallPeriodoSeleccionado = "mensual"; // "mensual" | "anual"

// Product ID real en App Store Connect / Google Play (com.kidneychef.app.<nivel>
// mensual, .<nivel>.annual anual).
function productIdPara(nivel, periodo) {
  return `com.kidneychef.app.${periodo === "anual" ? `${nivel}.annual` : nivel}`;
}

function productIdSeleccionado() {
  return productIdPara(paywallNivelSeleccionado, paywallPeriodoSeleccionado);
}

// "$7.990/mes": el precio de la tienda si cargó, si no el de referencia.
function precioDeProducto(productId) {
  const anual = productId.endsWith(".annual");
  const nivel = productId.replace("com.kidneychef.app.", "").replace(".annual", "");
  const info = NIVELES_INFO[nivel];
  const referencia = info ? `$${(anual ? info.precioAnualClp : info.precioMensualClp).toLocaleString("es-CL")}` : "";
  return `${tienda.productos[productId]?.priceString || referencia}${anual ? "/año" : "/mes"}`;
}

const UNIDADES_PERIODO = {
  DAY: ["día", "días"],
  WEEK: ["semana", "semanas"],
  MONTH: ["mes", "meses"],
  YEAR: ["año", "años"],
};

// "1 mes" si este producto trae prueba gratis y esta cuenta todavía puede
// usarla; null en cualquier otro caso (incluido cuando no se sabe).
function pruebaGratisDe(productId) {
  const intro = tienda.productos[productId]?.introPrice;
  if (!tienda.elegibleParaPrueba[productId] || !intro || intro.price !== 0) return null;
  const n = intro.periodNumberOfUnits || 1;
  const [uno, varios] = UNIDADES_PERIODO[intro.periodUnit] || UNIDADES_PERIODO.MONTH;
  return `${n} ${n === 1 ? uno : varios}`;
}

function fechaLarga(iso) {
  return new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "long" });
}

// Dispara la compra real a través de RevenueCat.
//
// Cualquier salida que no sea la compra hecha tiene que decir qué pasó y, sobre
// todo, que no se cobró nada. Antes los tres finales distintos —no hay tienda,
// la offering no trae el producto, la llamada falló— terminaban en el mismo
// "estará disponible muy pronto", que para App Review es una compra rota y para
// el paciente es un botón que no hace nada.
async function comprarSuscripcion() {
  els.paywallMsg.hidden = false;
  if (!apiKeyRevenueCat()) {
    els.paywallMsg.textContent = "Las suscripciones se compran desde la app de iPhone o Android, no desde el navegador.";
    return;
  }

  els.paywallSuscribirBtn.disabled = true;
  els.paywallMsg.textContent = "Conectando con la tienda…";
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { current } = await Purchases.getOfferings();
    const idProducto = productIdSeleccionado();
    const paquete = current?.availablePackages?.find((pkg) => pkg.product?.identifier === idProducto);
    if (!paquete) {
      // Falta configurar el producto en RevenueCat o todavía no lo aprueba la
      // tienda. No es culpa del paciente y no se le cobró nada.
      els.paywallMsg.textContent = "Ese plan no está disponible en la tienda en este momento. No se te cobró nada. Prueba con otro plan o inténtalo más tarde.";
      return;
    }
    const conPrueba = pruebaGratisDe(idProducto);
    const { customerInfo } = await Purchases.purchasePackage({ aPackage: paquete });
    // Si se compró desde "Ver planes", el paywall ya cumplió su función.
    paywallModoConsulta = false;
    aplicarCustomerInfo(customerInfo);
    els.paywallMsg.textContent = conPrueba
      ? `¡Listo! Empezó tu prueba gratis de ${conPrueba}.`
      : "¡Listo! Tu suscripción quedó activa.";
  } catch (e) {
    // Que el paciente cierre la hoja de compra de Apple no es un error: ya sabe
    // lo que hizo, y mostrarle una alarma sería confundirlo.
    if (e && (e.code === "1" || e.userCancelled || e.message?.includes("cancel"))) {
      els.paywallMsg.hidden = true;
      els.paywallMsg.textContent = "";
    } else {
      console.warn("No se pudo completar la compra de la suscripción", e);
      els.paywallMsg.textContent = "No se pudo completar la compra. No se te cobró nada. Revisa tu conexión e inténtalo de nuevo.";
    }
  } finally {
    els.paywallSuscribirBtn.disabled = false;
  }
}

// Restaurar compras. Apple lo exige (guía 3.1.1) para que alguien que cambia
// de teléfono, reinstala, o ya pagó en otro dispositivo con el mismo Apple ID
// recupere su suscripción sin volver a pagar. Sin este botón el binario se
// rechaza, aunque la compra funcione perfecto.
async function restaurarCompras() {
  els.paywallMsg.hidden = false;
  if (!apiKeyRevenueCat()) {
    els.paywallMsg.textContent = "Las compras se restauran desde la app de iPhone o Android, no desde el navegador.";
    return;
  }
  els.paywallMsg.textContent = "Buscando tus compras anteriores…";
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { customerInfo } = await Purchases.restorePurchases();
    aplicarCustomerInfo(customerInfo);
    const nivel = ensurePerfil().suscripcion.nivel;
    els.paywallMsg.textContent = nivel
      ? `Listo: restauramos tu suscripción ${NIVELES_INFO[nivel].nombre}.`
      : "No encontramos ninguna suscripción activa en esta cuenta.";
  } catch (e) {
    console.warn("No se pudo restaurar la compra", e);
    els.paywallMsg.textContent = "No pudimos restaurar tus compras. Inténtalo de nuevo en un momento.";
  }
}

// Refleja en perfil.suscripcion lo que dice RevenueCat: el nivel más alto
// entre los activos (o null), y si está en la prueba gratis, hasta cuándo y si
// se va a renovar. Se guarda en localStorage para que el siguiente arranque
// no dependa de que RevenueCat ya haya respondido. La prueba gratis de la
// tienda activa el entitlement del nivel elegido, así que quien prueba Gold
// ve Gold, igual que el servidor.
function aplicarCustomerInfo(customerInfo) {
  const activos = customerInfo?.entitlements?.active || {};
  const nivel = NIVELES_SUSCRIPCION.find((id) => Boolean(activos[id])) || null;
  const ent = nivel ? activos[nivel] : null;
  const perfil = ensurePerfil();
  perfil.suscripcion = {
    nivel,
    enPrueba: ent?.periodType === "TRIAL",
    vence: ent?.expirationDate || null,
    seRenueva: ent ? ent.willRenew !== false : false,
    producto: ent?.productIdentifier || null,
  };
  guardarPerfil(perfil);
  tienda.listo = true;
  tienda.error = false;
  renderSuscripcion();
  renderPlan();
  // Las funciones de cada nivel tienen que aparecer (o desaparecer) sin que el
  // paciente reinicie la app cuando el nivel acaba de cambiar.
  renderRobotSelector();
  renderRevisarReceta();
  renderTabsPorNivel();
}

async function sincronizarSuscripcionRevenueCat() {
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { customerInfo } = await Purchases.getCustomerInfo();
    aplicarCustomerInfo(customerInfo);
  } catch (e) {
    // Sin conexión con la tienda se sigue con el último nivel guardado; quien
    // no tenía ninguno ve el paywall con el aviso de que no hubo conexión.
    console.warn("No se pudo sincronizar el estado de suscripción de RevenueCat", e);
    tienda.listo = true;
    tienda.error = true;
    renderSuscripcion();
  }
}

// true si el nivel activo alcanza el mínimo pedido. En la app nativa la
// prueba gratis ya viene como nivel (el que eligió el paciente); solo la
// demo web, sin compras, abre todo durante su mes de prueba local.
function nivelSuficiente(minimo) {
  const estado = estadoSuscripcion();
  if (!estado.conTienda && estado.enTrial) return true;
  const nivel = ensurePerfil().suscripcion.nivel;
  const rango = nivel ? RANGO_NIVEL[nivel] : 0;
  return rango >= RANGO_NIVEL[minimo];
}

// Headers de toda llamada al backend: la clave de app y, en la app nativa,
// el ID de RevenueCat con el que el servidor comprueba el nivel.
function headersApi(extra = {}) {
  const h = { "X-App-Key": APP_KEY, ...extra };
  if (tienda.appUserId) h["X-RevenueCat-Id"] = tienda.appUserId;
  return h;
}

// Clave compartida con el backend, enviada en cada análisis. No es un secreto:
// viaja en el código del cliente y alguien técnico puede extraerla. Sirve para
// que quien descubra la URL del backend no pueda usarlo directamente. Debe
// coincidir con la variable APP_KEY configurada en el servidor.
const APP_KEY = "Xhw465sJYD8cL1lobmCuebpbJ2EmT6aD";

// Semáforo por PORCIÓN (mg) si limites-clinicos.json no alcanzó a cargar.
// Son las mismas cifras de LIMITES.porcion, cada una con fuente publicada:
// potasio y fósforo según los folletos de la National Kidney Foundation, y
// sodio según la FDA y la NKF. Hasta el 2026-09-14 eran 200/400, 100/200 y
// 140/400 sin fuente; se alinearon tras el rechazo 1.4.1 de Apple.
const UMBRALES = {
  potasio_mg: { verde: 100, amarillo: 200 },
  fosforo_mg: { verde: 50, amarillo: 100 },
  sodio_mg: { verde: 140, amarillo: 239 },
};

const NUTRIENTE_LABEL = {
  potasio_mg: "Potasio",
  fosforo_mg: "Fósforo",
  sodio_mg: "Sodio",
  carbohidratos_g: "Carbohidratos",
  calorias_kcal: "Calorías",
};

const NUTRIENTE_ICON = {
  potasio_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4C10 4 4 10 4 20c10 0 16-6 16-16Z"/><path d="M8.5 15.5 15.5 8.5"/></svg>`,
  fosforo_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><circle cx="6" cy="18" r="2.3"/><circle cx="18" cy="6" r="2.3"/></svg>`,
  sodio_mg: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l1 3H8Z"/><path d="M8 6h8l1.2 12.5A2 2 0 0 1 15.2 21H8.8a2 2 0 0 1-2-2.5L8 6Z"/><circle cx="10.5" cy="11" r="0.4" fill="currentColor"/><circle cx="13.5" cy="11" r="0.4" fill="currentColor"/><circle cx="12" cy="14" r="0.4" fill="currentColor"/></svg>`,
  carbohidratos_g: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c-3 0-5 2-5 4.5S9 12 12 12s5-2 5-4.5S15 3 12 3Z"/><path d="M5 14c2.5-1 4.5-1 7-1s4.5 0 7 1"/><path d="M6 18c2-.8 4-1 6-1s4 .2 6 1"/></svg>`,
  calorias_kcal: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c1 2.5-2 3.5-2 6a2 2 0 0 0 4 0c1 1 1.5 2.3 1.5 3.5a3.5 3.5 0 1 1-7 0C8.5 9 12 7 12 3Z"/></svg>`,
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
    perfil.suscripcion = { nivel: null };
  }
  if (perfil.suscripcion.nivel === undefined) perfil.suscripcion.nivel = null;
  if (perfil.terminos === undefined) {
    perfil.terminos = { version: null, aceptadoEn: null };
  }
  if (perfil.datosPersonales === undefined) {
    perfil.datosPersonales = { nombre: "", fechaNacimiento: null };
  }
  if (perfil.confirmacionClinica === undefined) {
    perfil.confirmacionClinica = { confirmado: false, confirmadoEn: null };
  }
  if (perfil.robotCocina === undefined) perfil.robotCocina = null;
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
const TERMINOS_VERSION = "1.1";

// Versión que muestra "Acerca de KidneyChef". Sirve para saber, con la app
// instalada, si es la compilada ahora o la de la tienda. Hay que subirla a
// mano junto con MARKETING_VERSION/CURRENT_PROJECT_VERSION en Xcode (no se
// lee del bundle: eso exigiría el plugin @capacitor/app, que no está).
const APP_VERSION = "1.2 (8)";

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

  // Encadenar los datos clínicos al alta, saltables. Solo la primera vez: si
  // ya tiene una etapa declarada es que volvió a editar el nombre, y no hay
  // que devolverlo al formulario clínico.
  if (!situacionActual()) abrirEdicionClinica(true);
}

// Tu perfil y Tus antecedentes clínicos viven en una hoja modal aparte (no en
// una pestaña propia): se abre desde el badge de la esquina superior, que
// muestra un lápiz mientras no se ha confirmado nunca, y la etapa ERC corta
// (ej. "3B", "HD") una vez confirmada. Al confirmar se cierra la hoja y se
// vuelve a Hoy; para actualizar la etapa cuando cambien los exámenes se
// vuelve a tocar el badge, y así sucesivamente.
const PENCIL_SVG = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;

function datosClinicosConfirmados() {
  return ensurePerfil().confirmacionClinica.confirmado;
}

function renderEtapaBadge() {
  if (!datosClinicosConfirmados()) {
    els.etapaBadgeBtn.classList.remove("etapa-badge-btn");
    els.etapaBadgeBtn.innerHTML = PENCIL_SVG;
    return;
  }
  const datos = datosSelloEtapa();
  els.etapaBadgeBtn.classList.add("etapa-badge-btn");
  els.etapaBadgeBtn.textContent = datos ? datos.valor : "✓";
}

// La hoja clínica se abre de dos maneras: desde el botón del encabezado (uso
// normal) o encadenada al alta, justo después del nombre. En el segundo caso
// muestra una explicación y un "Ahora no": pedir etapa renal, diálisis y
// antecedentes como muro obligatorio antes de dejar ver la app espantaría a
// quien viene a probarla — y el revisor de Apple es exactamente ese caso.
// Quien los completa entra con sus anillos funcionando desde el primer minuto.
function abrirEdicionClinica(modoAlta = false) {
  els.editarClinicoOverlay.hidden = false;
  if (els.onboardingClinico) els.onboardingClinico.hidden = !modoAlta;
  els.editarClinicoOverlay.scrollTop = 0;
}

function cerrarEdicionClinica() {
  els.editarClinicoOverlay.hidden = true;
  if (els.onboardingClinico) els.onboardingClinico.hidden = true;
}

function confirmarDatosClinicos() {
  const perfil = ensurePerfil();
  perfil.confirmacionClinica = { confirmado: true, confirmadoEn: new Date().toISOString() };
  guardarPerfil(perfil);
  els.editarClinicoOverlay.hidden = true;
  renderEtapaBadge();
  irATab("hoy");
}

// Suscripción. En la app nativa todo sale de la tienda: la prueba gratis es
// una oferta introductoria de la App Store (1 mes en los 6 productos) y sin
// nivel activo la app queda tras el paywall desde que se abre. Antes la prueba
// era un contador local desde perfil.creadoEn, y reinstalar regalaba otro mes.
// La demo web no tiene compras, así que conserva ese contador local de
// TRIAL_DIAS (y el corte global DEMO_HASTA del servidor).
const TRIAL_DIAS = 30;

function estadoSuscripcion() {
  const perfil = ensurePerfil();
  if (apiKeyRevenueCat()) {
    return {
      conTienda: true,
      enTrial: false,
      bloqueado: tienda.listo && !perfil.suscripcion.nivel,
    };
  }
  const diasTranscurridos = Math.floor(
    (Date.now() - new Date(perfil.creadoEn).getTime()) / 86400000
  );
  const diasRestantes = Math.max(0, TRIAL_DIAS - diasTranscurridos);
  const enTrial = diasRestantes > 0;
  const bloqueado = !enTrial && !perfil.suscripcion.nivel;
  return { conTienda: false, diasRestantes, enTrial, bloqueado };
}

// El paywall se abre por dos motivos distintos: porque no hay nivel activo
// (bloqueante, sin salida hasta suscribirse) o porque el paciente tocó "Ver
// planes" (consulta, se cierra con la X).
let paywallModoConsulta = false;

// Sin nivel, el paywall tapa toda la app, pero revocar el vínculo o quitar la
// foto no puede quedar detrás de un pago (Ley 20.584). Con esto el paywall se
// aparta y deja ver solo la pestaña Tratante en pausa, sin barra de pestañas,
// hasta que la persona vuelve a los planes o ya no le queda vínculo abierto.
let gestionTratanteSinPlan = false;

function abrirGestionTratanteSinPlan() {
  gestionTratanteSinPlan = true;
  renderSuscripcion();
  irATab("tratante");
  renderTabTratante();
}

function volverAPlanes() {
  gestionTratanteSinPlan = false;
  irATab("hoy");
  renderTabTratante();
  renderSuscripcion();
}

function abrirPaywallConsulta() {
  paywallModoConsulta = true;
  renderSuscripcion();
}

function cerrarPaywallConsulta() {
  paywallModoConsulta = false;
  renderSuscripcion();
}

// Estado en palabras para la tarjeta "Tu suscripción" de la pestaña Hoy.
function textoEstadoSuscripcion() {
  const estado = estadoSuscripcion();
  const s = ensurePerfil().suscripcion;
  if (s.nivel) {
    const nombre = NIVELES_INFO[s.nivel].nombre;
    if (estado.conTienda && s.vence) {
      const fecha = fechaLarga(s.vence);
      if (s.enPrueba) {
        return s.seRenueva
          ? `Estás en la prueba gratis de ${nombre} hasta el ${fecha}. Después se cobra ${precioDeProducto(s.producto || productIdPara(s.nivel, "mensual"))}, salvo que la canceles antes.`
          : `Estás en la prueba gratis de ${nombre} hasta el ${fecha}. La cancelaste, así que no se te va a cobrar.`;
      }
      if (!s.seRenueva) return `Tienes ${nombre} hasta el ${fecha}. La cancelaste, así que no se va a renovar.`;
    }
    return `Tienes el nivel ${nombre} activo.`;
  }
  if (estado.conTienda) {
    return tienda.listo ? "No tienes una suscripción activa." : "Revisando tu suscripción…";
  }
  if (estado.enTrial) {
    return estado.diasRestantes === 1
      ? "Te queda 1 día de prueba gratis."
      : `Te quedan ${estado.diasRestantes} días de prueba gratis.`;
  }
  return "Tu mes de prueba terminó.";
}

// "Mañana te toca diálisis". El día antes es cuando el potasio lleva más
// tiempo acumulándose —es el intervalo más largo sin dializar— y es justo
// cuando algunos pacientes relajan la dieta pensando que la sesión lo va a
// limpiar. Pedido de Camilo: el texto clínico es suyo, no inventado acá.
function renderAvisoDialisis() {
  if (!els.avisoDialisis) return;
  const d = ensurePerfil().datosClinicos || {};
  const dias = d.diasDialisis || [];
  if (situacionActual() !== "hemodialisis" || dias.length === 0) {
    els.avisoDialisis.hidden = true;
    return;
  }

  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const esManana = dias.includes(manana.getDay());
  const esHoy = dias.includes(new Date().getDay());

  if (!esManana && !esHoy) {
    els.avisoDialisis.hidden = true;
    return;
  }

  els.avisoDialisis.hidden = false;
  els.avisoDialisis.innerHTML = esManana
    ? `<h2>Mañana te toca diálisis</h2>
       <p class="clinical-note">Hoy es el día en que llevas más tiempo sin dializar, así que
         es cuando más se te acumula el potasio. No aflojes la dieta pensando que la sesión
         de mañana lo compensa: el riesgo está antes de dializar, no después.</p>
       <p class="fuente-dato">Fuente: ${enlaceFuente("bem_2021")}</p>`
    : `<h2>Hoy te toca diálisis</h2>
       <p class="clinical-note">Después de la sesión sigue cuidando el potasio y los
         líquidos: lo que comes hoy ya cuenta para el próximo intervalo.</p>`;
}

function renderSuscripcion() {
  const estado = estadoSuscripcion();
  const { bloqueado } = estado;
  const mostrar = (bloqueado && !gestionTratanteSinPlan) || paywallModoConsulta;

  els.paywallOverlay.hidden = !mostrar;
  els.paywallTratanteBtn.hidden = !(bloqueado && modoTratante() === "congelado");
  // Sin nivel activo no hay X: la app queda bloqueada hasta que haya
  // suscripción. En modo consulta sí se puede salir.
  els.paywallCerrarBtn.hidden = bloqueado;
  if (estado.conTienda) {
    const prueba = pruebaGratisDe(productIdSeleccionado());
    els.paywallTitulo.textContent = bloqueado ? "Elige tu nivel de KidneyChef" : "Los planes de KidneyChef";
    els.paywallBajada.textContent = bloqueado && tienda.error
      ? "No pudimos conectar con la tienda. Revisa tu conexión; si ya tienes una suscripción, toca Restaurar compras."
      : ensurePerfil().suscripcion.nivel
        ? "Puedes cambiar de nivel cuando quieras; la tienda ajusta el cobro."
        : prueba
          ? `Cada nivel parte con ${prueba} gratis. Si la cancelas antes de que termine, no se te cobra nada.`
          : "Elige el nivel de KidneyChef que se ajuste a lo que necesitas.";
  } else {
    els.paywallTitulo.textContent = bloqueado ? "Tu mes de prueba terminó" : "Los planes de KidneyChef";
    els.paywallBajada.textContent = bloqueado
      ? "Elige el nivel de KidneyChef que se ajuste a lo que necesitas."
      : "Puedes suscribirte cuando quieras: tu mes de prueba sigue corriendo igual.";
  }
  if (mostrar) renderPaywallNiveles();

  els.suscripcionEstado.textContent = textoEstadoSuscripcion();

  // El consejo del día se esconde tras el paywall; lo decide renderBanner().
  renderBanner();
}

// Dibuja el toggle mensual/anual y las 3 tarjetas de nivel del paywall según
// paywallNivelSeleccionado / paywallPeriodoSeleccionado, y actualiza el botón
// de suscribirse con el nivel y precio elegidos. Apple exige que el monto que
// se va a cobrar sea el precio más visible, también cuando hay prueba gratis:
// por eso el precio grande de la tarjeta no cambia y la prueba va en el botón.
function renderPaywallNiveles() {
  els.paywallPeriodoToggle.querySelectorAll(".paywall-periodo-btn").forEach((btn) => {
    const activo = btn.dataset.periodo === paywallPeriodoSeleccionado;
    btn.classList.toggle("activo", activo);
    btn.setAttribute("aria-pressed", String(activo));
  });

  els.paywallNiveles.innerHTML = Object.entries(NIVELES_INFO)
    .map(([id, info]) => {
      const [monto, sufijo] = precioDeProducto(productIdPara(id, paywallPeriodoSeleccionado)).split("/");
      const seleccionado = id === paywallNivelSeleccionado;
      return `
        <button type="button" class="paywall-nivel${seleccionado ? " seleccionado" : ""}" data-nivel="${id}" aria-pressed="${seleccionado}">
          ${id === "platinum" ? '<span class="paywall-nivel-badge">Recomendado</span>' : ""}
          <span class="paywall-nivel-nombre">${info.nombre}</span>
          <span class="paywall-nivel-precio">${escapeHtml(monto)}<small>/${sufijo}</small></span>
          <ul class="paywall-nivel-features">${featuresDeNivel(id).map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
        </button>
      `;
    })
    .join("");

  const idProducto = productIdSeleccionado();
  const nombre = NIVELES_INFO[paywallNivelSeleccionado].nombre;
  const precio = precioDeProducto(idProducto);
  const prueba = ensurePerfil().suscripcion.nivel ? null : pruebaGratisDe(idProducto);
  els.paywallSuscribirBtn.textContent = prueba
    ? `Probar ${nombre} ${prueba} gratis`
    : `Suscribirme a ${nombre} — ${precio}`;
  els.paywallDetallePrecio.hidden = !prueba;
  els.paywallDetallePrecio.textContent = prueba
    ? `${prueba} gratis, después ${precio}. Se renueva sola hasta que la canceles.`
    : "";
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
    diasDialisis: [],
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

// Metas que puede fijar el equipo tratante, con el nombre y la unidad que ve
// el paciente. Es el espejo de METAS_TRATANTE en server.py: si se agrega una
// allá, va también acá. Todas priman sobre los valores de referencia.
const METAS_TRATANTE = {
  sodio_mg: { etiqueta: "Sodio", unidad: "mg" },
  potasio_mg: { etiqueta: "Potasio", unidad: "mg" },
  fosforo_mg: { etiqueta: "Fósforo", unidad: "mg" },
  carbohidratos_g: { etiqueta: "Carbohidratos", unidad: "g" },
  calorias_kcal: { etiqueta: "Calorías", unidad: "kcal" },
  liquidos_ml: { etiqueta: "Líquidos", unidad: "ml" },
};

// --- Modelo clínico (KDIGO/KDOQI) ---------------------------------------
// Cargado desde limites-clinicos.json. Mientras no esté cargado, la app cae
// a los umbrales fijos de UMBRALES, así que nunca queda sin semáforo.
let LIMITES = null;

// ¿El paciente tiene factores de riesgo de hiperkalemia? La diabetes y los
// fármacos que bloquean el SRAA lo son (Hunter y Bailey, 2019). Ya no cambian
// ninguna cifra: la meta de 1500 mg y los cortes estrictos no tenían fuente
// publicada y se quitaron el 2026-09-14. Solo se le avisa a la IA.
function riesgoHiperkalemia() {
  const d = ensurePerfil().datosClinicos || {};
  return !!(d.diabetes || d.farmacosRetenedoresK);
}

// Meta fijada por el equipo tratante para ese nombre, o null. Solo cuenta en
// el Plan Clínico, que es donde existe el vínculo con el tratante.
function metaPropia(nombre) {
  const perfil = ensurePerfil();
  if (!PLANS[perfil.planId].features.umbralesPersonalizados) return null;
  const propias = perfil.metasDiarias || {};
  return propias[nombre] != null ? propias[nombre] : null;
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
  // Carbohidratos no tienen meta automática: la ADA dice que no hay una cifra
  // única, así que solo cuenta la que fije el equipo tratante (arriba).
  if (nutriente === "carbohidratos_g") return null;
  if (nutriente === "potasio_mg") return metaPorDefectoDesdeEtapa(LIMITES.potasio);
  if (nutriente === "fosforo_mg") return metaPorDefectoDesdeEtapa(LIMITES.fosforo);
  if (nutriente === "calorias_kcal") {
    // Solo en diálisis, y solo si ya hay un peso registrado hoy: la meta se
    // deriva del peso (kcal/kg), no es un número fijo. Ver LIMITES.calorias.
    if (!requiereDiuresis()) return null;
    const peso = pesoDeHoy();
    if (!peso) return null;
    return Math.round(peso.kg * LIMITES.calorias.kcal_por_kg_dia_por_defecto);
  }
  return null;
}

// Meta automática de K/P desde ciertas etapas de ERC
// (config.etapas_aplicables en limites-clinicos.json), salvo que el tratante
// haya fijado una propia. Potasio 2000 mg y fósforo 1000 mg al día, con sus
// fuentes en config.fuente. No se gradúa por etapa porque ninguna de esas
// fuentes gradúa.
//
// Hasta el 2026-09-14 el riesgo de hiperkalemia (diabetes o fármacos) bajaba
// la meta de potasio a 1500 mg. Esa cifra no tenía fuente publicada y se quitó:
// ese caso queda para que lo individualice el tratante.
function metaPorDefectoDesdeEtapa(config) {
  if (!config) return null;
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
  if (!LIMITES) return null;
  // La meta que fija el tratante prima, y vale aunque el paciente no esté en
  // diálisis: es una indicación suya, no un valor de referencia de la app.
  const propia = metaPropia("liquidos_ml");
  if (propia != null) return { ml: propia, esSupuesto: false };
  if (!requiereDiuresis()) return null;
  // La fórmula publicada es para hemodiálisis. En peritoneal no hay una cifra
  // con fuente: se registra lo que toma, sin meta, hasta que la fije el tratante.
  const aplica = LIMITES.liquidos.situaciones_aplicables || [];
  if (!aplica.includes(situacionActual())) return null;
  const raw = ensurePerfil().datosClinicos.diuresisMl;
  const esSupuesto = raw === null || raw === undefined || raw === "";
  const diuresis = esSupuesto ? LIMITES.liquidos.sin_dato.asumir_diuresis_ml : Number(raw);
  return { ml: diuresis + LIMITES.liquidos.margen_ml, esSupuesto };
}

// Peso corporal diario: solo se pide en diálisis (mismo gate que líquidos,
// requiereDiuresis()). Un registro por día, no acumulable como los líquidos —
// registrar un peso nuevo hoy reemplaza al de hoy, no lo suma. Sirve para (1)
// vigilar la ganancia de peso entre sesiones de diálisis (indicador indirecto
// de sobrecarga de líquido) y (2) alimentar la meta de calorías por kg.
const PESO_STORAGE_KEY = "kidneyChefPeso";

function loadPesos() {
  try {
    return JSON.parse(localStorage.getItem(PESO_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function pesoDeHoy() {
  return loadPesos().find((p) => isToday(p.fecha)) || null;
}

// El registro más reciente que NO sea de hoy: la referencia para calcular la
// ganancia interdialítica. loadPesos() ya viene de más nuevo a más viejo
// porque registrarPeso() usa unshift().
function pesoAnterior() {
  return loadPesos().find((p) => !isToday(p.fecha)) || null;
}

function registrarPeso(kg) {
  const arr = loadPesos().filter((p) => !isToday(p.fecha));
  arr.unshift({ kg, fecha: new Date().toISOString() });
  localStorage.setItem(PESO_STORAGE_KEY, JSON.stringify(arr));
}

// Días entre el peso anterior y el de hoy, contados por fecha de calendario.
function diasEntrePesos() {
  const hoy = pesoDeHoy();
  const anterior = pesoAnterior();
  if (!hoy || !anterior) return null;
  const inicio = new Date(anterior.fecha);
  inicio.setHours(0, 0, 0, 0);
  const fin = new Date(hoy.fecha);
  fin.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((fin - inicio) / 86400000));
}

// Cuánto se tolera ganar desde el registro anterior: 1 kg por cada día entre
// ambos pesos, según la National Kidney Foundation ("no más de 1 kg por día
// entre sesiones"). Hasta el 2026-09-14 eran 1 kg entre semana y 2 kg en el
// intervalo largo, sin fuente publicada y más estricto que la NKF.
function gananciaMaximaKg() {
  if (!LIMITES || !LIMITES.peso) return null;
  const dias = diasEntrePesos();
  if (dias == null) return null;
  return Math.round(LIMITES.peso.ganancia_maxima_kg_por_dia * dias * 10) / 10;
}

// Ganancia de peso interdialítica (kg), o null si no hay un peso anterior
// con qué comparar todavía (primer registro).
function gananciaPeso() {
  const hoy = pesoDeHoy();
  const anterior = pesoAnterior();
  if (!hoy || !anterior) return null;
  return Math.round((hoy.kg - anterior.kg) * 10) / 10;
}

// Nivel según cortes publicados { verde, amarillo }, inclusivos. Sin corte
// amarillo (sodio por 100 g no tiene un "alto" publicado) nunca llega a rojo.
function nivelSegunCortes(valor, t) {
  const v = Math.round(valor);
  if (v <= t.verde) return "verde";
  if (t.amarillo == null || v <= t.amarillo) return "amarillo";
  return "rojo";
}

// Clasifica un nutriente por su CONTENIDO, con cortes publicados (ver las
// fuentes en limites-clinicos.json). No afirma que el paciente se pasó de su
// límite: eso lo mide "Así va tu día" contra la meta diaria.
//   por porción (por defecto) -> mg de la porción contra los cortes de la
//                                National Kidney Foundation y la FDA
//   por100g = true            -> densidad del plato o ingrediente contra la
//                                tabla por 100 g del Hospital del Mar
// Hasta el 2026-09-14 había un modo "meta" que repartía la meta diaria en 4
// comidas para sacar un umbral por porción. Esa regla no tenía fuente y se
// quitó tras el rechazo 1.4.1 de Apple.
function clasificar(nutriente, valorPorcion, densidad100g, por100g = false) {
  if (por100g) {
    const t = LIMITES && LIMITES.plato_por_100g && LIMITES.plato_por_100g[nutriente];
    if (!t || densidad100g == null) return { nivel: null, modo: "ninguno" };
    return { nivel: nivelSegunCortes(densidad100g, t), modo: "contenido" };
  }
  const t = (LIMITES && LIMITES.porcion && LIMITES.porcion[nutriente]) || umbralesActivos()[nutriente];
  if (!t || valorPorcion == null) return { nivel: null, modo: "ninguno" };
  return { nivel: nivelSegunCortes(valorPorcion, t), modo: "contenido" };
}

// El badge y "Acerca de" muestran el nivel de suscripción real (RevenueCat:
// gold/platinum/diamond), no perfil.planId — ese es un campo aparte para el
// toggle manual de Plan Clínico (umbrales personalizados, vínculo tratante),
// sin relación con lo que el usuario efectivamente paga.
function renderPlan() {
  const { enTrial, bloqueado } = estadoSuscripcion();
  const { nivel, enPrueba } = ensurePerfil().suscripcion;
  const nombreNivel = nivel
    ? `${NIVELES_INFO[nivel].nombre}${enPrueba ? " (prueba)" : ""}`
    : enTrial && !bloqueado
      ? "Prueba gratis"
      : "Sin suscripción";
  els.planBadge.textContent = nombreNivel;
  els.aboutPlan.textContent = `Tu plan actual: ${nombreNivel}.`;
  els.aboutVersion.textContent = `KidneyChef ${APP_VERSION}${esAppNativa() ? "" : " · web"}`;
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
  renderDiasDialisis();
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
  // El calendario solo tiene sentido en hemodiálisis: la peritoneal se hace a
  // diario o cada noche, no en días señalados.
  els.campoDiasDialisis.hidden = situacionActual() !== "hemodialisis";
}

const DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function renderDiasDialisis() {
  const seleccionados = ensurePerfil().datosClinicos.diasDialisis || [];
  els.dialisisDias.innerHTML = DIAS_SEMANA
    .map((nombre, i) => `
      <label class="clinical-check">
        <input type="checkbox" class="dialisis-dia" value="${i}" ${seleccionados.includes(i) ? "checked" : ""}>
        <span>${nombre}</span>
      </label>`)
    .join("");
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
    diasDialisis: [...document.querySelectorAll(".dialisis-dia:checked")].map((el) => Number(el.value)),
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
  renderAvisoDialisis();
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
//
// Solo visible en la pestaña "Tratante" (interruptor manual abajo). Queda en
// false para el envío a App Store: el portal del tratante existe y funciona,
// pero su backend (Supabase) está pausado y no hay tratantes reales todavía.
// Ponerlo en true es todo lo que hace falta para volver a probar la pestaña.
const MOSTRAR_TAB_TRATANTE = false;

// El equipo tratante es de Platinum para arriba: Gold no lo trae. Decisión
// de Camilo (2026-09-21). Durante el mes de prueba se ve igual, porque el
// trial da acceso completo (ver nivelSuficiente()).
const NIVEL_MINIMO_TRATANTE = "platinum";

// Vínculos activos o pendientes según la última consulta al servidor (ver
// refrescarVinculos). Decide si alguien sin Platinum ve la pestaña en pausa.
let vinculosAbiertos = 0;

// Tres estados:
// - "completo": Platinum, Diamond o mes de prueba.
// - "congelado": bajó de nivel teniendo un tratante. Decisión de Camilo
//   (2026-09-21): el vínculo queda en pausa en vez de cortarse. No se envía
//   su consumo ni fotos nuevas; las últimas metas del tratante siguen
//   aplicándose, porque volver de golpe a los límites genéricos sería
//   clínicamente peor; y la pestaña sigue visible, reducida, para que pueda
//   revocar: retirar el consentimiento (Ley 20.584) no puede quedar detrás
//   de un pago. Si vuelve a Platinum, retoma donde quedó.
// - "oculto": la pestaña está apagada, o no tiene nivel ni tratante.
function modoTratante() {
  if (!MOSTRAR_TAB_TRATANTE) return "oculto";
  if (nivelSuficiente(NIVEL_MINIMO_TRATANTE)) return "completo";
  return vinculosAbiertos > 0 ? "congelado" : "oculto";
}

function renderTabTratante() {
  const modo = modoTratante();
  const congelado = modo === "congelado";
  els.tabTratanteBtn.hidden = modo === "oculto";
  // En pausa no se ofrece empezar nada nuevo: ni activar el plan, ni el
  // código para vincular a otro tratante.
  els.tratanteIntro.hidden = congelado;
  els.tratanteCongeladoAviso.hidden = !congelado;
  els.activarPlanClinico.closest("label").hidden = congelado;
  els.codigoClienteBloque.hidden = congelado || !ensurePerfil().vinculacion.codigoCliente;
  renderFotoPaciente();
  els.tratanteVolverPlanes.hidden = !gestionTratanteSinPlan;
  // Revocó su último vínculo (o volvió a tener nivel): ya no hay nada que
  // gestionar desde aquí, así que vuelve el paywall o la app normal.
  if (gestionTratanteSinPlan && (modo !== "congelado" || !estadoSuscripcion().bloqueado)) {
    volverAPlanes();
    return;
  }
  // Si la persona está justo en esta pestaña cuando deja de corresponderle,
  // vuelve a Hoy.
  if (modo === "oculto" && els.tabTratanteBtn.getAttribute("aria-selected") === "true") irATab("hoy");
  renderBarraPestanas();
}

// Con una sola pestaña visible (Gold sin equipo tratante) la barra no lleva
// a ningún lado y se ve rota: se esconde y se devuelve el espacio que
// reservaba abajo. Se llama al final de renderTabTratante(), que es lo último
// que cambia la cantidad de pestañas visibles.
function renderBarraPestanas() {
  const visibles = [...els.tabBar.querySelectorAll(".tab-btn")].filter((b) => !b.hidden).length;
  const sinBarra = visibles <= 1 || gestionTratanteSinPlan;
  els.tabBar.hidden = sinBarra;
  document.body.classList.toggle("sin-tab-bar", sinBarra);
}

// Oculta las pestañas que el nivel no incluye y, si la abierta dejó de
// corresponder, vuelve a Hoy. Se llama al iniciar y cada vez que RevenueCat
// informa otro nivel.
function renderTabsPorNivel() {
  for (const tab of Object.keys(NIVEL_MINIMO_TAB)) {
    const btn = els.tabBar.querySelector(`[data-tab-target="${tab}"]`);
    if (btn) btn.hidden = !tabPermitida(tab);
  }
  renderTabTratante();
  const activa = els.tabBar.querySelector('.tab-btn[aria-selected="true"]');
  if (activa && !tabPermitida(activa.dataset.tabTarget)) irATab("hoy");
}

// El renglón del paywall se agrega al dibujar y no en NIVELES_INFO porque
// esa tabla está más arriba en el archivo que MOSTRAR_TAB_TRATANTE, y usar
// la constante antes de declararla rompería la carga de la app. Mientras la
// pestaña siga apagada no se ofrece: vender una función que el usuario no
// puede abrir es motivo de rechazo en la App Store.
const FEATURE_TRATANTE = "Equipo tratante: vincúlate con tu nefrólogo(a) o nutricionista para que ajuste tus metas a distancia";

function featuresDeNivel(id) {
  const base = NIVELES_INFO[id].features;
  // Solo en Platinum: Diamond ya dice "Todo lo de Platinum".
  return MOSTRAR_TAB_TRATANTE && id === NIVEL_MINIMO_TRATANTE ? [...base, FEATURE_TRATANTE] : base;
}

// Sin infraestructura de push, se refresca por polling mientras la app está
// abierta — así una solicitud de vínculo nueva aparece sin que el paciente
// tenga que cerrar y volver a abrir la app.
const VINCULOS_POLL_MS = 60000;

function authHeadersPaciente() {
  const perfil = ensurePerfil();
  const v = perfil.vinculacion || {};
  return headersApi({
    "X-Codigo-Cliente": v.codigoCliente || "",
    "X-Device-Secret": v.deviceSecret || "",
  });
}

function renderVinculacion() {
  const perfil = ensurePerfil();
  els.activarPlanClinico.checked = perfil.planId === "clinico";
  const codigo = perfil.vinculacion && perfil.vinculacion.codigoCliente;
  els.codigoClienteBloque.hidden = !codigo || modoTratante() === "congelado";
  els.codigoClienteValor.textContent = codigo || "—";
  renderQrVinculo(codigo);
}

// El QR lleva la URL del portal con el código adentro: en la consulta, el
// tratante lo escanea con la cámara de su teléfono y el formulario de vínculo
// se abre con el código puesto, sin dictar ocho caracteres. No salta ningún
// paso de permiso: el vínculo nace pendiente y el paciente lo acepta desde
// esta misma pantalla (Ley 20.584).
//
// Se dibuja con la copia local de qrcode-generator (public/vendor/qrcode.js)
// porque la app tiene que funcionar sin conexión.
const PORTAL_TRATANTE_URL = "https://kidneychef-api.onrender.com/tratante/";

function renderQrVinculo(codigo) {
  if (!els.qrVinculo) return;
  if (!codigo || typeof qrcode !== "function") {
    els.qrVinculo.hidden = true;
    els.qrVinculoImagen.innerHTML = "";
    return;
  }
  try {
    const qr = qrcode(0, "M");
    qr.addData(`${PORTAL_TRATANTE_URL}?codigo=${encodeURIComponent(codigo)}`);
    qr.make();
    els.qrVinculoImagen.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    els.qrVinculo.hidden = false;
  } catch (e) {
    // Sin QR el código escrito sigue sirviendo: no vale la pena romper la vista.
    console.warn("No se pudo dibujar el QR de vínculo", e);
    els.qrVinculo.hidden = true;
  }
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
        headers: headersApi({ "Content-Type": "application/json" }),
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
  if (tipo === "nutriologo") return "Tu nutriólogo(a)";
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
    hayVinculoActivo = false;
    vinculosAbiertos = 0;
    renderTabTratante();
    if (els.indicacionesBloque) els.indicacionesBloque.hidden = true;
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/vinculos`, {
      headers: authHeadersPaciente(),
    });
    if (!res.ok) return; // credenciales inválidas o sin conexión: no rompe la app local
    const data = await res.json();
    const vinculos = data.vinculos || [];
    // La foto solo se ofrece con un vínculo activo: el backend la rechaza
    // sin él, y no tiene sentido pedirla si nadie va a verla.
    hayVinculoActivo = vinculos.some((v) => v.estado === "activo");
    vinculosAbiertos = vinculos.filter((v) => v.estado === "activo" || v.estado === "pendiente").length;
    const puedeAceptar = modoTratante() === "completo";

    els.vinculosPendientes.innerHTML = vinculos
      .filter((v) => v.estado === "pendiente")
      .map((v) => `
        <div class="vinculo-item">
          <div class="vinculo-item-texto">
            <strong>${escapeHtml(v.tratante_nombre || "Equipo tratante")}</strong>
            <small>${escapeHtml(tipoTratanteLabel(v.tratante_tipo))} quiere vincularse contigo</small>
          </div>
          <div class="vinculo-item-acciones">
            ${puedeAceptar ? `<button class="btn btn-primary" data-vinculo-aceptar="${v.id}">Aceptar</button>` : ""}
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
    await refrescarFotoPaciente();
    await refrescarIndicaciones();
    renderTabTratante();
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
  if (estado === "activo" && modoTratante() !== "completo") {
    setStatus("Tu plan actual no incluye vincularte con un equipo tratante.", true);
    return;
  }
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
    const fijadas = Object.entries(METAS_TRATANTE)
      .filter(([nombre]) => metas[nombre] != null)
      .map(([nombre, { etiqueta, unidad }]) =>
        `<p class="metas-sincronizadas-fila">${etiqueta}: <strong>${Math.round(metas[nombre])} ${unidad}/día</strong></p>`);
    els.metasSincronizadas.hidden = fijadas.length === 0;
    els.metasSincronizadasLista.innerHTML = fijadas.join("");

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

// --- Foto para el equipo tratante ---------------------------------------
// El portal del tratante muestra a sus pacientes como códigos de ocho
// caracteres. La foto es para que reconozca a quién está mirando; la sube el
// paciente, con una casilla de consentimiento explícita, y la puede quitar
// cuando quiera (eso borra la fila en el servidor, no la marca como borrada).
//
// El backend solo la acepta si ya hay un vínculo activo, así que este bloque
// aparece recién ahí: una foto de la cara es un dato sensible y no tiene por
// qué viajar al servidor mientras no haya un tratante que la vea.
const FOTO_LADO_MAX = 512;
const FOTO_CALIDAD = 0.82;
const ICONO_FOTO_VACIA = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`;

let fotoPacienteActual = null;
let hayVinculoActivo = false;

function estadoFoto(mensaje, esError = false) {
  if (!els.fotoPacienteStatus) return;
  els.fotoPacienteStatus.textContent = mensaje || "";
  els.fotoPacienteStatus.classList.toggle("error", Boolean(esError));
}

// Recorte cuadrado centrado y reescalado a 512 px: el avatar del portal es
// redondo y chico, y así lo que se guarda son decenas de KB en vez de los
// varios MB que entrega la cámara de un teléfono.
async function comprimirFotoPaciente(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const imagen = new Image();
    imagen.onload = () => resolve(imagen);
    imagen.onerror = () => reject(new Error("El archivo no parece ser una imagen"));
    imagen.src = dataUrl;
  });
  const lado = Math.min(img.naturalWidth, img.naturalHeight);
  const destino = Math.min(lado, FOTO_LADO_MAX);
  const canvas = document.createElement("canvas");
  canvas.width = destino;
  canvas.height = destino;
  canvas.getContext("2d").drawImage(
    img,
    (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado,
    0, 0, destino, destino
  );
  return canvas.toDataURL("image/jpeg", FOTO_CALIDAD);
}

function renderFotoPaciente() {
  if (!els.fotoPacienteBloque) return;
  // En pausa solo se puede quitar la foto que ya estaba (retirar el permiso
  // no puede depender del pago), no subir una nueva.
  const congelado = modoTratante() === "congelado";
  els.fotoPacienteBloque.hidden = !hayVinculoActivo || (congelado && !fotoPacienteActual);
  els.fotoPacienteElegir.hidden = congelado;
  els.fotoPacienteVista.innerHTML = fotoPacienteActual
    ? `<img src="${fotoPacienteActual}" alt="">`
    : ICONO_FOTO_VACIA;
  els.fotoPacienteBorrar.hidden = !fotoPacienteActual;
  els.fotoPacienteElegir.textContent = fotoPacienteActual ? "Cambiar foto" : "Elegir foto";
  els.fotoPacienteElegir.disabled = !els.fotoConsentimiento.checked;
}

async function refrescarFotoPaciente() {
  const perfil = ensurePerfil();
  if (!perfil.vinculacion.codigoCliente || !hayVinculoActivo) {
    // Sin vínculo activo el servidor ya borró la foto
    // (_borrar_foto_si_quedo_sin_vinculos), así que tampoco se conserva acá.
    fotoPacienteActual = null;
    renderFotoPaciente();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/foto`, {
      headers: authHeadersPaciente(),
    });
    if (!res.ok) return;
    const data = await res.json();
    fotoPacienteActual = data.foto || null;
    // Que exista una foto guardada significa que en su momento marcó la
    // casilla: se refleja para no pedirle el permiso dos veces.
    if (fotoPacienteActual) els.fotoConsentimiento.checked = true;
    renderFotoPaciente();
  } catch {
    // sin conexión: se reintenta en el próximo refresco
  }
}

async function subirFotoPaciente(file) {
  if (!file) return;
  if (!nivelSuficiente(NIVEL_MINIMO_TRATANTE)) {
    estadoFoto("Tu plan actual no incluye compartir fotos con tu equipo tratante.", true);
    return;
  }
  if (!els.fotoConsentimiento.checked) {
    estadoFoto("Marca la autorización antes de subir la foto.", true);
    return;
  }
  estadoFoto("Preparando la foto…");
  try {
    const imagen = await comprimirFotoPaciente(file);
    const res = await fetch(`${API_BASE}/api/pacientes/me/foto`, {
      method: "PUT",
      headers: { ...authHeadersPaciente(), "Content-Type": "application/json" },
      body: JSON.stringify({ imagen, consentimiento: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "No se pudo guardar la foto");
    fotoPacienteActual = data.foto || imagen;
    renderFotoPaciente();
    estadoFoto("Foto guardada. Tu equipo tratante ya puede verla.");
  } catch (err) {
    estadoFoto(err.message, true);
  }
}

async function borrarFotoPaciente() {
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/foto`, {
      method: "DELETE",
      headers: authHeadersPaciente(),
    });
    if (!res.ok) throw new Error("No se pudo quitar la foto");
    fotoPacienteActual = null;
    renderFotoPaciente();
    estadoFoto("Foto retirada.");
  } catch (err) {
    estadoFoto(err.message, true);
  }
}

// Desmarcar la casilla es retirar el permiso, así que también borra la foto:
// dejarla guardada "sin autorización" sería mentirle al paciente.
async function cambiarConsentimientoFoto() {
  if (!els.fotoConsentimiento.checked && fotoPacienteActual) {
    if (!confirm("Si retiras la autorización se borra la foto que subiste. ¿Continuar?")) {
      els.fotoConsentimiento.checked = true;
      return;
    }
    await borrarFotoPaciente();
  }
  renderFotoPaciente();
}

// --- Exámenes de control indicados por el tratante ----------------------
// NO es una orden médica: no lleva firma electrónica ni identifica al
// establecimiento, y ningún laboratorio la recibe como documento. Es el
// recado que hoy llega por WhatsApp, puesto donde no se pierde. El paciente
// solo acusa recibo ("ya me los hice"); acá no se registran resultados, que
// sería ficha clínica y está deliberadamente fuera de alcance.

// Una fecha suelta (AAAA-MM-DD) la interpreta el navegador como UTC y se
// puede correr un día hacia atrás en Chile: se arma al mediodía local.
function formatFechaSola(iso) {
  if (!iso) return "";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("es-CL", {
    day: "numeric", month: "long", year: "numeric",
  });
}

function renderIndicacion(ind) {
  const items = (ind.examenes || []).map((e) => `<li>${escapeHtml(e.etiqueta)}</li>`);
  if (ind.otros) items.push(`<li>${escapeHtml(ind.otros)}</li>`);
  const cancelada = ind.estado === "cancelada";
  const clases = ["indicacion-item"];
  if (cancelada) clases.push("indicacion-item-cancelada");
  else if (ind.hecha_at) clases.push("indicacion-item-hecha");
  return `
    <div class="${clases.join(" ")}">
      <div class="indicacion-item-cabecera">
        <strong>${escapeHtml(ind.tratante_nombre || "Tu equipo tratante")}</strong>
        <small>${escapeHtml(tipoTratanteLabel(ind.tratante_tipo))} · ${escapeHtml(formatFecha(ind.creada_at))}</small>
      </div>
      ${cancelada ? `<small>Tu equipo tratante canceló esta indicación.</small>` : ""}
      <ul>${items.join("")}</ul>
      ${ind.fecha_sugerida && !cancelada
        ? `<p class="indicacion-item-plazo">Para antes del ${escapeHtml(formatFechaSola(ind.fecha_sugerida))}</p>`
        : ""}
      ${ind.nota ? `<p class="indicacion-item-nota">${escapeHtml(ind.nota)}</p>` : ""}
      ${cancelada ? "" : `
        <div class="indicacion-item-acciones">
          ${ind.hecha_at
            ? `<button class="btn btn-ghost" data-indicacion-deshacer="${ind.id}">Todavía no me los hago</button>`
            : `<button class="btn btn-primary" data-indicacion-hecha="${ind.id}">Ya me los hice</button>`}
        </div>`}
    </div>`;
}

async function refrescarIndicaciones() {
  const perfil = ensurePerfil();
  if (!els.indicacionesBloque) return;
  if (!perfil.vinculacion.codigoCliente) {
    els.indicacionesBloque.hidden = true;
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/indicaciones`, {
      headers: authHeadersPaciente(),
    });
    if (!res.ok) return;
    const data = await res.json();
    const indicaciones = data.indicaciones || [];
    els.indicacionesBloque.hidden = indicaciones.length === 0;
    els.indicacionesLista.innerHTML = indicaciones.map(renderIndicacion).join("");

    els.indicacionesLista.querySelectorAll("[data-indicacion-hecha]").forEach((btn) => {
      btn.addEventListener("click", () =>
        actualizarIndicacion(btn.dataset.indicacionHecha, { hecha: true }));
    });
    els.indicacionesLista.querySelectorAll("[data-indicacion-deshacer]").forEach((btn) => {
      btn.addEventListener("click", () =>
        actualizarIndicacion(btn.dataset.indicacionDeshacer, { hecha: false }));
    });

    // Acuse de recibo: se marcan como vistas las que el paciente acaba de
    // ver en pantalla, para que el tratante sepa si le llegó el recado.
    indicaciones
      .filter((ind) => !ind.vista_at && ind.estado !== "cancelada")
      .forEach((ind) => actualizarIndicacion(ind.id, { vista: true }, false));
  } catch {
    // sin conexión: se reintenta en el próximo refresco
  }
}

async function actualizarIndicacion(id, cambios, refrescar = true) {
  try {
    const res = await fetch(`${API_BASE}/api/pacientes/me/indicaciones/${id}`, {
      method: "PATCH",
      headers: { ...authHeadersPaciente(), "Content-Type": "application/json" },
      body: JSON.stringify(cambios),
    });
    if (!res.ok) return;
    if (refrescar) await refrescarIndicaciones();
  } catch {
    // sin conexión: el estado local no cambia y se reintenta después
  }
}

// Cada consejo lleva la fuente que lo respalda (ids de LIMITES.fuentes), y la
// tarjeta la muestra: Apple exige citas visibles para la información de salud.
const TIPS_DEL_DIA = [
  { texto: "Elegir alimentos frescos y cocinar en casa te ayuda a controlar el sodio.", fuente: "nkf_sodio_web" },
  { texto: "Remojar y hervir las verduras, botando el agua, les quita parte del potasio, aunque no todo.", fuente: "nkf_potasio_web" },
  { texto: "Lee las etiquetas: el sodio se esconde en salsas, conservas, embutidos y comidas procesadas.", fuente: "nkf_sodio_web" },
  { texto: "Lácteos, frutos secos y bebidas cola oscuras son ricos en fósforo; modera sus porciones.", fuente: "nkf_fosforo_web" },
  { texto: "No uses el líquido de frutas o verduras en conserva ni el jugo de la carne cocida: tienen potasio.", fuente: "nkf_potasio_folleto" },
  { texto: "Cocina con hierbas y especias en vez de sal para dar sabor.", fuente: "nkf_sodio_web" },
  { texto: "Revisa siempre el alimento que identifica la app: la confirmación manual evita errores importantes.", fuente: null },
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
  registroPeso: document.getElementById("registro-peso"),
  pesoManual: document.getElementById("peso-manual"),
  pesoGuardarBtn: document.getElementById("peso-guardar-btn"),
  pesoVasoRelleno: document.getElementById("peso-vaso-relleno"),
  pesoDetalle: document.getElementById("peso-detalle"),
  pesoAlerta: document.getElementById("peso-alerta"),
  liquidosDeshacerBtn: document.getElementById("liquidos-deshacer"),
  campoDiuresis: document.getElementById("campo-diuresis"),
  campoDiasDialisis: document.getElementById("campo-dias-dialisis"),
  dialisisDias: document.getElementById("dialisis-dias"),
  avisoDialisis: document.getElementById("aviso-dialisis"),
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
  planBadge: document.getElementById("plan-badge"),
  aboutPlan: document.getElementById("about-plan"),
  aboutVersion: document.getElementById("about-version"),
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
  consejoCard: document.getElementById("consejo-card"),
  consejoCuerpo: document.getElementById("consejo-cuerpo"),
  consejoFuente: document.getElementById("consejo-fuente"),
  paywallOverlay: document.getElementById("paywall-overlay"),
  paywallPeriodoToggle: document.getElementById("paywall-periodo-toggle"),
  paywallNiveles: document.getElementById("paywall-niveles"),
  paywallSuscribirBtn: document.getElementById("paywall-suscribir-btn"),
  paywallRestaurarBtn: document.getElementById("paywall-restaurar-btn"),
  paywallCerrarBtn: document.getElementById("paywall-cerrar-btn"),
  paywallTitulo: document.getElementById("paywall-titulo"),
  paywallBajada: document.getElementById("paywall-bajada"),
  suscripcionEstado: document.getElementById("suscripcion-estado"),
  paywallDetallePrecio: document.getElementById("paywall-detalle-precio"),
  paywallTratanteBtn: document.getElementById("paywall-tratante-btn"),
  tratanteVolverPlanes: document.getElementById("tratante-volver-planes"),
  verPlanesBtn: document.getElementById("ver-planes-btn"),
  paywallMsg: document.getElementById("paywall-msg"),
  terminosOverlay: document.getElementById("terminos-overlay"),
  terminosCheckbox: document.getElementById("terminos-checkbox"),
  terminosAceptarBtn: document.getElementById("terminos-aceptar-btn"),
  perfilOverlay: document.getElementById("perfil-overlay"),
  perfilOverlayNombre: document.getElementById("perfil-overlay-nombre"),
  perfilOverlayFechaNacimiento: document.getElementById("perfil-overlay-fecha-nacimiento"),
  perfilOverlayContinuarBtn: document.getElementById("perfil-overlay-continuar-btn"),
  confirmarClinicoBtn: document.getElementById("confirmar-clinico-btn"),
  etapaBadgeBtn: document.getElementById("etapa-badge-btn"),
  editarClinicoOverlay: document.getElementById("editar-clinico-overlay"),
  cerrarClinicoBtn: document.getElementById("cerrar-clinico-btn"),
  onboardingClinico: document.getElementById("onboarding-clinico"),
  onboardingOmitirBtn: document.getElementById("onboarding-omitir-btn"),
  tabTratanteBtn: document.getElementById("tab-tratante-btn"),
  tratanteIntro: document.getElementById("tratante-intro"),
  tratanteCongeladoAviso: document.getElementById("tratante-congelado-aviso"),
  activarPlanClinico: document.getElementById("activar-plan-clinico"),
  codigoClienteBloque: document.getElementById("codigo-cliente-bloque"),
  codigoClienteValor: document.getElementById("codigo-cliente-valor"),
  qrVinculo: document.getElementById("qr-vinculo"),
  qrVinculoImagen: document.getElementById("qr-vinculo-imagen"),
  copiarCodigoBtn: document.getElementById("copiar-codigo-btn"),
  vinculosPendientes: document.getElementById("vinculos-pendientes"),
  vinculosActivos: document.getElementById("vinculos-activos"),
  metasSincronizadas: document.getElementById("metas-sincronizadas"),
  metasSincronizadasLista: document.getElementById("metas-sincronizadas-lista"),
  fotoPacienteBloque: document.getElementById("foto-paciente-bloque"),
  fotoPacienteVista: document.getElementById("foto-paciente-vista"),
  fotoPacienteElegir: document.getElementById("foto-paciente-elegir"),
  fotoPacienteBorrar: document.getElementById("foto-paciente-borrar"),
  fotoPacienteInput: document.getElementById("foto-paciente-input"),
  fotoConsentimiento: document.getElementById("foto-consentimiento"),
  fotoPacienteStatus: document.getElementById("foto-paciente-status"),
  indicacionesBloque: document.getElementById("indicaciones-bloque"),
  indicacionesLista: document.getElementById("indicaciones-lista"),
  refrigeradorChecklist: document.getElementById("refrigerador-checklist"),
  refrigeradorBuscador: document.getElementById("refrigerador-buscador"),
  refrigeradorSinResultados: document.getElementById("refrigerador-sin-resultados"),
  refrigeradorPreviewWrap: document.getElementById("refrigerador-preview-wrap"),
  refrigeradorPreview: document.getElementById("refrigerador-preview"),
  refrigeradorFotosCuenta: document.getElementById("refrigerador-fotos-cuenta"),
  refrigeradorTira: document.getElementById("refrigerador-tira"),
  refrigeradorCameraInput: document.getElementById("refrigerador-camera-input"),
  refrigeradorIdentificarBtn: document.getElementById("refrigerador-identificar-btn"),
  refrigeradorManual: document.getElementById("refrigerador-manual"),
  refrigeradorIaStatus: document.getElementById("refrigerador-ia-status"),
  refrigeradorIdentificados: document.getElementById("refrigerador-identificados"),
  refrigeradorGenerarBtn: document.getElementById("refrigerador-generar-btn"),
  refrigeradorRecetaIa: document.getElementById("refrigerador-receta-ia"),
  robotSelectorWrap: document.getElementById("robot-selector-wrap"),
  robotSelector: document.getElementById("robot-selector"),
  robotSelectorNota: document.getElementById("robot-selector-nota"),
  revisarRecetaCard: document.getElementById("revisar-receta-card"),
  recetaExternaCameraInput: document.getElementById("receta-externa-camera-input"),
  recetaExternaPreview: document.getElementById("receta-externa-preview"),
  recetaExternaPreviewWrap: document.getElementById("receta-externa-preview-wrap"),
  recetaExternaTexto: document.getElementById("receta-externa-texto"),
  recetaExternaLeerBtn: document.getElementById("receta-externa-leer-btn"),
  recetaExternaStatus: document.getElementById("receta-externa-status"),
  recetaExternaTranscripcion: document.getElementById("receta-externa-transcripcion"),
  recetaExternaAnalisis: document.getElementById("receta-externa-analisis"),
  refrigeradorLimpiarBtn: document.getElementById("refrigerador-limpiar-btn"),
  recetasGuardadasWrap: document.getElementById("recetas-guardadas-wrap"),
  recetasGuardadasList: document.getElementById("recetas-guardadas-list"),
  tabBar: document.getElementById("tab-bar"),
  superChecklist: document.getElementById("super-checklist"),
  superItemNombre: document.getElementById("super-item-nombre"),
  superItemPrecio: document.getElementById("super-item-precio"),
  superAgregarStatus: document.getElementById("super-agregar-status"),
  analisisDiaBtn: document.getElementById("analisis-dia-btn"),
  analisisDiaStatus: document.getElementById("analisis-dia-status"),
  analisisDiaResultado: document.getElementById("analisis-dia-resultado"),
  superCompartirBtn: document.getElementById("super-compartir-btn"),
  superImprimirBtn: document.getElementById("super-imprimir-btn"),
  superCompartirStatus: document.getElementById("super-compartir-status"),
  impresionBox: document.getElementById("impresion"),
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
    INGREDIENTES_REFRIGERADOR = await fetch("ingredientes-refrigerador.json").then((r) => r.json());
  } catch (e) {
    console.warn("No se pudo cargar ingredientes-refrigerador.json", e);
  }
  try {
    PRECIOS_REFERENCIA = await fetch("precios-referencia.json").then((r) => r.json());
  } catch (e) {
    console.warn("No se pudo cargar precios-referencia.json", e);
  }
  // Si el catálogo de robots no carga, el modo robot simplemente no aparece y
  // la receta se genera igual con los pasos normales.
  try {
    ROBOTS = await fetch("robots-cocina.json").then((r) => r.json()).then((d) => d.robots || []);
  } catch (e) {
    console.warn("No se pudo cargar robots-cocina.json, el modo robot queda oculto", e);
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
  renderBanner();
  renderPlan();
  renderDatosPersonales();
  renderDatosClinicos();
  renderEtapaBadge();
  renderTerminos();
  renderPerfilOverlay();
  renderSuscripcion();
  initRevenueCat();
  renderTabsPorNivel();
  initTabs();
  renderRecetasGuardadas();
  renderRobotSelector();
  els.robotSelector.addEventListener("change", guardarRobotCocina);
  renderRevisarReceta();
  els.recetaExternaCameraInput.addEventListener("change", (e) =>
    handleRecetaExternaFoto(e.target.files[0])
  );
  els.recetaExternaLeerBtn.addEventListener("click", leerRecetaExternaTexto);
  els.refrigeradorBuscador.addEventListener("input", filtrarChecklistRefrigerador);
  renderAvisoDialisis();

  // Presets de los horarios más frecuentes: marcar tres casillas a mano cada
  // vez que se edita el perfil es fricción innecesaria.
  els.campoDiasDialisis.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset-dialisis]");
    if (!btn) return;
    const dias = btn.dataset.presetDialisis.split(",").map(Number);
    els.dialisisDias.querySelectorAll(".dialisis-dia").forEach((el) => {
      el.checked = dias.includes(Number(el.value));
    });
  });

  els.analisisDiaBtn.addEventListener("click", analizarMiDia);
  els.superCompartirBtn.addEventListener("click", compartirListaSuper);
  els.superImprimirBtn.addEventListener("click", imprimirListaSuper);
  renderVinculacion();
  refrescarVinculos();
  refrescarMetasSincronizadas();
  setInterval(refrescarVinculos, VINCULOS_POLL_MS);
  els.fotoConsentimiento.addEventListener("change", cambiarConsentimientoFoto);
  els.fotoPacienteElegir.addEventListener("click", () => els.fotoPacienteInput.click());
  els.fotoPacienteInput.addEventListener("change", (e) => {
    subirFotoPaciente(e.target.files[0]);
    e.target.value = ""; // permite volver a elegir el mismo archivo
  });
  els.fotoPacienteBorrar.addEventListener("click", borrarFotoPaciente);

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
  els.paywallRestaurarBtn.addEventListener("click", restaurarCompras);
  els.verPlanesBtn.addEventListener("click", abrirPaywallConsulta);
  els.paywallTratanteBtn.addEventListener("click", abrirGestionTratanteSinPlan);
  els.tratanteVolverPlanes.querySelector("button").addEventListener("click", volverAPlanes);
  els.paywallCerrarBtn.addEventListener("click", cerrarPaywallConsulta);
  els.paywallPeriodoToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".paywall-periodo-btn");
    if (!btn) return;
    paywallPeriodoSeleccionado = btn.dataset.periodo;
    renderPaywallNiveles();
  });
  els.paywallNiveles.addEventListener("click", (e) => {
    const btn = e.target.closest(".paywall-nivel");
    if (!btn) return;
    paywallNivelSeleccionado = btn.dataset.nivel;
    renderPaywallNiveles();
  });
  els.terminosCheckbox.addEventListener("change", () => {
    els.terminosAceptarBtn.disabled = !els.terminosCheckbox.checked;
  });
  els.terminosAceptarBtn.addEventListener("click", aceptarTerminos);
  els.perfilOverlayNombre.addEventListener("input", actualizarBotonPerfilOverlay);
  els.perfilOverlayFechaNacimiento.addEventListener("input", actualizarBotonPerfilOverlay);
  els.perfilOverlayContinuarBtn.addEventListener("click", continuarPerfilOverlay);
  els.confirmarClinicoBtn.addEventListener("click", confirmarDatosClinicos);
  els.etapaBadgeBtn.addEventListener("click", abrirEdicionClinica);
  els.cerrarClinicoBtn.addEventListener("click", cerrarEdicionClinica);
  els.onboardingOmitirBtn.addEventListener("click", cerrarEdicionClinica);
  els.editarClinicoOverlay.addEventListener("click", (e) => {
    if (e.target === els.editarClinicoOverlay) cerrarEdicionClinica();
  });
  els.activarPlanClinico.addEventListener("change", activarPlanClinico);
  els.copiarCodigoBtn.addEventListener("click", copiarCodigoCliente);
  els.refrigeradorCameraInput.addEventListener("change", (e) => {
    handleRefrigeradorFileSelected(e.target.files);
    // Sin esto, volver a elegir la misma foto no dispara "change" y el paciente
    // cree que la app lo ignoró.
    e.target.value = "";
  });
  els.refrigeradorTira.addEventListener("click", (e) => {
    const btn = e.target.closest(".quitar-foto");
    if (!btn) return;
    refrigeradorImagenes.splice(Number(btn.dataset.i), 1);
    renderTiraFotos();
    setRefrigeradorStatus("");
  });
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
  els.pesoGuardarBtn.addEventListener("click", guardarPeso);

  els.superAgregarBtn.addEventListener("click", agregarItemPersonalizadoSuper);
  els.superLimpiarBtn.addEventListener("click", limpiarSeleccionSuper);
  els.superFotoInput.addEventListener("change", (e) => handleSuperFotoSelected(e.target.files[0]));
  els.superFotoIdentificarBtn.addEventListener("click", identificarProductoSuper);

  renderCalculadora();
}

// --- Navegación por pestañas ---
const TAB_STORAGE_KEY = "kidneyChefTabActiva";

function initTabs() {
  // Siempre se abre en Hoy, aunque la última sesión haya terminado en otra
  // pestaña. Antes se restauraba la guardada y eso dejaba a alguien entrando
  // directo a la lista del supermercado por la mañana, en vez de al panel del
  // día, que es para lo que se abre esta app. La pestaña guardada se sigue
  // escribiendo por si más adelante hace falta.
  irATab("hoy");

  els.tabBar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => irATab(btn.dataset.tabTarget));
  });
}

function irATab(tab) {
  // Venga de donde venga el salto (la barra, el puente a la receta, un cambio
  // de nivel), nadie cae en una pestaña que su nivel no incluye.
  if (!tabPermitida(tab)) tab = "hoy";
  if (gestionTratanteSinPlan) tab = "tratante";
  document.querySelectorAll("[data-tab]").forEach((el) => {
    el.classList.toggle("tab-inactive", el.dataset.tab !== tab);
  });
  els.tabBar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.tabTarget === tab));
  });
  localStorage.setItem(TAB_STORAGE_KEY, tab);
}

function tabPermitida(tab) {
  if (tab === "tratante") return modoTratante() !== "oculto";
  const minimo = NIVEL_MINIMO_TAB[tab];
  return !minimo || nivelSuficiente(minimo);
}

// Rota cada tres horas en vez de una vez al día: alguien que abre la app en
// cada comida veía el mismo consejo tres veces. Tres horas es suficiente para
// que cambie entre comidas sin que se sienta inquieto — y no rota mientras
// está leyendo, que sería peor que no rotar.
const HORAS_POR_CONSEJO = 3;

function consejoDelDia() {
  if (!TIPS_DEL_DIA.length) return null;
  const bloque = Math.floor(Date.now() / (HORAS_POR_CONSEJO * 3600 * 1000));
  return TIPS_DEL_DIA[bloque % TIPS_DEL_DIA.length];
}

// --- Banda de anuncios de arriba --------------------------------------
// El consejo del día ocupaba una tarjeta de 145 px en la pestaña Hoy,
// compitiendo por espacio con lo clínico. Ahora se desplaza en continuo por la
// misma franja que avisa los días de prueba: mismo mensaje, cero altura extra.
//
// La pista lleva el contenido DOS veces y la animación recorre exactamente la
// mitad, así el final empalma con el principio y no se ve el salto.


// El consejo estaba en una banda que se desplazaba sola. Camilo la quitó por
// una razón buena: "no se lee, parece propaganda" — un texto en movimiento
// dentro de una app de salud se lee como publicidad y el ojo lo esquiva.
// Ahora es una tarjeta quieta con el ícono de la app, que es quien habla.
//
// Los días de prueba salían también en la banda y ya no: la tarjeta "Tu
// suscripción" los dice más abajo, y repetirlos era ruido.
function renderBanner() {
  const { bloqueado } = estadoSuscripcion();
  const consejo = consejoDelDia();
  els.consejoCard.hidden = bloqueado || !consejo;
  if (els.consejoCard.hidden) return;
  els.consejoCuerpo.textContent = consejo.texto;
  els.consejoFuente.hidden = !consejo.fuente;
  els.consejoFuente.innerHTML = consejo.fuente ? `Fuente: ${enlaceFuente(consejo.fuente)}` : "";
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
      headers: headersApi({ "Content-Type": "application/json" }),
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

// "aguja" está en "aguja de vacuno" pero no en "aguacate": el trozo tiene que
// empezar y terminar donde termina una palabra, no en cualquier letra.
function contienePalabra(texto, trozo) {
  if (!trozo || trozo.length > texto.length) return false;
  const esBorde = (ch) => ch === undefined || !/[a-z0-9]/.test(ch);
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(trozo, desde);
    if (i === -1) return false;
    if (esBorde(texto[i - 1]) && esBorde(texto[i + trozo.length])) return true;
    desde = i + 1;
  }
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
  //
  // El parcial exige límite de palabra en las DOS direcciones. Con substring
  // suelto, "papa" caía en "papaya" y "pollo" en "repollo" —y como el primero
  // de la lista ganaba el empate, el paciente veía los 182 mg de potasio de la
  // papaya donde había una papa de 425, o el fósforo del repollo (26 mg) donde
  // había pechuga de pollo (200). Aquí un nombre mal resuelto no es un detalle
  // cosmético: es la cifra que el paciente usa para decidir qué come.
  let best = null;
  let bestOverlap = 0;
  for (const food of FOODS) {
    const candidates = [food.nombre, ...(food.alias || [])].map(normalize);
    for (const c of candidates) {
      let overlap = 0;
      if (contienePalabra(n, c)) overlap = c.length;
      else if (contienePalabra(c, n)) overlap = n.length;
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
    .join("") + puenteALaReceta();

  const puente = document.getElementById("ir-a-receta-btn");
  if (puente) puente.addEventListener("click", llevarAnalisisALaReceta);

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

// Antes del rediseño por pestañas todo vivía en un solo scroll: bajo el
// resultado de la foto quedaba, en la misma página, "Generar receta a mi
// medida". Al separar las pestañas la receta se fue a otra y esta pantalla
// terminó en un callejón: le decimos al paciente que su plato tiene 765 mg de
// potasio y ahí lo dejamos. Este puente le devuelve la salida, y se lleva lo
// que ya reconocimos para que no tenga que fotografiar todo de nuevo.
function puenteALaReceta() {
  if (!lastAnalysis.some((i) => i.match)) return "";
  // Las recetas son de Platinum: a Gold no se le ofrece un botón que lleva a
  // una pestaña que su nivel no incluye.
  if (!tabPermitida("refrigerador")) return "";
  return `
    <div class="puente-receta">
      <p>¿Quieres cocinar algo que te acomode mejor con lo que te queda del día?</p>
      <button id="ir-a-receta-btn" class="btn btn-primary" style="width:100%;">Generar receta a mi medida</button>
    </div>`;
}

// Un plato ya servido no es un ingrediente: "cazuela" no tiene casilla en el
// refrigerador y no debe entrar al generador como si lo fuera. Se traspasa
// solo lo que sí es ingrediente, y se dice en voz alta qué quedó fuera para
// que el paciente no crea que la receta lo tomó en cuenta.
function llevarAnalisisALaReceta() {
  const identificados = lastAnalysis.filter((i) => i.match);
  irATab("refrigerador");
  const { marcados, fueraDeLista } = marcarIdentificadosEnChecklist(identificados);

  if (marcados.length) {
    abrirChecklistManual();
    setRefrigeradorStatus(
      `Marcamos ${marcados.length === 1 ? "1 ingrediente" : `${marcados.length} ingredientes`} de tu foto` +
      (fueraDeLista.length ? `. ${fueraDeLista.join(" y ")} no ${fueraDeLista.length === 1 ? "es un ingrediente suelto" : "son ingredientes sueltos"}, así que ${fueraDeLista.length === 1 ? "queda" : "quedan"} fuera.` : ". Agrega lo que falte y genera la receta.")
    );
  } else {
    abrirChecklistManual();
    setRefrigeradorStatus("Tu foto era un plato ya preparado. Marca abajo los ingredientes que tienes y te armamos la receta.");
  }

  els.refrigeradorGenerarBtn.scrollIntoView({ behavior: "smooth", block: "center" });
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
      ${fuenteAlimentoHtml(match)}
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
  if (d.diabetes || metaDiaria("carbohidratos_g") != null) base.push("carbohidratos_g");
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

// Todos los semáforos describen el CONTENIDO, con cortes publicados, y hay que
// decírselo al paciente: el color no dice si se pasó de su límite del día (eso
// lo muestra "Así va tu día"). La nota enlaza a las fuentes.
function notaSinMeta(por100g = false) {
  if (!LIMITES) return "";
  const texto = por100g
    ? "El color indica cuánto potasio, fósforo y sodio tiene el plato por cada 100 g, según la tabla del Hospital del Mar y la FDA"
    : "El color indica cuánto aporta esta porción, según la National Kidney Foundation y la FDA";
  return `<p class="nota-sin-meta">${texto}. No dice si superaste tu límite del día. <a href="fuentes.html#semaforo" target="_blank" rel="noopener">Ver fuentes</a></p>`;
}

// Enlace a una fuente de LIMITES.fuentes por su id. Si el archivo no cargó,
// cae a la página de fuentes, que no depende de JavaScript.
function enlaceFuente(id) {
  const f = LIMITES && LIMITES.fuentes && LIMITES.fuentes[id];
  if (!f) return `<a href="fuentes.html" target="_blank" rel="noopener">Ver fuentes</a>`;
  return `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.nombre_corto)}</a>`;
}

// Cita del dato de cada alimento. Los que vienen de una ficha USDA enlazan a
// esa ficha exacta; las preparaciones se arman con ingredientes USDA.
function fuenteAlimentoHtml(food) {
  if (!food || !food.fuente) return "";
  const fdcId = food.fuente.fdc_id;
  if (fdcId) {
    return `<p class="fuente-dato">Datos: <a href="https://fdc.nal.usda.gov/food-details/${encodeURIComponent(fdcId)}/nutrients" target="_blank" rel="noopener">USDA FoodData Central, ficha ${escapeHtml(String(fdcId))}</a></p>`;
  }
  return `<p class="fuente-dato">Datos: calculados con ingredientes de USDA FoodData Central. <a href="fuentes.html#alimentos" target="_blank" rel="noopener">Ver fuentes</a></p>`;
}

function badge(nutriente, valorPorcion, densidad100g, por100g = false) {
  const unidad = nutriente === "carbohidratos_g" ? "g" : "mg";
  const { nivel, modo } = clasificar(nutriente, valorPorcion, densidad100g, por100g);
  // Carbohidratos no tienen un corte por porción publicado: se muestra la
  // cifra sin color en vez de esconderla, porque al paciente con diabetes
  // igual le sirve, y su meta diaria (si el tratante la fijó) sí se ve en
  // "Así va tu día".
  if (!nivel && nutriente === "carbohidratos_g" && valorPorcion != null) {
    return `
    <div class="semaforo-badge nivel-incompleto">
      <span class="label">${NUTRIENTE_LABEL[nutriente]}</span>
      <span class="badge-icon-circle">${NUTRIENTE_ICON[nutriente]}</span>
      <span class="value">${valorPorcion} ${unidad}</span>
      <span class="tag-pill">Sin semáforo</span>
    </div>`;
  }
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
// Catálogo de robots de cocina del "Modo robot" (public/robots-cocina.json).
// Ojo con la expectativa que genera el nombre: KidneyChef NO se conecta con
// Cookidoo ni con la nube de ningún fabricante — no existe una API pública
// para eso, y la única vía no oficial exige la contraseña de Cookidoo del
// paciente. Lo que sí hace es escribir los pasos en el lenguaje de su máquina.
let ROBOTS = [];

let INGREDIENTES_REFRIGERADOR = [];
let PRECIOS_REFERENCIA = [];
let recetaActualIA = null; // última receta generada por IA, pendiente o ya guardada
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

// Con 114 ingredientes en la lista, encontrar uno a ojo dejó de ser viable.
// El filtro esconde las casillas que no coinciden, pero NO desmarca nada: si el
// paciente ya marcó cebolla y después busca "pollo", la cebolla sigue marcada y
// vuelve a aparecer al limpiar la búsqueda.
function filtrarChecklistRefrigerador() {
  const q = normalize(els.refrigeradorBuscador.value || "");
  let visibles = 0;

  els.refrigeradorChecklist.querySelectorAll(".refrigerador-categoria").forEach((grupo) => {
    let enGrupo = 0;
    grupo.querySelectorAll(".clinical-check").forEach((label) => {
      const coincide = !q || normalize(label.textContent).includes(q);
      label.hidden = !coincide;
      if (coincide) enGrupo += 1;
    });
    grupo.hidden = enGrupo === 0;
    visibles += enGrupo;
  });

  // Los "más comprados" son un atajo, no parte de la lista: con una búsqueda
  // activa estorban más de lo que ayudan.
  const destacados = els.refrigeradorChecklist.querySelector(".mas-comprados");
  if (destacados) destacados.hidden = Boolean(q);

  els.refrigeradorSinResultados.hidden = visibles > 0;
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

// --- Identificar ingredientes por foto y generar una receta a medida con IA ---
// Varias fotos a la vez: refrigerador, despensa y congelador son tres fotos de
// la misma pregunta, y obligar a repetir el ciclo entero por cada una era
// pedirle al paciente que hiciera de secretario.
//
// Se mantiene la regla que ya estaba: una SELECCIÓN nueva reemplaza a la
// anterior, no se acumula. "Esto es lo que tengo ahora", no "agrega esto a lo
// de antes" — acumular en silencio hacía que una receta mezclara ingredientes
// de fotos viejas sin que se notara. Lo que sí se acumula son las fotos de una
// misma selección, porque son una sola respuesta.
let refrigeradorImagenes = [];
let ingredientesIdentificados = []; // [{ alimentoIA, match }], match siempre resuelto en FOODS

const MAX_FOTOS_REFRIGERADOR = 4;

function leerComoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleRefrigeradorFileSelected(files) {
  const lista = [...(files || [])].filter(Boolean);
  if (!lista.length) return;

  const exceso = lista.length > MAX_FOTOS_REFRIGERADOR;
  const usar = lista.slice(0, MAX_FOTOS_REFRIGERADOR);

  try {
    refrigeradorImagenes = await Promise.all(usar.map(leerComoDataUrl));
  } catch {
    setRefrigeradorStatus("No pudimos leer esas fotos. Inténtalo de nuevo.", true);
    return;
  }

  renderTiraFotos();
  setRefrigeradorStatus(
    exceso
      ? `Usaremos las primeras ${MAX_FOTOS_REFRIGERADOR} fotos; el resto quedó fuera.`
      : "",
    exceso
  );
}

// Con una sola foto se mantiene el preview grande de siempre; con varias se
// muestran todas en miniatura, cada una con su ✕. Poder sacar la que salió
// movida antes de identificar no es un lujo: cada foto es una llamada a la IA
// que cuesta dinero, y una foto ilegible solo devuelve ruido.
function renderTiraFotos() {
  const n = refrigeradorImagenes.length;
  els.refrigeradorPreviewWrap.hidden = n !== 1;
  els.refrigeradorTira.hidden = n < 2;
  els.refrigeradorIdentificarBtn.disabled = n === 0;
  els.refrigeradorFotosCuenta.textContent = n > 1 ? `${n} fotos seleccionadas` : "";

  if (n === 1) els.refrigeradorPreview.src = refrigeradorImagenes[0];

  els.refrigeradorTira.innerHTML = n < 2 ? "" : refrigeradorImagenes.map((src, i) => `
    <figure>
      <img src="${src}" alt="Foto ${i + 1} de tus ingredientes">
      <button type="button" class="quitar-foto" data-i="${i}" aria-label="Quitar la foto ${i + 1}">✕</button>
    </figure>`).join("");
}

// El checklist manual vive en un <details> colapsado para no ocupar la pantalla
// con 114 casillas. Pero cuando es la única vía que le queda al paciente —sin
// cámara, con mala luz, o cuando la IA no reconoce nada— hay que abrirlo y
// llevarlo hasta ahí, no solo nombrarlo en un mensaje.
function abrirChecklistManual() {
  if (!els.refrigeradorManual) return;
  els.refrigeradorManual.open = true;
  els.refrigeradorManual.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function setRefrigeradorStatus(msg, isError = false, isLoading = false) {
  els.refrigeradorIaStatus.innerHTML = isLoading
    ? `<span class="status-spinner" aria-hidden="true"></span>${escapeHtml(msg)}`
    : escapeHtml(msg);
  els.refrigeradorIaStatus.classList.toggle("error", isError);
}

async function identificarIngredientesRefrigerador() {
  if (!refrigeradorImagenes.length) return;
  els.refrigeradorIdentificarBtn.disabled = true;
  const varias = refrigeradorImagenes.length > 1;
  setRefrigeradorStatus(
    varias ? `Identificando ingredientes en ${refrigeradorImagenes.length} fotos…` : "Identificando ingredientes con IA…",
    false, true
  );

  try {
    // Una llamada por foto, en paralelo. Si una falla, las otras siguen
    // valiendo: perder los ingredientes del refrigerador porque la foto de la
    // despensa salió movida no le sirve a nadie.
    const respuestas = await Promise.all(
      refrigeradorImagenes.map((imagen) =>
        fetch(`${API_BASE}/api/identificar-ingredientes`, {
          method: "POST",
          headers: headersApi({ "Content-Type": "application/json" }),
          body: JSON.stringify({ image: imagen }),
        })
          .then(async (res) => {
            const cuerpo = await res.json();
            if (!res.ok) throw new Error(cuerpo.error || "Error desconocido");
            return cuerpo;
          })
          .catch((e) => ({ _error: e.message }))
      )
    );

    const fallidas = respuestas.filter((r) => r._error);
    if (fallidas.length === respuestas.length) throw new Error(fallidas[0]._error);

    // Fusionar sin repetir: el tomate que aparece en dos fotos es un tomate.
    const vistos = new Set();
    const items = [];
    for (const r of respuestas) {
      for (const item of (r.items || [])) {
        const clave = normalize(item.alimento || "");
        if (clave && !vistos.has(clave)) { vistos.add(clave); items.push(item); }
      }
    }
    const data = { items, _fallidas: fallidas.length };

    // Antes esto era un .filter() que botaba en silencio todo lo que matchFood()
    // no supiera resolver: la IA reconocía "palta" y el paciente no se enteraba
    // de que se había descartado. Ahora se separan y se le dice qué pasó con
    // cada cosa.
    const nuevos = [];
    const sinDato = [];
    for (const item of (data.items || [])) {
      const match = matchFood(item.alimento);
      if (match) nuevos.push({ alimentoIA: item.alimento, match });
      else sinDato.push(item.alimento);
    }

    if (nuevos.length === 0) {
      // Abrir el checklist, no solo nombrarlo: es la única salida que le queda
      // al paciente y vive dentro de un <details> colapsado, así que
      // mencionarlo sin abrirlo dejaba la sección en un callejón sin salida.
      abrirChecklistManual();
      setRefrigeradorStatus("No identificamos ningún ingrediente conocido en la foto. Márcalos a mano en la lista de abajo.", true);
      return;
    }
    // Cada selección reemplaza a la anterior (las fotos de una misma selección
    // sí se suman entre ellas): elegir fotos de nuevo significa "esto es lo que
    // tengo ahora", no "agrega esto a lo de antes" — acumular en silencio hacía
    // que una receta mezclara ingredientes de fotos viejas sin que se notara.
    ingredientesIdentificados = nuevos;
    // Marcarlos en el checklist es lo que le permite al paciente ver, en una
    // sola lista, qué detectó la IA y qué le falta agregar. Antes vivían en dos
    // sitios distintos —fichas arriba, casillas abajo— sin relación visible.
    const { marcados, fueraDeLista } = marcarIdentificadosEnChecklist(nuevos);
    if (marcados.length) abrirChecklistManual();
    // El resumen va DENTRO de la lista, no en setRefrigeradorStatus: .status es
    // un aviso flotante (position:fixed) y con una lista larga terminaba tapando
    // una tarjeta. Además la lista ya trae su propia nota, así que había dos
    // textos diciendo lo mismo.
    resumenIdentificacion = mensajeIdentificacion(nuevos, marcados, fueraDeLista, sinDato)
      + (data._fallidas ? ` No pudimos leer ${data._fallidas} de las fotos.` : "");
    setRefrigeradorStatus("");
    renderIngredientesIdentificados();
  } catch (err) {
    setRefrigeradorStatus(err.message, true);
  } finally {
    els.refrigeradorIdentificarBtn.disabled = false;
  }
}

// La IA devuelve ids de nutrientes.json ("res", "aguacate") y el checklist usa
// los suyos ("vacuno", "palta"), así que hay que traducir por nutrientes_id.
// Lo que no esté en el checklist igual cuenta para la receta: solo no tiene
// casilla que marcar, y por eso se nombra aparte en el mensaje.
function marcarIdentificadosEnChecklist(identificados) {
  const marcados = [];
  const fueraDeLista = [];
  for (const item of identificados) {
    const ing = (INGREDIENTES_REFRIGERADOR || []).find((i) => i.nutrientes_id === item.match.id);
    const casilla = ing && document.getElementById(`refrigerador-check-${ing.id}`);
    if (casilla) {
      casilla.checked = true;
      marcados.push(ing.nombre);
    } else {
      fueraDeLista.push(item.match.nombre);
    }
  }
  return { marcados, fueraDeLista };
}

function listaCorta(nombres, tope = 4) {
  if (nombres.length > tope) {
    return `${nombres.slice(0, tope).join(", ")} y ${nombres.length - tope} más`;
  }
  if (nombres.length <= 1) return nombres.join("");
  // "ají verde y kiwi", no "ají verde, kiwi": lo lee un paciente, no un log.
  return `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
}

function mensajeIdentificacion(nuevos, marcados, fueraDeLista, sinDato) {
  const partes = [`Reconocimos ${nuevos.length} ingrediente${nuevos.length === 1 ? "" : "s"}.`];
  if (marcados.length) {
    partes.push(`Marcamos ${marcados.length} en la lista de abajo — revísala y agrega lo que falte.`);
  }
  if (fueraDeLista.length) {
    partes.push(`${listaCorta(fueraDeLista)} no está en la lista, pero se usará igual.`);
  }
  if (sinDato.length) {
    partes.push(`No tenemos datos nutricionales de ${listaCorta(sinDato)}, así que no entra en la receta.`);
  }
  return partes.join(" ");
}

// Resumen de la última identificación: qué se reconoció, qué se marcó, qué no
// tiene datos. Se pinta dentro de la lista.
let resumenIdentificacion = "";

function desmarcarEnChecklist(food) {
  const ing = (INGREDIENTES_REFRIGERADOR || []).find((i) => i.nutrientes_id === food.id);
  const casilla = ing && document.getElementById(`refrigerador-check-${ing.id}`);
  if (casilla) casilla.checked = false;
}

// Qué tan "urgente" es este alimento PARA ESTE paciente. Solo pesan los
// nutrientes que le importan de verdad: los que tienen meta diaria (sodio
// siempre; potasio y fósforo cuando su situación se la da; carbohidratos si
// declaró diabetes). Un alimento alto en fósforo sube arriba en alguien en
// hemodiálisis y no distorsiona la lista de alguien que no restringe fósforo.
// Se usan los mismos umbrales validados de clasificar(), no unos nuevos.
function prioridadClinica(food) {
  if (!food) return -1;
  const peso = { rojo: 2, amarillo: 1, verde: 0 };
  let score = 0;
  for (const nutriente of nutrientesVisibles()) {
    const densidad = food[nutriente];
    if (densidad == null) continue;
    const { nivel } = clasificar(nutriente, Math.round(densidad), densidad, true);
    score += peso[nivel] || 0;
  }
  return score;
}

function sellosDeAlimento(food) {
  return nutrientesVisibles()
    .map((nutriente) => {
      const densidad = food[nutriente];
      if (densidad == null) return "";
      const { nivel } = clasificar(nutriente, Math.round(densidad), densidad, true);
      if (!nivel) return "";
      return `<span class="super-semaforo nivel-${nivel}">${escapeHtml(NUTRIENTE_LABEL[nutriente])} ${escapeHtml(nivelTagContenido(nivel))}</span>`;
    })
    .join("");
}

function renderIngredientesIdentificados() {
  // De mayor a menor prioridad clínica: lo que más puede comprometer las metas
  // de ESTE paciente queda arriba, que es lo primero que debería revisar.
  const orden = ingredientesIdentificados
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => prioridadClinica(b.item.match) - prioridadClinica(a.item.match));

  // Plegada por defecto, y esto no es un detalle de estilo: desplegada, ocho
  // tarjetas con sus sellos añaden ~1250 px y empujan "Generar receta a mi
  // medida" más de dos pantallas hacia abajo. La revisión importa, pero no
  // puede sepultar la acción por la que el paciente entró a esta pantalla.
  els.refrigeradorIdentificados.innerHTML = orden.length
    ? `<details class="reconocidos-detalle">
         <summary><strong>${orden.length} ingrediente${orden.length === 1 ? "" : "s"} reconocido${orden.length === 1 ? "" : "s"}</strong>
           — ${escapeHtml(listaCorta(orden.map(({ item }) => item.match.nombre), 3))}.
           Toca para revisar o corregir.</summary>
       <p class="clinical-note reconocidos-nota">${resumenIdentificacion
          ? escapeHtml(resumenIdentificacion) + " "
          : ""}Revisa que esté bien —puedes cambiar o quitar lo que no corresponda— y luego
         genera la receta. Los sellos son por cada 100 g del alimento crudo.</p>
       <ul class="reconocidos-lista">${orden.map(({ item, idx }) => {
          const kcal = item.match.calorias_kcal;
          return `
          <li class="reconocido">
            <div class="reconocido-cabecera">
              <span class="reconocido-nombre">${escapeHtml(item.match.nombre)}</span>
              <span class="reconocido-acciones">
                <button class="btn btn-ghost reconocido-cambiar" id="refrigerador-cambiar-${idx}">Cambiar</button>
                <button class="reconocido-quitar" id="refrigerador-quitar-${idx}" aria-label="Quitar ${escapeHtml(item.match.nombre)}">✕</button>
              </span>
            </div>
            ${item.corregido || normalize(item.alimentoIA || "") === normalize(item.match.nombre)
              ? ""
              : `<p class="reconocido-origen">La IA vio: ${escapeHtml(item.alimentoIA)}</p>`}
            <div class="super-semaforos">${sellosDeAlimento(item.match)}</div>
            ${kcal != null ? `<p class="reconocido-kcal">${Math.round(kcal)} kcal por 100 g</p>` : ""}
          </li>`;
        }).join("")}</ul>
       </details>`
    : "";

  orden.forEach(({ idx }) => {
    const cambiar = document.getElementById(`refrigerador-cambiar-${idx}`);
    if (cambiar) cambiar.addEventListener("click", () => openModal(idx, "refrigerador"));
    const btn = document.getElementById(`refrigerador-quitar-${idx}`);
    if (btn) btn.addEventListener("click", () => {
      // Desmarcar también la casilla: candidatosParaIA() une fichas y casillas,
      // así que quitar solo la ficha dejaba el ingrediente igual de dentro.
      const quitado = ingredientesIdentificados[idx];
      const ing = quitado && (INGREDIENTES_REFRIGERADOR || []).find((i) => i.nutrientes_id === quitado.match.id);
      const casilla = ing && document.getElementById(`refrigerador-check-${ing.id}`);
      if (casilla) casilla.checked = false;
      ingredientesIdentificados.splice(idx, 1);
      renderIngredientesIdentificados();
    });
  });
}

function limpiarSeleccionRefrigerador() {
  resumenIdentificacion = "";
  ingredientesIdentificados = [];
  renderIngredientesIdentificados();
  document.querySelectorAll(".refrigerador-ingrediente:checked").forEach((el) => { el.checked = false; });
  document.querySelectorAll('[id^="refrigerador-check-freq-"]:checked').forEach((el) => { el.checked = false; });
  refrigeradorImagenes = [];
  if (els.refrigeradorTira) renderTiraFotos();
  els.refrigeradorPreviewWrap.hidden = true;
  els.refrigeradorIdentificarBtn.disabled = true;
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

// --- Análisis del día -------------------------------------------------
//
// Dos piezas con responsabilidades separadas a propósito: el resumen sale de
// sumar el historial contra nutrientes.json —determinista, auditable, sin IA—
// y el comentario lo escribe la IA a partir de ESAS cifras, que le llegan ya
// calculadas. La IA nunca suma ni corrige un número que el paciente vaya a
// leer, igual que en las recetas.
let analisisDiaTexto = "";

function resumenDelDiaTexto() {
  const alimentos = loadHistory().filter((h) => isToday(h.fecha));
  const totales = totalesNutrientesHoy();
  const fecha = new Date().toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
  const lineas = [`Tu día en KidneyChef — ${fecha}`, ""];

  if (alimentos.length) {
    lineas.push("LO QUE REGISTRASTE");
    for (const a of alimentos) lineas.push(`- ${a.nombre} (${a.porcionG} g)`);
  } else {
    lineas.push("No registraste alimentos hoy.");
  }
  lineas.push("", "CÓMO TE FUE");

  const unidadDe = (n) => (n === "carbohidratos_g" ? "g" : n === "calorias_kcal" ? "kcal" : "mg");
  for (const n of [...nutrientesVisibles(), "calorias_kcal"]) {
    const total = Math.round(totales[n] || 0);
    const meta = metaDiaria(n);
    const u = unidadDe(n);
    lineas.push(meta
      ? `- ${NUTRIENTE_LABEL[n]}: ${total} de ${Math.round(meta)} ${u} (${Math.round(total / meta * 100)}%)`
      : `- ${NUTRIENTE_LABEL[n]}: ${total} ${u} — sin meta fijada`);
  }

  // metaLiquidos() devuelve {ml, esSupuesto}, no un número: cuando el paciente
  // no declaró su diuresis la meta es una suposición y hay que decirlo, o
  // estaría leyendo como suyo un límite que la app se inventó.
  const metaLiq = metaLiquidos();
  if (metaLiq) {
    const nota = metaLiq.esSupuesto ? " (estimado: no has registrado tu diuresis)" : "";
    lineas.push(`- Líquidos: ${Math.round(totalLiquidosHoy())} de ${Math.round(metaLiq.ml)} ml${nota}`);
  } else if (requiereDiuresis()) {
    lineas.push(`- Líquidos: ${Math.round(totalLiquidosHoy())} ml — sin meta fijada`);
  }

  lineas.push("");
  lineas.push("Los totales salen de sumar lo que registraste con datos oficiales USDA.");
  lineas.push("KidneyChef es apoyo educativo, no reemplaza a tu equipo de nefrología.");
  return { texto: lineas.join("\n"), alimentos, totales };
}

async function analizarMiDia() {
  const { texto, alimentos, totales } = resumenDelDiaTexto();
  els.analisisDiaBtn.disabled = true;
  setAnalisisDiaStatus("Revisando tu día…");

  const metas = {};
  for (const n of [...nutrientesVisibles(), "calorias_kcal"]) metas[n] = metaDiaria(n);

  let comentario = "";
  try {
    const res = await fetch(`${API_BASE}/api/analisis-dia`, {
      method: "POST",
      headers: headersApi({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        alimentos: alimentos.map((a) => ({ nombre: a.nombre, gramos: a.porcionG })),
        totales,
        metas,
        liquidos_ml: requiereDiuresis() ? Math.round(totalLiquidosHoy()) : null,
        meta_liquidos_ml: metaLiquidos() ? Math.round(metaLiquidos().ml) : null,
        situacion_clinica: situacionClinicaParaIA(),
        riesgo_hiperkalemia: riesgoHiperkalemia(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");
    comentario = data.comentario || "";
    setAnalisisDiaStatus("");
  } catch (err) {
    // El resumen con datos NO depende de la IA: si el comentario falla, el
    // paciente igual se lleva sus cifras. Perder las dos por una sería peor.
    setAnalisisDiaStatus("No pudimos escribir el comentario, pero tu resumen está listo.", true);
  }

  analisisDiaTexto = comentario ? `${texto}\n\nCOMENTARIO\n${comentario}` : texto;
  els.analisisDiaResultado.hidden = false;
  els.analisisDiaResultado.innerHTML = `
    <pre class="analisis-resumen">${escapeHtml(texto)}</pre>
    ${comentario ? `<div class="analisis-comentario"><span aria-hidden="true">💬</span><p>${escapeHtml(comentario)}</p></div>` : ""}
    <div class="super-compartir">
      <button id="analisis-compartir-btn" class="btn btn-secondary">Compartir</button>
      <button id="analisis-imprimir-btn" class="btn btn-ghost">Imprimir</button>
    </div>`;

  document.getElementById("analisis-compartir-btn").addEventListener("click", compartirAnalisisDia);
  document.getElementById("analisis-imprimir-btn").addEventListener("click", () => {
    els.impresionBox.textContent = analisisDiaTexto;
    window.print();
  });
  els.analisisDiaBtn.disabled = false;
}

async function compartirAnalisisDia() {
  if (!analisisDiaTexto) return;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Mi día en KidneyChef", text: analisisDiaTexto });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(analisisDiaTexto);
    setAnalisisDiaStatus("Resumen copiado. Pégalo donde quieras.");
  } catch {
    setAnalisisDiaStatus("No pudimos compartir desde aquí. Prueba con Imprimir.", true);
  }
}

function setAnalisisDiaStatus(msg, isError = false) {
  if (!els.analisisDiaStatus) return;
  els.analisisDiaStatus.textContent = msg;
  els.analisisDiaStatus.classList.toggle("error", Boolean(msg) && isError);
}

// --- Compartir e imprimir la lista ------------------------------------
//
// El paciente arma la lista en el sillón y la compra en el supermercado, casi
// siempre desde otro dispositivo o en papel. Sin una salida, la lista se queda
// encerrada en la app.
//
// Los sellos van en el texto porque son la razón de ser de esta lista: quien
// la recibe (una hija que hace la compra, por ejemplo) necesita ver que el
// queso es alto en fósforo, no solo su precio.
function textoSellos(food) {
  if (!food) return "";
  const factor = PORCION_REFERENCIA_SUPER_G / 100;
  return ["potasio_mg", "fosforo_mg", "sodio_mg"]
    .map((nutriente) => {
      const densidad = food[nutriente];
      if (densidad == null) return null;
      const { nivel } = clasificar(nutriente, Math.round(densidad * factor), densidad);
      return nivel ? `${NUTRIENTE_LABEL[nutriente]} ${nivelTagContenido(nivel)}` : null;
    })
    .filter(Boolean)
    .join(" · ");
}

function listaSuperComoTexto() {
  const seleccion = loadSuperSeleccion();
  const itemsCatalogo = itemsPreciables().filter((i) => seleccion.has(i.id));
  const itemsCustom = loadSuperCustom().filter((i) => i.checked);
  if (itemsCatalogo.length + itemsCustom.length === 0) return null;

  const lineas = ["Lista de supermercado — KidneyChef", ""];

  const porCategoria = new Map();
  for (const item of itemsCatalogo) {
    const cat = item.categoria || categoriaDelPadre(item) || "Otros";
    if (!porCategoria.has(cat)) porCategoria.set(cat, []);
    porCategoria.get(cat).push(item);
  }

  for (const [categoria, items] of porCategoria) {
    lineas.push(categoria.toUpperCase());
    for (const item of items) {
      const barata = cadenaMasBarata(item);
      const cadena = CADENAS_SUPER.find((c) => c.id === barata.cadena);
      const presentacion = item.presentacion ? ` (${item.presentacion})` : "";
      lineas.push(`- ${item.nombre}${presentacion} — ${formatoCLP(barata.precio)} en ${cadena.label}`);
      const sellos = textoSellos(foodDeItem(item));
      if (sellos) lineas.push(`  ${sellos}`);
    }
    lineas.push("");
  }

  if (itemsCustom.length) {
    lineas.push("AGREGADOS POR TI");
    for (const item of itemsCustom) lineas.push(`- ${item.nombre} — ${formatoCLP(item.precio_clp)}`);
    lineas.push("");
  }

  const totalMezclado = itemsCatalogo.reduce((acc, i) => acc + cadenaMasBarata(i).precio, 0)
    + itemsCustom.reduce((acc, i) => acc + i.precio_clp, 0);
  lineas.push(`Total comprando cada producto donde sea más barato: ${formatoCLP(totalMezclado)}`);

  if (itemsCatalogo.length) {
    const extra = itemsCustom.reduce((acc, i) => acc + i.precio_clp, 0);
    const porCadena = CADENAS_SUPER
      .map((c) => ({ c, total: itemsCatalogo.reduce((acc, i) => acc + i.precios[c.id], 0) + extra }))
      .sort((a, b) => a.total - b.total);
    lineas.push("");
    lineas.push("Comprando todo en una sola cadena:");
    porCadena.forEach((t, i) => {
      lineas.push(`- ${t.c.label}: ${formatoCLP(t.total)}${i === 0 ? "  ← la más barata" : ""}`);
    });
  }

  lineas.push("");
  lineas.push("Los sellos indican cuánto aporta cada alimento por porción de "
    + `${PORCION_REFERENCIA_SUPER_G} g, no si superas tu límite diario.`);
  lineas.push("Precios de referencia: confirma en el local.");
  return lineas.join("\n");
}

// Los cortes no llevan categoría propia: la heredan del producto padre.
function categoriaDelPadre(corte) {
  const padre = PRECIOS_REFERENCIA.find((p) => (p.cortes || []).some((c) => c.id === corte.id));
  return padre ? padre.categoria : null;
}

async function compartirListaSuper() {
  const texto = listaSuperComoTexto();
  if (!texto) {
    setSuperCompartirStatus("Marca al menos un producto antes de compartir la lista.", true);
    return;
  }
  setSuperCompartirStatus("");

  // navigator.share abre la hoja nativa: WhatsApp, Mail, Notas, lo que el
  // paciente tenga instalado. No hay que integrar cada servicio por separado.
  if (navigator.share) {
    try {
      await navigator.share({ title: "Lista de supermercado — KidneyChef", text: texto });
      return;
    } catch (e) {
      // Cancelar no es un error: si el paciente cierra la hoja, no hay nada
      // que decirle. Cualquier otra falla sí cae al respaldo de abajo.
      if (e && e.name === "AbortError") return;
    }
  }

  try {
    await navigator.clipboard.writeText(texto);
    setSuperCompartirStatus("Lista copiada. Pégala en WhatsApp, en un correo o donde quieras.");
  } catch {
    setSuperCompartirStatus("No pudimos compartir la lista desde aquí. Prueba con Imprimir.", true);
  }
}

function imprimirListaSuper() {
  const texto = listaSuperComoTexto();
  if (!texto) {
    setSuperCompartirStatus("Marca al menos un producto antes de imprimir la lista.", true);
    return;
  }
  setSuperCompartirStatus("");
  els.impresionBox.textContent = texto;
  window.print();
}

function setSuperCompartirStatus(msg, isError = false) {
  if (!els.superCompartirStatus) return;
  els.superCompartirStatus.textContent = msg;
  els.superCompartirStatus.classList.toggle("error", Boolean(msg) && isError);
}

function setSuperAgregarStatus(msg, isError = false) {
  if (!els.superAgregarStatus) return;
  els.superAgregarStatus.textContent = msg;
  els.superAgregarStatus.classList.toggle("error", Boolean(msg) && isError);
}

function quitarItemCustom(id) {
  const arr = loadSuperCustom().filter((i) => i.id !== id);
  saveSuperCustom(arr);
  renderSuperChecklist();
}

// Un precio chileno se escribe "12.990", con el punto como separador de MILES.
// El campo era type="number", donde el punto es el separador DECIMAL: "12.990"
// entraba como 12,99 pesos y el total quedaba absurdamente bajo. Y "$12.990" o
// "12,990" no se podían ni escribir, así que el botón no hacía nada sin decir
// por qué. El peso chileno no usa centavos, así que quedarse con los dígitos es
// exacto: "$12.990" y "12990" dan lo mismo.
function precioClpDesdeTexto(texto) {
  const digitos = String(texto).replace(/\D/g, "");
  if (!digitos) return null;
  const n = parseInt(digitos, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function agregarItemPersonalizadoSuper() {
  const nombre = els.superItemNombre.value.trim();
  const precio = precioClpDesdeTexto(els.superItemPrecio.value);

  // Antes esto era un return mudo: si el precio no se entendía, tocabas
  // "Agregar" y no pasaba nada, sin ninguna explicación.
  if (!nombre) {
    setSuperAgregarStatus("Escribe el nombre del producto.", true);
    return;
  }
  if (precio == null) {
    setSuperAgregarStatus("No entendí el precio. Escríbelo en pesos, por ejemplo 12.990.", true);
    return;
  }
  setSuperAgregarStatus("");

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
      headers: headersApi({ "Content-Type": "application/json" }),
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

// Techo de densidad del plato para la IA: sobre esta cifra por 100 g, el
// potasio o el fósforo del plato ya es alto en la tabla del Hospital del Mar.
// Se manda siempre, haya o no meta diaria, porque el semáforo del plato se
// calcula con esa misma tabla.
function densidadMaximaSinMeta() {
  if (!LIMITES || !LIMITES.plato_por_100g) return {};
  return {
    potasio_mg: LIMITES.plato_por_100g.potasio_mg.amarillo,
    fosforo_mg: LIMITES.plato_por_100g.fosforo_mg.amarillo,
  };
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

// --- Modo robot de cocina (nivel Diamond) ------------------------------
// Qué es y qué NO es: no hay integración técnica con Cookidoo ni con la nube
// de ningún fabricante. Cookidoo no publica API y su única vía de importación
// es manual, desde dentro de la propia Cookidoo; la única librería que existe
// es de ingeniería inversa y pide la contraseña del paciente. Lo que hace esta
// función es lo que sí se puede hacer bien: escribir los pasos de la receta
// con la velocidad, temperatura, tiempo y accesorios que la máquina declarada
// puede ejecutar de verdad (límites reales en robots-cocina.json, con la
// fuente de cada cifra), y dejarlos listos para copiar.
//
// Los ajustes los propone la IA pero los recorta el backend contra el
// catálogo (_sanear_pasos_robot en server.py) — el mismo criterio que con los
// nutrientes: la IA propone, el dato auditado manda.

function robotSeleccionado() {
  const perfil = ensurePerfil();
  if (!perfil.robotCocina) return null;
  return ROBOTS.find((r) => r.id === perfil.robotCocina) || null;
}

function renderRobotSelector() {
  if (!els.robotSelectorWrap) return;
  // Durante el mes de prueba nivelSuficiente() ya devuelve true, así que el
  // paciente puede probar el modo robot antes de decidir si paga Diamond.
  const disponible = ROBOTS.length > 0 && nivelSuficiente("diamond");
  els.robotSelectorWrap.hidden = !disponible;
  if (!disponible) return;

  const perfil = ensurePerfil();
  els.robotSelector.innerHTML = ['<option value="">Sin robot — pasos normales</option>']
    .concat(
      ROBOTS.map(
        (r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.nombre)}</option>`
      )
    )
    .join("");
  els.robotSelector.value = perfil.robotCocina || "";
  renderRobotNota();
}

function renderRobotNota() {
  if (!els.robotSelectorNota) return;
  const robot = robotSeleccionado();
  els.robotSelectorNota.textContent = robot
    ? `Tu receta va a traer además los pasos con velocidad, temperatura y tiempo para tu ${robot.nombre}, listos para copiar. KidneyChef no se conecta con tu máquina ni con Cookidoo.`
    : "Elige tu máquina y la receta generada va a traer además los pasos con velocidad, temperatura y tiempo para ella.";
}

function guardarRobotCocina() {
  const perfil = ensurePerfil();
  perfil.robotCocina = els.robotSelector.value || null;
  guardarPerfil(perfil);
  renderRobotNota();
}

// Los ajustes de un paso como etiquetas cortas ("8 min", "100 °C", "vel. 2").
// Una velocidad puede ser un número o un modo con nombre propio de la marca
// ("Varoma", "turbo"), así que solo se le antepone "vel." a los numéricos.
function ajustesPasoRobot(paso) {
  const chips = [];
  if (paso.minutos != null) chips.push(`${paso.minutos} min`);
  if (paso.temperatura_c != null) chips.push(`${paso.temperatura_c} °C`);
  if (paso.velocidad) {
    chips.push(/^[\d,]+$/.test(paso.velocidad) ? `vel. ${paso.velocidad}` : paso.velocidad);
  }
  if (paso.inverso) chips.push("giro inverso");
  return chips;
}

function pasosRobotHtml(receta, { conCopiar = true } = {}) {
  const pasos = receta.pasos_robot || [];
  if (!receta.robot || pasos.length === 0) return "";

  const items = pasos
    .map((paso) => {
      const chips = ajustesPasoRobot(paso)
        .map((c) => `<span class="robot-chip">${escapeHtml(c)}</span>`)
        .join("");
      return `<li><span class="robot-paso-texto">${escapeHtml(paso.texto)}</span>${
        chips ? `<span class="robot-chips">${chips}</span>` : ""
      }</li>`;
    })
    .join("");

  return `
    <div class="robot-bloque">
      <h4>En tu ${escapeHtml(receta.robot.nombre)}</h4>
      <ol class="robot-pasos">${items}</ol>
      <p class="robot-aviso">
        Tiempos y temperaturas de referencia: revisa el punto de cocción antes de servir.
        La carne, el pollo, el cerdo, el pescado y el huevo deben quedar bien cocidos.
      </p>
      ${conCopiar ? '<button id="robot-copiar-btn" class="btn btn-secondary">Copiar receta</button>' : ""}
    </div>`;
}

// Texto plano para pegar donde el paciente quiera: "Created Recipes" de
// Cookidoo, la app de su robot, o un mensaje a alguien. Es la única forma de
// llevar la receta a Cookidoo, porque no acepta importar desde fuera.
function recetaRobotComoTexto(receta) {
  const lineas = [receta.nombre, ""];
  lineas.push("Ingredientes:");
  (receta.ingredientes || []).forEach((i) => lineas.push(`- ${i.nombre}: ${i.gramos} g`));
  lineas.push("");
  if (receta.robot && (receta.pasos_robot || []).length) {
    lineas.push(`Preparación en ${receta.robot.nombre}:`);
    receta.pasos_robot.forEach((paso, i) => {
      const ajustes = ajustesPasoRobot(paso);
      lineas.push(`${i + 1}. ${paso.texto}${ajustes.length ? ` — ${ajustes.join(" / ")}` : ""}`);
    });
  } else {
    lineas.push("Preparación:");
    (receta.pasos || []).forEach((paso, i) => lineas.push(`${i + 1}. ${paso}`));
  }
  lineas.push("");
  lineas.push(`Porción total: ${receta.total_gramos} g`);
  lineas.push(
    "Receta generada por KidneyChef para una dieta renal. Los tiempos y temperaturas son de referencia: verifica el punto de cocción."
  );
  return lineas.join("\n");
}

async function copiarRecetaRobot() {
  if (!recetaActualIA) return;
  const texto = recetaRobotComoTexto(recetaActualIA);
  const btn = document.getElementById("robot-copiar-btn");
  try {
    await navigator.clipboard.writeText(texto);
    if (btn) {
      btn.textContent = "¡Copiada!";
      setTimeout(() => (btn.textContent = "Copiar receta"), 2000);
    }
  } catch {
    // El portapapeles puede estar bloqueado (permisos del sistema, WebView sin
    // gesto reconocido). Copiar es la ÚNICA forma de llevar la receta a
    // Cookidoo —no acepta importar desde fuera—, así que no basta con avisar
    // que falló: se muestra el texto listo para seleccionar y copiar a mano.
    mostrarRecetaParaCopiarAMano(texto, btn);
  }
}

function mostrarRecetaParaCopiarAMano(texto, btn) {
  const bloque = document.querySelector(".robot-bloque");
  if (!bloque || bloque.querySelector(".robot-copia-manual")) return;
  if (btn) btn.hidden = true;

  const wrap = document.createElement("div");
  wrap.className = "robot-copia-manual";
  wrap.innerHTML =
    '<p>No se pudo usar el portapapeles. Mantén presionado el texto para copiarlo:</p>';
  const area = document.createElement("textarea");
  area.readOnly = true;
  area.rows = 10;
  area.value = texto;
  wrap.appendChild(area);
  bloque.appendChild(wrap);
  area.focus();
  area.select();
}


// --- Revisar una receta de terceros (nivel Diamond) --------------------
// El paciente trae una receta que ya tiene (Cookidoo, la app de su robot, un
// libro) y la app le calcula el semáforo renal.
//
// De esa receta se toma SOLO la lista de ingredientes con sus cantidades. El
// texto de preparación no se pide, no se guarda y no se muestra: republicarlo
// sería redistribuir contenido con derechos de otro —Cookidoo es contenido
// pagado de Vorwerk— y no aporta nada al cálculo.
//
// La IA solo transcribe y convierte a gramos. Todo el análisis (totales,
// semáforo, alarma, sugerencias) se calcula acá con nutrientes.json y con
// clasificar(), la misma función validada clínicamente que usa el resto de la
// app. Ninguna cifra viene de lo que el modelo crea sobre un alimento.

// Orden de gravedad pedido: primero potasio (una hiperkalemia es aguda y
// puede ser mortal), después fósforo, después sodio.
const NUTRIENTES_ALARMA = ["potasio_mg", "fosforo_mg", "sodio_mg"];

// Alimentos donde la doble cocción sirve de verdad: se remojan en trozos y se
// cuecen en agua nueva, botando el agua, y eso lixivia parte del potasio. Es
// el mismo conjunto que ya usa el generador de recetas del backend.
const LIXIVIABLES = new Set([
  "papa", "papas_cocidas", "papas_duquesa", "pure_papas",
  "zanahoria", "calabaza", "remolacha",
  "lenteja", "lentejas_guisadas", "garbanzo", "frijol_negro",
  "guisante", "haba", "porotos_granados",
]);

let recetaExterna = null;
let recetaExternaImagen = null;

function renderRevisarReceta() {
  if (!els.revisarRecetaCard) return;
  els.revisarRecetaCard.hidden = !nivelSuficiente("diamond");
}

function setRecetaExternaStatus(msg, esError = false, cargando = false) {
  els.recetaExternaStatus.textContent = msg;
  els.recetaExternaStatus.className = `status${esError ? " error" : ""}${cargando ? " loading" : ""}`;
}

async function pedirLecturaReceta(payload) {
  setRecetaExternaStatus("Leyendo la receta…", false, true);
  els.recetaExternaTranscripcion.hidden = true;
  els.recetaExternaAnalisis.hidden = true;
  try {
    const res = await fetch(`${API_BASE}/api/leer-receta`, {
      method: "POST",
      headers: headersApi({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error desconocido");
    recetaExterna = data;
    setRecetaExternaStatus("");
    renderTranscripcionReceta();
  } catch (err) {
    setRecetaExternaStatus(err.message, true);
  }
}

function handleRecetaExternaFoto(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    recetaExternaImagen = reader.result;
    els.recetaExternaPreview.src = recetaExternaImagen;
    els.recetaExternaPreviewWrap.hidden = false;
    pedirLecturaReceta({ imagen: recetaExternaImagen });
  };
  reader.readAsDataURL(file);
}

function leerRecetaExternaTexto() {
  const texto = els.recetaExternaTexto.value.trim();
  if (!texto) {
    setRecetaExternaStatus("Pega primero la lista de ingredientes de la receta.", true);
    return;
  }
  els.recetaExternaPreviewWrap.hidden = true;
  pedirLecturaReceta({ texto });
}

// La transcripción es editable a propósito: la IA convierte "2 cebollas" a
// gramos con equivalencias caseras, y el paciente es quien sabe si sus cebollas
// eran grandes o chicas. También puede corregir un ingrediente mal reconocido.
function renderTranscripcionReceta() {
  if (!recetaExterna) return;
  const filas = recetaExterna.ingredientes
    .map((ing, i) => {
      const sinDato = !ing.id;
      return `
      <div class="receta-ext-fila${sinDato ? " sin-dato" : ""}">
        <span class="receta-ext-original">${escapeHtml(ing.texto || "")}</span>
        <div class="receta-ext-campos">
          <input type="text" list="food-datalist" data-idx="${i}" data-campo="nombre"
                 value="${escapeHtml(ing.nombre || "")}" placeholder="No está en la base"
                 aria-label="Ingrediente ${i + 1}">
          <input type="number" min="0" step="10" data-idx="${i}" data-campo="gramos"
                 value="${ing.gramos == null ? "" : ing.gramos}" placeholder="g"
                 aria-label="Gramos del ingrediente ${i + 1}">
          <button class="super-item-quitar" data-idx="${i}" data-campo="quitar"
                  aria-label="Quitar ingrediente ${i + 1}">✕</button>
        </div>
      </div>`;
    })
    .join("");

  els.recetaExternaTranscripcion.hidden = false;
  els.recetaExternaTranscripcion.innerHTML = `
    <h3>${escapeHtml(recetaExterna.nombre || "Receta")}</h3>
    <p class="clinical-note">
      Revisa que los ingredientes y las cantidades estén bien antes de analizar.
      Las cantidades se convirtieron a gramos con equivalencias caseras, así que
      son aproximadas.
    </p>
    <div class="receta-ext-porciones">
      <label for="receta-ext-porciones-input">Porciones que rinde</label>
      <input id="receta-ext-porciones-input" type="number" min="1" max="30" step="1"
             value="${recetaExterna.porciones || 4}">
    </div>
    <div class="receta-ext-lista">${filas}</div>
    <button id="receta-ext-analizar-btn" class="btn btn-primary" style="width:100%;margin-top:0.7rem;">
      Analizar esta receta
    </button>`;

  els.recetaExternaTranscripcion
    .querySelectorAll("[data-campo]")
    .forEach((el) => {
      const evento = el.tagName === "BUTTON" ? "click" : "change";
      el.addEventListener(evento, () => editarIngredienteReceta(el));
    });
  document
    .getElementById("receta-ext-analizar-btn")
    .addEventListener("click", analizarRecetaExterna);
}

function editarIngredienteReceta(el) {
  const idx = Number(el.dataset.idx);
  const campo = el.dataset.campo;
  const ing = recetaExterna.ingredientes[idx];
  if (!ing) return;

  if (campo === "quitar") {
    recetaExterna.ingredientes.splice(idx, 1);
  } else if (campo === "gramos") {
    const n = Number(el.value);
    ing.gramos = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  } else {
    // matchFood ya resuelve nombres y alias contra nutrientes.json; si no
    // encuentra nada exacto el ingrediente queda sin dato, que es justo lo que
    // el análisis necesita saber para no dar un verde falso.
    const texto = el.value.trim();
    const food = texto ? FOODS.find((f) => normalize(f.nombre) === normalize(texto)) : null;
    ing.id = food ? food.id : null;
    ing.nombre = food ? food.nombre : null;
  }
  renderTranscripcionReceta();
}

// Suma los aportes reales de cada ingrediente reconocido. Los no reconocidos
// se cuentan aparte: no se estiman ni se ignoran en silencio.
function totalesRecetaExterna(porciones) {
  const totales = { potasio_mg: 0, fosforo_mg: 0, sodio_mg: 0, carbohidratos_g: 0 };
  const aportes = [];
  const faltantes = [];
  let totalGramos = 0;

  recetaExterna.ingredientes.forEach((ing) => {
    const food = ing.id ? FOODS.find((f) => f.id === ing.id) : null;
    if (!food || !ing.gramos) {
      faltantes.push(ing.texto || ing.nombre || "ingrediente sin nombre");
      return;
    }
    const factor = ing.gramos / 100;
    Object.keys(totales).forEach((n) => {
      totales[n] += (food[n] || 0) * factor;
    });
    totalGramos += ing.gramos;
    aportes.push({ food, gramos: ing.gramos });
  });

  const porPorcion = {};
  Object.keys(totales).forEach((n) => {
    porPorcion[n] = totales[n] / porciones;
  });

  return { totales, porPorcion, totalGramos, aportes, faltantes };
}

// Un verde calculado sobre ingredientes que no pudimos contar es una falsa
// tranquilidad, y en potasio eso se paga caro. Con datos incompletos el verde
// se degrada a "sin confirmar"; el ámbar y el rojo se mantienen, porque los
// ingredientes que faltan solo pueden subir el total, nunca bajarlo.
function badgeRecetaExterna(nutriente, valorPorcion, densidad100g, hayFaltantes) {
  const { nivel, modo } = clasificar(nutriente, valorPorcion, densidad100g, true);
  if (!nivel) return "";
  if (hayFaltantes && nivel === "verde") {
    return `
      <div class="semaforo-badge nivel-incompleto">
        <span class="label">${NUTRIENTE_LABEL[nutriente]}</span>
        <span class="badge-icon-circle">${NUTRIENTE_ICON[nutriente]}</span>
        <span class="value">${Math.round(valorPorcion)} mg</span>
        <span class="tag-pill">Sin confirmar</span>
      </div>`;
  }
  return badge(nutriente, Math.round(valorPorcion), densidad100g, true);
}

// Cuántos gramos hay que sacarle al ingrediente que más aporta para que el
// nutriente vuelva a verde, medido contra la densidad del plato (tabla por
// 100 g), donde sacar gramos también baja el peso total.
function gramosASacar(nutriente, modo, ctx, top) {
  const valorPor100 = top.food[nutriente] || 0;
  if (valorPor100 <= 0) return null;

  // El modo "meta", que repartía la meta diaria en 4 comidas, no tenía fuente
  // publicada y se quitó el 2026-09-14.
  const t = LIMITES && LIMITES.plato_por_100g && LIMITES.plato_por_100g[nutriente];
  if (!t) return null;
  const objetivo = t.verde;
  if (valorPor100 <= objetivo) return null;
  const g = (100 * ctx.totales[nutriente] - objetivo * ctx.totalGramos) / (valorPor100 - objetivo);
  return g > 0 ? Math.ceil(g) : null;
}

// Categorías donde proponer un reemplazo no tiene sentido: nadie cambia el
// caldo en cubo "por miel" aunque la miel tenga menos sodio. Para estas, el
// consejo correcto es usar menos o no agregarlo.
const CATEGORIAS_SIN_REEMPLAZO = new Set(["Condimento", "Bebida", "Postre", "Plato preparado"]);

// Reemplazos posibles: alimentos de la MISMA categoría con bastante menos de
// ese nutriente. Salen de nutrientes.json, así que la cifra que ve el paciente
// es auditable.
//
// La regla clave es que un reemplazo NO puede empeorar ninguno de los otros
// nutrientes vigilados. Sin eso, la primera versión llegó a proponer cambiar
// papa (6 mg de sodio) por aceituna (735 mg) solo porque la aceituna tiene
// menos potasio: bajaba un semáforo y disparaba otro.
function alternativasMasBajas(nutriente, top, idsEnReceta) {
  if (CATEGORIAS_SIN_REEMPLAZO.has(top.food.categoria)) return [];
  const valorTop = top.food[nutriente] || 0;
  const otros = NUTRIENTES_ALARMA.filter((n) => n !== nutriente);

  return FOODS.filter((f) => {
    if (f.categoria !== top.food.categoria || f.id === top.food.id) return false;
    if (idsEnReceta.has(f.id)) return false;
    if ((f[nutriente] || 0) > valorTop * 0.6) return false;
    // Ni un miligramo peor en los otros dos: el paciente no puede evaluar el
    // intercambio y confía en que la sugerencia lo deja mejor en todo.
    if (!otros.every((n) => (f[n] || 0) <= (top.food[n] || 0))) return false;
    // Tope calórico: el semáforo no mira grasas, así que sin esto la app
    // llegaba a proponer panceta (518 kcal/100 g) en vez de carne de res (250)
    // porque tiene menos fósforo. Correcto en el nutriente vigilado, mal
    // consejo para un paciente con enfermedad renal crónica.
    const kcalTop = top.food.calorias_kcal;
    const kcalAlt = f.calorias_kcal;
    if (kcalTop != null && kcalAlt != null && kcalAlt > kcalTop * 1.5) return false;
    return true;
  })
    .sort((a, b) => (a[nutriente] || 0) - (b[nutriente] || 0))
    .slice(0, 3);
}

function sugerenciasPara(nutriente, modo, ctx) {
  const conAporte = ctx.aportes
    .map((a) => ({ ...a, aporte: (a.food[nutriente] || 0) * (a.gramos / 100) }))
    .sort((a, b) => b.aporte - a.aporte);
  const top = conAporte[0];
  if (!top || top.aporte <= 0) return [];

  const nombreNutriente = NUTRIENTE_LABEL[nutriente].toLowerCase();
  const pct = Math.round((top.aporte / ctx.totales[nutriente]) * 100);
  const sugerencias = [
    `<strong>${escapeHtml(top.food.nombre)}</strong> aporta el ${pct}% del ${nombreNutriente} de la receta (${Math.round(top.aporte)} mg de ${Math.round(ctx.totales[nutriente])} mg).`,
  ];

  const sacar = gramosASacar(nutriente, modo, ctx, top);
  if (sacar != null && sacar < top.gramos) {
    sugerencias.push(
      `Baja ${escapeHtml(top.food.nombre.toLowerCase())} de ${top.gramos} g a unos <strong>${top.gramos - sacar} g</strong> y el ${nombreNutriente} vuelve a nivel bajo.`
    );
  } else if (sacar != null) {
    sugerencias.push(
      `Ni sacándolo por completo alcanza a bajar a nivel bajo: conviene reemplazarlo, o repartir la receta en más porciones.`
    );
  }

  if (nutriente === "potasio_mg" && LIXIVIABLES.has(top.food.id)) {
    sugerencias.push(
      `Antes de cambiar cantidades, prueba la <strong>doble cocción</strong>: corta ${escapeHtml(top.food.nombre.toLowerCase())} en trozos, remoja al menos 2 horas y cuece en agua nueva abundante, botando esa agua. Suele bajar más el potasio que reducir la porción.`
    );
  }

  const alternativas = alternativasMasBajas(nutriente, top, ctx.idsEnReceta);
  if (alternativas.length) {
    const lista = alternativas
      .map((a) => `<strong>${escapeHtml(a.nombre.toLowerCase())}</strong> (${a[nutriente]} mg/100 g)`)
      .join(", ");
    sugerencias.push(
      `Del mismo grupo de alimentos, con bastante menos ${nombreNutriente} y sin subir los otros: ${lista}. Si alguno te calza en el plato, cambiarlo rinde harto.`
    );
  } else if (CATEGORIAS_SIN_REEMPLAZO.has(top.food.categoria)) {
    sugerencias.push(
      `No hay un reemplazo razonable para ${escapeHtml(top.food.nombre.toLowerCase())}: acá lo que corresponde es usar menos o directamente no agregarlo.`
    );
  }

  if (nutriente === "sodio_mg") {
    sugerencias.push(
      "En sodio, lo que más rinde suele ser no agregar sal ni caldo en cubo: pueden aportar más que todos los demás ingredientes juntos."
    );
  }

  return sugerencias;
}

function analizarRecetaExterna() {
  if (!recetaExterna) return;
  const porcionesInput = document.getElementById("receta-ext-porciones-input");
  const porciones = Math.max(1, Number(porcionesInput && porcionesInput.value) || 1);

  const base = totalesRecetaExterna(porciones);
  const ctx = {
    ...base,
    porciones,
    idsEnReceta: new Set(base.aportes.map((a) => a.food.id)),
  };
  if (ctx.aportes.length === 0) {
    els.recetaExternaAnalisis.hidden = false;
    els.recetaExternaAnalisis.innerHTML = `
      <p class="no-match">No se pudo calcular nada: ninguno de los ingredientes quedó
      reconocido y con cantidad. Corrige los nombres o las cantidades y vuelve a intentar.</p>`;
    return;
  }

  const hayFaltantes = ctx.faltantes.length > 0;
  const densidad = (n) => (ctx.totalGramos > 0 ? (ctx.totales[n] / ctx.totalGramos) * 100 : 0);

  const badges = nutrientesVisibles()
    .map((n) => badgeRecetaExterna(n, ctx.porPorcion[n], densidad(n), hayFaltantes))
    .join("");

  // La alarma se dispara con el primero que quede rojo en el orden de
  // gravedad, no con el que tenga el número más grande: 300 mg de potasio de
  // más pesan clínicamente mucho más que 300 mg de sodio de más.
  const enRojo = NUTRIENTES_ALARMA.filter(
    (n) => clasificar(n, ctx.porPorcion[n], densidad(n), true).nivel === "rojo"
  );
  const alarma = enRojo.length
    ? `<div class="receta-ext-alarma">
         <span class="receta-ext-alarma-icono" aria-hidden="true">⚠️</span>
         <div>
           <strong>${NUTRIENTE_LABEL[enRojo[0]]} muy alto para ti.</strong>
           ${enRojo.length > 1
             ? `También queda alto en ${enRojo.slice(1).map((n) => NUTRIENTE_LABEL[n].toLowerCase()).join(" y ")}.`
             : ""}
           Revisa los cambios de abajo antes de preparar esta receta.
         </div>
       </div>`
    : "";

  const avisoFaltantes = hayFaltantes
    ? `<p class="receta-ext-faltantes">
         No se pudo contar ${ctx.faltantes.length === 1 ? "este ingrediente" : `estos ${ctx.faltantes.length} ingredientes`}:
         ${escapeHtml(ctx.faltantes.join(", "))}. El total real solo puede ser
         <strong>igual o más alto</strong> que el que ves acá.
       </p>`
    : "";

  const bloquesSugerencias = NUTRIENTES_ALARMA
    .map((n) => {
      const { nivel, modo } = clasificar(n, ctx.porPorcion[n], densidad(n), true);
      if (nivel !== "rojo" && nivel !== "amarillo") return "";
      const items = sugerenciasPara(n, modo, ctx);
      if (!items.length) return "";
      return `
        <div class="receta-ext-sugerencia nivel-${nivel}">
          <h4>Para bajar el ${NUTRIENTE_LABEL[n].toLowerCase()}</h4>
          <ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul>
        </div>`;
    })
    .join("");

  els.recetaExternaAnalisis.hidden = false;
  els.recetaExternaAnalisis.innerHTML = `
    ${alarma}
    <p class="portion-note">
      Por porción: ${Math.round(ctx.totalGramos / porciones)} g
      (${porciones} ${porciones === 1 ? "porción" : "porciones"} de ${Math.round(ctx.totalGramos)} g en total).
    </p>
    <div class="semaforo-row">${badges}</div>
    ${notaSinMeta(true)}
    ${avisoFaltantes}
    ${bloquesSugerencias || `<p class="clinical-note">Esta receta te queda bien como está.</p>`}`;
  els.recetaExternaAnalisis.scrollIntoView({ behavior: "smooth", block: "nearest" });
}


async function generarRecetaIA() {
  const ingredientes = candidatosParaIA();
  if (ingredientes.length === 0) {
    abrirChecklistManual();
    setRefrigeradorStatus("Marca al menos un ingrediente en la lista de abajo, o fotografía tu refrigerador.", true);
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
      headers: headersApi({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        ingredientes,
        presupuesto: presupuestoRestanteHoy(),
        densidad_maxima: densidadMaximaSinMeta(),
        situacion_clinica: situacionClinicaParaIA(),
        riesgo_hiperkalemia: riesgoHiperkalemia(),
        robot: robotSeleccionado() ? robotSeleccionado().id : null,
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
// Los sellos de arriba dicen qué tan CONCENTRADA es la receta; esto dice cuánto
// te gasta del límite del día, que es lo que de verdad decide si puedes comerla.
//
// Camilo notó el problema: un paciente ve "Potasio Alto" en una receta que la
// app acaba de proponerle y concluye que no puede comerla — o peor, que la app
// le está sugiriendo algo que le hace daño. Una receta puede ser densa en
// potasio y aun así ocupar un cuarto de su día.
function porcentajeDelDiaHtml(receta) {
  const filas = nutrientesVisibles()
    .map((n) => {
      const meta = metaDiaria(n);
      if (meta == null) return "";
      const valor = Math.round(receta.totales[n] || 0);
      const unidad = n === "carbohidratos_g" ? "g" : "mg";
      const pct = Math.min(100, Math.round((valor / meta) * 100));
      return `
        <div class="receta-dia-fila">
          ${anilloSVG(pct, nivelPorMeta(valor, meta))}
          <div class="receta-dia-texto">
            <span class="calc-label">${NUTRIENTE_LABEL[n]}</span>
            <span class="calc-total">${valor} de ${Math.round(meta)} ${unidad} del día</span>
          </div>
        </div>`;
    })
    .filter(Boolean)
    .join("");

  if (!filas) return "";
  return `
    <div class="receta-dia">
      ${deDondeVieneHtml(receta)}
      <h4>Cuánto ocupa de tu día</h4>
      <p class="clinical-note">Los sellos de arriba dicen qué tan concentrada es la receta.
        Esto dice cuánto te gasta del límite diario, que es lo que decide si puedes comerla.</p>
      <div class="receta-dia-filas">${filas}</div>
    </div>`;
}

// De dónde sale el nutriente más comprometido del plato. Camilo lo pidió con
// un ejemplo que lo explica bien: si a la carne le agregas cebolla y tomate,
// tu exposición al potasio sube — y el paciente no tiene por qué deducirlo de
// una cifra total. Nombrar los dos ingredientes que más aportan convierte el
// número en algo accionable: ya sabe qué reducir.
//
// Los aportes se calculan de nutrientes.json por los gramos que propuso la
// receta, nunca de algo que haya dicho la IA.
function deDondeVieneHtml(receta) {
  const conMeta = nutrientesVisibles().filter((n) => metaDiaria(n) != null);
  if (!conMeta.length) return "";

  // El nutriente que más porcentaje de su meta se lleva.
  const critico = conMeta
    .map((n) => ({ n, pct: (receta.totales[n] || 0) / metaDiaria(n) }))
    .sort((a, b) => b.pct - a.pct)[0];
  if (!critico || critico.pct < 0.25) return "";

  const aportes = (receta.ingredientes || [])
    .map((i) => {
      const food = FOODS.find((f) => f.id === i.id);
      const gramos = Number(i.gramos) || 0;
      if (!food || food[critico.n] == null) return null;
      return { nombre: food.nombre, aporte: (food[critico.n] * gramos) / 100 };
    })
    .filter(Boolean)
    .sort((a, b) => b.aporte - a.aporte);

  const total = aportes.reduce((acc, a) => acc + a.aporte, 0);
  if (total <= 0) return "";

  const top = aportes.slice(0, 2).filter((a) => a.aporte / total >= 0.15);
  if (!top.length) return "";

  const partes = top.map((a) => `${escapeHtml(a.nombre)} (${Math.round(a.aporte / total * 100)}%)`);
  return `
    <p class="receta-de-donde">
      El ${escapeHtml(NUTRIENTE_LABEL[critico.n].toLowerCase())} de este plato viene sobre todo de
      ${partes.join(" y ")}. Si quieres bajarlo, es por ahí.
    </p>`;
}

// calculado por su cuenta — mismo criterio que el resto de la app.
// `yaGuardada` marca las recetas que el paciente vuelve a abrir desde su
// lista: se muestran igual (semáforo, pasos, bloque del robot, botón de
// copiar) pero sin ofrecer guardarlas de nuevo, para no duplicarlas.
function renderRecetaIA(receta, { yaGuardada = false } = {}) {
  els.refrigeradorRecetaIa.hidden = false;
  // También para una receta guardada: es la que está a la vista, y de ella
  // sale el texto del botón "Copiar receta".
  recetaActualIA = receta;
  const totales = receta.totales || {};
  const densidad100g = (n) => (receta.total_gramos > 0 ? (totales[n] / receta.total_gramos) * 100 : 0);
  const valorPorcion = (n) => Math.round(totales[n] || 0);
  const semaforo = nutrientesVisibles()
    .map((n) => badge(n, valorPorcion(n), densidad100g(n), true))
    .join("");

  // El consejo de la IA solo se muestra si el semáforo REAL (recalculado con
  // datos auditados, no lo que haya dicho la IA) efectivamente marca medio o
  // alto en algo — evita mostrar una sugerencia de mejora cuando en realidad
  // todo ya está bien.
  const algoElevado = nutrientesVisibles().some(
    (n) => ["amarillo", "rojo"].includes(clasificar(n, valorPorcion(n), densidad100g(n), true).nivel)
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
      ${porcentajeDelDiaHtml(receta)}
      ${notaSinMeta(true)}
      ${consejoHtml}
      <ol class="refrigerador-receta-lista">${pasos}</ol>
      ${pasosRobotHtml(receta)}
      ${
        yaGuardada
          ? `<p class="receta-ia-guardada-nota">Guardada el ${fechaRecetaGuardada(receta.guardadaEn)} en este dispositivo.</p>`
          : `<button id="receta-ia-guardar-btn" class="btn btn-secondary btn-guardar-receta">Guardar receta</button>`
      }
    </div>`;
  const guardarBtn = document.getElementById("receta-ia-guardar-btn");
  if (guardarBtn) guardarBtn.addEventListener("click", guardarRecetaIA);
  const copiarBtn = document.getElementById("robot-copiar-btn");
  if (copiarBtn) copiarBtn.addEventListener("click", copiarRecetaRobot);
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

function fechaRecetaGuardada(iso) {
  const fecha = new Date(iso);
  if (isNaN(fecha)) return "";
  return fecha.toLocaleDateString("es-CL", { day: "numeric", month: "short" });
}

// Volver a abrir una receta guardada. Se vuelve a dibujar con el mismo render
// de la receta generada, así que el paciente ve otra vez el semáforo, los
// pasos y —si la receta se generó con un robot— el bloque de esa máquina con
// sus tiempos y velocidades, aunque hoy tenga otro robot seleccionado (o
// ninguno): esos datos vienen de la receta guardada, no del perfil.
function abrirRecetaGuardada(idx) {
  const receta = loadRecetasGuardadas()[idx];
  if (!receta) return;
  renderRecetaIA(receta, { yaGuardada: true });
  els.refrigeradorRecetaIa.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function eliminarRecetaGuardada(idx) {
  const arr = loadRecetasGuardadas();
  const [eliminada] = arr.splice(idx, 1);
  localStorage.setItem(RECETAS_GUARDADAS_STORAGE_KEY, JSON.stringify(arr));
  renderRecetasGuardadas();
  // Si la receta borrada era justo la que estaba abierta, se cierra: dejarla
  // a la vista con el cartel "Guardada el ..." sería mentira.
  if (eliminada && recetaActualIA && recetaActualIA.guardadaEn === eliminada.guardadaEn) {
    els.refrigeradorRecetaIa.hidden = true;
    els.refrigeradorRecetaIa.innerHTML = "";
    recetaActualIA = null;
  }
}

function renderRecetasGuardadas() {
  const arr = loadRecetasGuardadas();
  els.recetasGuardadasWrap.hidden = arr.length === 0;
  if (arr.length === 0) return;

  els.recetasGuardadasList.innerHTML = arr
    .map((r, idx) => {
      const fecha = fechaRecetaGuardada(r.guardadaEn);
      return `
        <div class="receta-guardada-item">
          <button class="receta-guardada-abrir" id="receta-guardada-abrir-${idx}" aria-label="Ver la receta ${escapeHtml(r.nombre)}">
            <span>${escapeHtml(r.nombre)}<span class="receta-guardada-fecha">Guardada el ${fecha}</span></span>
            <span class="receta-guardada-flecha" aria-hidden="true">›</span>
          </button>
          <button class="super-item-quitar" id="receta-guardada-quitar-${idx}" aria-label="Eliminar receta guardada">✕</button>
        </div>`;
    })
    .join("");

  arr.forEach((_, idx) => {
    document.getElementById(`receta-guardada-abrir-${idx}`).addEventListener("click", () => abrirRecetaGuardada(idx));
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

// Anillo circular tipo "anillo de actividad": el trazo lleno avanza en sentido
// horario desde las 12 (de ahí el rotate(-90deg) en CSS) y lleva el color de
// severidad (verde/ámbar/rojo); la pista de fondo queda neutra. El porcentaje
// va al centro para la lectura rápida, pero el valor exacto siempre se ve
// aparte en .calc-total — el color nunca es la única forma de saber dónde
// está el paciente.
const ANILLO_RADIO = 42;
const ANILLO_CIRCUNFERENCIA = 2 * Math.PI * ANILLO_RADIO;

function anilloSVG(pct, nivel) {
  const offset = ANILLO_CIRCUNFERENCIA * (1 - pct / 100);
  return `
    <div class="calc-anillo-wrap">
      <svg class="calc-anillo" viewBox="0 0 100 100" role="img" aria-label="${pct}%">
        <circle class="calc-anillo-track" cx="50" cy="50" r="${ANILLO_RADIO}"></circle>
        <circle class="calc-anillo-relleno nivel-${nivel}" cx="50" cy="50" r="${ANILLO_RADIO}"
          stroke-dasharray="${ANILLO_CIRCUNFERENCIA}" stroke-dashoffset="${offset}"></circle>
      </svg>
      <span class="calc-anillo-valor">${pct}%</span>
    </div>`;
}

function filaCalculadora(nutriente, total, unidad) {
  const meta = metaDiaria(nutriente);
  const label = NUTRIENTE_LABEL[nutriente];
  const icon = NUTRIENTE_ICON[nutriente];
  const totalFmt = unidad === "g" ? Math.round(total * 10) / 10 : Math.round(total);

  if (meta == null) {
    return `
      <div class="calc-fila calc-sin-meta">
        <div class="calc-fila-info">
          <div class="calc-fila-head">
            <span class="calc-icon">${icon}</span>
            <span class="calc-label">${label}</span>
            <span class="calc-total">${totalFmt} ${unidad}</span>
            <span class="tag-neutro">sin meta fijada</span>
          </div>
        </div>
      </div>`;
  }

  const pct = Math.min(100, Math.round((total / meta) * 100));
  const nivel = nivelPorMeta(total, meta);
  const exceso = total > meta
    ? `<p class="calc-exceso">Superaste tu meta por ${Math.round(total - meta)} ${unidad}.</p>` : "";
  return `
    <div class="calc-fila">
      ${anilloSVG(pct, nivel)}
      <div class="calc-fila-info">
        <div class="calc-fila-head">
          <span class="calc-icon">${icon}</span>
          <span class="calc-label">${label}</span>
        </div>
        <span class="calc-total">${totalFmt} / ${Math.round(meta)} ${unidad}</span>
        ${exceso}
      </div>
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
      ${anilloSVG(pct, nivel)}
      <div class="calc-fila-info">
        <div class="calc-fila-head">
          <span class="calc-icon">${ICONO_LIQUIDO}</span>
          <span class="calc-label">Líquidos</span>
        </div>
        <span class="calc-total">${Math.round(total)} / ${Math.round(meta)} ml</span>
        ${exceso}
        ${advertencia}
      </div>
    </div>`;
}

function filaLiquidosSinMeta(total) {
  return `
    <div class="calc-fila calc-sin-meta">
      <div class="calc-fila-info">
        <div class="calc-fila-head">
          <span class="calc-icon">${ICONO_LIQUIDO}</span>
          <span class="calc-label">Líquidos</span>
          <span class="calc-total">${Math.round(total)} ml</span>
          <span class="tag-neutro">sin meta fijada</span>
        </div>
      </div>
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
      acc.calorias_kcal += h.calorias_kcal || 0;
      return acc;
    },
    { potasio_mg: 0, fosforo_mg: 0, sodio_mg: 0, carbohidratos_g: 0, calorias_kcal: 0 }
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
  // Calorías: en diálisis, porque su meta sale del peso que ahí se registra
  // (ver metaDiaria/LIMITES.calorias), o cuando el tratante fijó una meta
  // propia. Sin meta no tiene sentido mostrarlas.
  if (requiereDiuresis() || metaPropia("calorias_kcal") != null) {
    filas.push(filaCalculadora("calorias_kcal", totals.calorias_kcal, "kcal"));
  }

  // En peritoneal se registra lo que toma aunque no haya meta automática.
  const metaLiq = metaLiquidos();
  if (requiereDiuresis() || metaLiq) {
    filas.push(metaLiq
      ? filaLiquidos(totalLiquidosHoy(), metaLiq)
      : filaLiquidosSinMeta(totalLiquidosHoy()));
    els.registroLiquidos.hidden = false;
  } else {
    els.registroLiquidos.hidden = true;
  }

  els.calculadora.innerHTML = filas.join("");
  renderPeso();
}

// Vaso de peso: se llena según qué tan cerca está la ganancia interdialítica
// del máximo recomendado (LIMITES.peso.ganancia_maxima_kg_por_dia por cada día
// entre registros), mismo
// código de color que los anillos (verde/ámbar/rojo). Sin un peso anterior
// con qué comparar (primer registro) se muestra con un poco de contenido,
// sin comparación todavía.
function renderPeso() {
  const activo = requiereDiuresis();
  els.registroPeso.hidden = !activo;
  if (!activo) return;

  const hoy = pesoDeHoy();
  els.pesoManual.value = hoy ? hoy.kg : "";

  const ganancia = gananciaPeso();
  const maxGanancia = gananciaMaximaKg();
  let nivel = "verde";
  let pct = hoy ? 15 : 0;
  if (ganancia != null && maxGanancia) {
    pct = Math.max(0, Math.min(100, Math.round((ganancia / maxGanancia) * 100)));
    nivel = nivelPorMeta(ganancia, maxGanancia);
  }
  els.pesoVasoRelleno.style.height = `${pct}%`;
  els.pesoVasoRelleno.className = `peso-vaso-relleno nivel-${nivel}`;

  if (!hoy) {
    els.pesoDetalle.textContent = "Registra tu peso de hoy para vigilar la ganancia entre sesiones.";
  } else if (ganancia == null) {
    els.pesoDetalle.textContent = `${hoy.kg} kg registrados hoy.`;
  } else {
    const signo = ganancia > 0 ? "+" : "";
    els.pesoDetalle.textContent = `${hoy.kg} kg hoy (${signo}${ganancia} kg desde tu último registro).`;
  }

  const excede = ganancia != null && maxGanancia != null && ganancia > maxGanancia;
  els.pesoAlerta.hidden = !excede;
  if (excede) {
    const dias = diasEntrePesos();
    els.pesoAlerta.textContent = `Ganaste ${ganancia} kg en ${dias} ${dias === 1 ? "día" : "días"}, más de lo recomendado: hasta ${LIMITES.peso.ganancia_maxima_kg_por_dia} kg por día entre sesiones. Coméntaselo a tu equipo tratante.`;
  }
}

function guardarPeso() {
  const kg = Number(els.pesoManual.value);
  if (!kg || kg <= 0) return;
  registrarPeso(kg);
  renderCalculadora();
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

// El modal se usa desde dos listas distintas: los alimentos de una comida
// (pestaña Hoy) y los ingredientes del refrigerador. Antes estaba atado a
// lastAnalysis, así que corregir desde el refrigerador habría reescrito la
// comida del día.
function openModal(itemIndex, lista = "hoy") {
  pendingManualTarget = { lista, idx: itemIndex };
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
  const { lista, idx } = pendingManualTarget;

  if (lista === "refrigerador") {
    // Al corregir hay que mover también la marca del checklist: la casilla del
    // alimento equivocado se desmarca y se marca la del correcto, o el paciente
    // termina con la receta hecha sobre lo que la IA se imaginó.
    const previo = ingredientesIdentificados[idx];
    if (previo) desmarcarEnChecklist(previo.match);
    ingredientesIdentificados[idx] = {
      alimentoIA: previo ? previo.alimentoIA : found.nombre,
      match: found,
      corregido: true,
    };
    marcarIdentificadosEnChecklist([ingredientesIdentificados[idx]]);
    closeModal();
    renderIngredientesIdentificados();
    return;
  }

  lastAnalysis[idx].match = found;
  lastAnalysis[idx].alternativas = [];
  lastAnalysis[idx].confianza = null;
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
    calorias_kcal: item.match.calorias_kcal != null
      ? Math.round(item.match.calorias_kcal * factor) : null,
    // Densidades por 100 g: sin ellas no se puede reclasificar una entrada
    // guardada cuando el nutriente se evalúa por contenido y no por meta.
    por100g: {
      potasio_mg: item.match.potasio_mg,
      fosforo_mg: item.match.fosforo_mg,
      sodio_mg: item.match.sodio_mg,
      carbohidratos_g: item.match.carbohidratos_g,
      calorias_kcal: item.match.calorias_kcal,
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
  // Con el vínculo en pausa (bajó de Platinum) no se envía nada: ver
  // modoTratante().
  if (!nivelSuficiente(NIVEL_MINIMO_TRATANTE)) return;
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

  // Vacío, el historial ocupaba una tarjeta de 168 px para decir que no hay
  // nada. Se colapsa a una línea y se esconde el botón de borrar, que sin
  // contenido tampoco tiene sentido.
  const card = els.historyList.closest(".history-card");
  if (card) card.classList.toggle("history-card-vacio", history.length === 0);

  if (history.length === 0) {
    els.historyList.innerHTML = `<p class="history-empty">Todavía no registras alimentos hoy.</p>`;
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
          <div class="hi-name">${escapeHtml(h.nombre)}</div>
          <div class="hi-meta">${h.porcionG} g · ${time}</div>
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
