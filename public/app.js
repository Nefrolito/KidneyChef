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
// tratante/config.js). Mientras estén vacías, initRevenueCat() no hace nada
// y la app sigue funcionando solo con el trial local ya implementado.
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

// Copy y precios de referencia para el selector de niveles del paywall — se
// muestran mientras no haya una oferta real de RevenueCat cargada (hoy
// siempre, porque las API keys de arriba están vacías). Los precios deben
// coincidir con los configurados en App Store Connect / Google Play.
const NIVELES_INFO = {
  gold: {
    nombre: "Gold",
    precioMensualClp: 5990,
    precioAnualClp: 49990,
    // El Plan Clínico (vínculo con el tratante) NO se ofrece acá mientras
    // MOSTRAR_TAB_TRATANTE sea false: vive entero en esa pestaña, y vender una
    // función que el usuario no puede abrir es motivo de rechazo en la App
    // Store. Cuando la pestaña vuelva, vuelve también este bullet.
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

// Nivel y periodo elegidos en el selector del paywall — ver renderPaywallNiveles().
let paywallNivelSeleccionado = "platinum";
let paywallPeriodoSeleccionado = "mensual"; // "mensual" | "anual"

// Product ID real en App Store Connect / Google Play para el nivel+periodo
// elegidos (com.kidneychef.app.<nivel> mensual, .<nivel>.annual anual).
function productIdSeleccionado() {
  const sufijo = paywallPeriodoSeleccionado === "anual"
    ? `${paywallNivelSeleccionado}.annual`
    : paywallNivelSeleccionado;
  return `com.kidneychef.app.${sufijo}`;
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
      const idProducto = productIdSeleccionado();
      const paquete = current?.availablePackages?.find((pkg) => pkg.product?.identifier === idProducto);
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

// Refleja en perfil.suscripcion.nivel el entitlement real de RevenueCat (el
// más alto entre los activos, o null si no hay ninguno). Se guarda en
// localStorage (no solo en memoria) para que el paywall pueda evaluarse en
// el siguiente arranque sin depender de que la llamada a RevenueCat ya haya
// vuelto.
async function sincronizarSuscripcionRevenueCat() {
  try {
    const Purchases = window.Capacitor.Plugins.Purchases;
    const { customerInfo } = await Purchases.getCustomerInfo();
    const activos = customerInfo?.entitlements?.active || {};
    const nivel = NIVELES_SUSCRIPCION.find((id) => Boolean(activos[id])) || null;
    const perfil = ensurePerfil();
    perfil.suscripcion.nivel = nivel;
    guardarPerfil(perfil);
    renderSuscripcion();
    renderPlan();
    // Las funciones de Diamond tienen que aparecer (o desaparecer) sin que el
    // paciente reinicie la app cuando el nivel acaba de cambiar.
    renderRobotSelector();
    renderRevisarReceta();
  } catch (e) {
    console.warn("No se pudo sincronizar el estado de suscripción de RevenueCat", e);
  }
}

// true si el nivel de suscripción activo (o el trial, que da acceso
// completo) alcanza el mínimo pedido. Todavía no hay ninguna feature en la
// app que llame a esto — hoy el paywall sigue siendo por-app, no por-tier —
// pero es la comparación de rangos que va a necesitar cada feature exclusiva
// de Platinum/Diamond (refrigerador, Súper, Cookidoo) cuando se gatee.
function nivelSuficiente(minimo) {
  const { enTrial, bloqueado } = estadoSuscripcion();
  if (enTrial && !bloqueado) return true;
  const nivel = ensurePerfil().suscripcion.nivel;
  const rango = nivel ? RANGO_NIVEL[nivel] : 0;
  return rango >= RANGO_NIVEL[minimo];
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

function abrirEdicionClinica() {
  els.editarClinicoOverlay.hidden = false;
}

function cerrarEdicionClinica() {
  els.editarClinicoOverlay.hidden = true;
}

function confirmarDatosClinicos() {
  const perfil = ensurePerfil();
  perfil.confirmacionClinica = { confirmado: true, confirmadoEn: new Date().toISOString() };
  guardarPerfil(perfil);
  els.editarClinicoOverlay.hidden = true;
  renderEtapaBadge();
  irATab("hoy");
}

// Suscripción: toda la app es gratis por TRIAL_DIAS desde la primera vez que
// se abre (perfil.creadoEn), y de ahí en adelante requiere perfil.suscripcion.nivel
// (hoy siempre null — se completa cuando se conecte el SDK de compras real).
// 3 niveles con precio fijo (Gold/Platinum/Diamond, ver NIVELES_INFO) en vez
// de un SKU único cuyo precio sube con el tiempo.
const TRIAL_DIAS = 30;

function estadoSuscripcion() {
  const perfil = ensurePerfil();
  const diasTranscurridos = Math.floor(
    (Date.now() - new Date(perfil.creadoEn).getTime()) / 86400000
  );
  const diasRestantes = Math.max(0, TRIAL_DIAS - diasTranscurridos);
  const enTrial = diasRestantes > 0;
  const bloqueado = !enTrial && !perfil.suscripcion.nivel;
  return { diasRestantes, enTrial, bloqueado };
}

function renderSuscripcion() {
  const { bloqueado } = estadoSuscripcion();

  els.paywallOverlay.hidden = !bloqueado;
  if (bloqueado) renderPaywallNiveles();

  // Los días de prueba los arma renderBanner(), que además rota el consejo.
  renderBanner();
}

// Dibuja el toggle mensual/anual y las 3 tarjetas de nivel del paywall según
// paywallNivelSeleccionado / paywallPeriodoSeleccionado, y actualiza el botón
// de suscribirse con el nivel y precio elegidos.
function renderPaywallNiveles() {
  els.paywallPeriodoToggle.querySelectorAll(".paywall-periodo-btn").forEach((btn) => {
    const activo = btn.dataset.periodo === paywallPeriodoSeleccionado;
    btn.classList.toggle("activo", activo);
    btn.setAttribute("aria-pressed", String(activo));
  });

  els.paywallNiveles.innerHTML = Object.entries(NIVELES_INFO)
    .map(([id, info]) => {
      const precio = paywallPeriodoSeleccionado === "anual" ? info.precioAnualClp : info.precioMensualClp;
      const sufijo = paywallPeriodoSeleccionado === "anual" ? "/año" : "/mes";
      const seleccionado = id === paywallNivelSeleccionado;
      return `
        <button type="button" class="paywall-nivel${seleccionado ? " seleccionado" : ""}" data-nivel="${id}" aria-pressed="${seleccionado}">
          ${id === "platinum" ? '<span class="paywall-nivel-badge">Recomendado</span>' : ""}
          <span class="paywall-nivel-nombre">${info.nombre}</span>
          <span class="paywall-nivel-precio">$${precio.toLocaleString("es-CL")}<small>${sufijo}</small></span>
          <ul class="paywall-nivel-features">${info.features.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
        </button>
      `;
    })
    .join("");

  const infoSeleccionado = NIVELES_INFO[paywallNivelSeleccionado];
  const precioSeleccionado = paywallPeriodoSeleccionado === "anual" ? infoSeleccionado.precioAnualClp : infoSeleccionado.precioMensualClp;
  const sufijoBtn = paywallPeriodoSeleccionado === "anual" ? "/año" : "/mes";
  els.paywallSuscribirBtn.textContent =
    `Suscribirme a ${infoSeleccionado.nombre} — $${precioSeleccionado.toLocaleString("es-CL")} CLP ${sufijoBtn}`;
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

// Ganancia de peso interdialítica (kg), o null si no hay un peso anterior
// con qué comparar todavía (primer registro).
function gananciaPeso() {
  const hoy = pesoDeHoy();
  const anterior = pesoAnterior();
  if (!hoy || !anterior) return null;
  return Math.round((hoy.kg - anterior.kg) * 10) / 10;
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

// El badge y "Acerca de" muestran el nivel de suscripción real (RevenueCat:
// gold/platinum/diamond), no perfil.planId — ese es un campo aparte para el
// toggle manual de Plan Clínico (umbrales personalizados, vínculo tratante),
// sin relación con lo que el usuario efectivamente paga.
function renderPlan() {
  const { enTrial, bloqueado } = estadoSuscripcion();
  const nivel = ensurePerfil().suscripcion.nivel;
  const nombreNivel = nivel
    ? NIVELES_INFO[nivel].nombre
    : enTrial && !bloqueado
      ? "Prueba gratis"
      : "Sin suscripción";
  els.planBadge.textContent = nombreNivel;
  els.aboutPlan.textContent = `Tu plan actual: ${nombreNivel}.`;
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
//
// Solo visible en la pestaña "Tratante" (interruptor manual abajo). Queda en
// false para el envío a App Store: el portal del tratante existe y funciona,
// pero su backend (Supabase) está pausado y no hay tratantes reales todavía.
// Ponerlo en true es todo lo que hace falta para volver a probar la pestaña.
const MOSTRAR_TAB_TRATANTE = false;

// Sin infraestructura de push, se refresca por polling mientras la app está
// abierta — así una solicitud de vínculo nueva aparece sin que el paciente
// tenga que cerrar y volver a abrir la app.
const VINCULOS_POLL_MS = 60000;

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
  registroPeso: document.getElementById("registro-peso"),
  pesoManual: document.getElementById("peso-manual"),
  pesoGuardarBtn: document.getElementById("peso-guardar-btn"),
  pesoVasoRelleno: document.getElementById("peso-vaso-relleno"),
  pesoDetalle: document.getElementById("peso-detalle"),
  pesoAlerta: document.getElementById("peso-alerta"),
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
  bannerPista: document.getElementById("banner-pista"),
  paywallOverlay: document.getElementById("paywall-overlay"),
  paywallPeriodoToggle: document.getElementById("paywall-periodo-toggle"),
  paywallNiveles: document.getElementById("paywall-niveles"),
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
  etapaBadgeBtn: document.getElementById("etapa-badge-btn"),
  editarClinicoOverlay: document.getElementById("editar-clinico-overlay"),
  cerrarClinicoBtn: document.getElementById("cerrar-clinico-btn"),
  tabTratanteBtn: document.getElementById("tab-tratante-btn"),
  activarPlanClinico: document.getElementById("activar-plan-clinico"),
  codigoClienteBloque: document.getElementById("codigo-cliente-bloque"),
  codigoClienteValor: document.getElementById("codigo-cliente-valor"),
  copiarCodigoBtn: document.getElementById("copiar-codigo-btn"),
  vinculosPendientes: document.getElementById("vinculos-pendientes"),
  vinculosActivos: document.getElementById("vinculos-activos"),
  metasSincronizadas: document.getElementById("metas-sincronizadas"),
  metaPotasioValor: document.getElementById("meta-potasio-valor"),
  metaFosforoValor: document.getElementById("meta-fosforo-valor"),
  refrigeradorChecklist: document.getElementById("refrigerador-checklist"),
  refrigeradorBuscador: document.getElementById("refrigerador-buscador"),
  refrigeradorSinResultados: document.getElementById("refrigerador-sin-resultados"),
  refrigeradorPreviewWrap: document.getElementById("refrigerador-preview-wrap"),
  refrigeradorPreview: document.getElementById("refrigerador-preview"),
  refrigeradorCameraInput: document.getElementById("refrigerador-camera-input"),
  refrigeradorIdentificarBtn: document.getElementById("refrigerador-identificar-btn"),
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
  els.tabTratanteBtn.hidden = !MOSTRAR_TAB_TRATANTE;
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
  els.editarClinicoOverlay.addEventListener("click", (e) => {
    if (e.target === els.editarClinicoOverlay) cerrarEdicionClinica();
  });
  els.activarPlanClinico.addEventListener("change", activarPlanClinico);
  els.copiarCodigoBtn.addEventListener("click", copiarCodigoCliente);
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
  const tabGuardada = localStorage.getItem(TAB_STORAGE_KEY);
  const tabs = Array.from(els.tabBar.querySelectorAll(".tab-btn"))
    .filter((btn) => !btn.hidden)
    .map((btn) => btn.dataset.tabTarget);
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

function consejoDelDia() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const dayOfYear = Math.floor((new Date() - start) / 86400000);
  return TIPS_DEL_DIA[dayOfYear % TIPS_DEL_DIA.length];
}

// --- Banda de anuncios de arriba --------------------------------------
// El consejo del día ocupaba una tarjeta de 145 px en la pestaña Hoy,
// compitiendo por espacio con lo clínico. Ahora se desplaza en continuo por la
// misma franja que avisa los días de prueba: mismo mensaje, cero altura extra.
//
// La pista lleva el contenido DOS veces y la animación recorre exactamente la
// mitad, así el final empalma con el principio y no se ve el salto.
const BANNER_PX_POR_SEGUNDO = 55;

function mensajesBanner() {
  const { diasRestantes, enTrial, bloqueado } = estadoSuscripcion();
  const mensajes = [];
  if (enTrial && !bloqueado) {
    mensajes.push(
      diasRestantes === 1
        ? "Te queda 1 día de prueba gratis"
        : `Te quedan ${diasRestantes} días de prueba gratis`
    );
  }
  const consejo = consejoDelDia();
  if (consejo) mensajes.push(`💡 ${consejo}`);
  return mensajes;
}

function renderBanner() {
  const { bloqueado } = estadoSuscripcion();
  const mensajes = mensajesBanner();

  els.trialBanner.hidden = bloqueado || mensajes.length === 0;
  if (els.trialBanner.hidden) return;

  const grupo = mensajes.map((m) => `<span class="banner-item">${escapeHtml(m)}</span>`).join("");
  els.bannerPista.innerHTML = grupo + grupo;

  // La duración se calcula desde el ancho real para que la banda avance
  // siempre a la misma velocidad, sea el consejo corto o largo.
  requestAnimationFrame(() => {
    const recorrido = els.bannerPista.scrollWidth / 2;
    if (!recorrido) return;
    els.bannerPista.style.animationDuration = `${recorrido / BANNER_PX_POR_SEGUNDO}s`;
  });
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
      headers: { "Content-Type": "application/json", "X-App-Key": APP_KEY },
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
  const { nivel, modo } = clasificar(nutriente, valorPorcion, densidad100g);
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
  return badge(nutriente, Math.round(valorPorcion), densidad100g);
}

// Cuántos gramos hay que sacarle al ingrediente que más aporta para que el
// nutriente vuelva a verde. Se resuelve distinto según cómo se esté evaluando:
// contra el presupuesto del paciente (modo "meta") o contra la densidad del
// plato (modo "contenido"), donde sacar gramos también baja el peso total.
function gramosASacar(nutriente, modo, ctx, top) {
  const valorPor100 = top.food[nutriente] || 0;
  if (valorPor100 <= 0) return null;

  if (modo === "meta") {
    const meta = metaDiaria(nutriente);
    if (meta == null || !LIMITES) return null;
    const objetivo = umbralPorcion(meta).verde;
    const excesoTotal = (ctx.porPorcion[nutriente] - objetivo) * ctx.porciones;
    if (excesoTotal <= 0) return null;
    return Math.ceil(excesoTotal / (valorPor100 / 100));
  }

  const cfg = nutriente === "potasio_mg" ? LIMITES && LIMITES.potasio
            : nutriente === "fosforo_mg" ? LIMITES && LIMITES.fosforo : null;
  if (!cfg) return null;
  const c = (nutriente === "potasio_mg" && riesgoHiperkalemia() && cfg.clasificacion_contenido_estricta)
    ? cfg.clasificacion_contenido_estricta
    : cfg.clasificacion_contenido;
  const objetivo = c.bajo_hasta;
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
    (n) => clasificar(n, ctx.porPorcion[n], densidad(n)).nivel === "rojo"
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
      const { nivel, modo } = clasificar(n, ctx.porPorcion[n], densidad(n));
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
    ${notaSinMeta()}
    ${avisoFaltantes}
    ${bloquesSugerencias || `<p class="clinical-note">Esta receta te queda bien como está.</p>`}`;
  els.recetaExternaAnalisis.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
      ${pasosRobotHtml(receta)}
      <button id="receta-ia-guardar-btn" class="btn btn-secondary btn-guardar-receta">Guardar receta</button>
    </div>`;
  document.getElementById("receta-ia-guardar-btn").addEventListener("click", guardarRecetaIA);
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
  // Calorías: solo en diálisis, porque su meta depende del peso corporal que
  // ahí se registra (ver metaDiaria/LIMITES.calorias) — no tiene sentido
  // mostrarla sin esa meta.
  if (requiereDiuresis()) {
    filas.push(filaCalculadora("calorias_kcal", totals.calorias_kcal, "kcal"));
  }

  const metaLiq = metaLiquidos();
  if (metaLiq) {
    filas.push(filaLiquidos(totalLiquidosHoy(), metaLiq));
    els.registroLiquidos.hidden = false;
  } else {
    els.registroLiquidos.hidden = true;
  }

  els.calculadora.innerHTML = filas.join("");
  renderPeso();
}

// Vaso de peso: se llena según qué tan cerca está la ganancia interdialítica
// del máximo recomendado (LIMITES.peso.ganancia_maxima_kg_por_defecto), mismo
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
  const maxGanancia = LIMITES ? LIMITES.peso.ganancia_maxima_kg_por_defecto : null;
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
    els.pesoAlerta.textContent = `Ganaste ${ganancia} kg, más de lo recomendado (${maxGanancia} kg/día). Coméntaselo a tu equipo tratante.`;
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
