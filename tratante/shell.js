// Estructura común de las páginas del portal: barra lateral, avatar del
// paciente y un puñado de helpers que antes estaban repetidos en cada
// archivo. Se carga después de config/auth/api y antes del script de la
// página.

const ICONOS = {
  rinon: `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.5C5.5 3.5 4 6 4 9.5c0 4.5 2 8.5 4.5 10.5 1.6 1.3 3.5.4 3.5-1.6v-4"/><path d="M15.5 3.5C18.5 3.5 20 6 20 9.5c0 4.5-2 8.5-4.5 10.5"/></svg>`,
  pacientes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19"/><circle cx="10" cy="8" r="3.2"/><path d="M20 19v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 5.2a3.2 3.2 0 0 1 0 5.6"/></svg>`,
  solicitudes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l2.8 1.7"/></svg>`,
  salir: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 19H6.5A1.5 1.5 0 0 1 5 17.5v-11A1.5 1.5 0 0 1 6.5 5H14"/><path d="M17 15.5 20.5 12 17 8.5M20 12H10"/></svg>`,
  vacio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>`,
  aviso: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 15.8v.2"/></svg>`,
  mas: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  atras: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>`,
};

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatFechaHora(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("es-CL", { dateStyle: "medium", timeStyle: "short" });
}

function formatFecha(iso) {
  if (!iso) return "";
  // Una fecha suelta (AAAA-MM-DD) la interpreta el navegador como UTC y
  // puede correrse un día hacia atrás en Chile: se arma en hora local.
  const soloFecha = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = soloFecha ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" });
}

function tipoTratanteLabel(tipo) {
  if (tipo === "nefrologo") return "Nefrólogo(a)";
  if (tipo === "nutriologo") return "Nutriólogo(a)";
  if (tipo === "nutricionista") return "Nutricionista";
  return "Equipo tratante";
}

// Espejo de TIPOS_MEDICOS en server.py. Acá solo sirve para no mostrar una
// pestaña que el backend va a rechazar igual: la regla vive en Python.
const TIPOS_MEDICOS = ["nefrologo", "nutriologo"];

function esMedico(perfil) {
  return Boolean(perfil) && TIPOS_MEDICOS.includes(perfil.tipo);
}

// Iniciales para el avatar cuando el paciente no subió foto. Usa el alias que
// escribió el propio tratante; si no hay, las primeras letras del código.
function iniciales(texto) {
  const limpio = String(texto || "").trim();
  if (!limpio) return "?";
  const palabras = limpio.split(/[\s—-]+/).filter(Boolean);
  if (palabras.length >= 2) return (palabras[0][0] + palabras[1][0]).toUpperCase();
  return limpio.slice(0, 2).toUpperCase();
}

function avatarHtml(foto, nombre, clase = "") {
  const cls = `avatar ${clase}`.trim();
  if (foto) {
    return `<span class="${cls}"><img src="${escapeHtml(foto)}" alt="Foto de ${escapeHtml(nombre)}"></span>`;
  }
  return `<span class="${cls}" aria-hidden="true">${escapeHtml(iniciales(nombre))}</span>`;
}

// Dibuja la barra lateral dentro de <aside id="sidebar">. `activo` es el id
// del ítem de navegación que corresponde a la página actual.
function renderSidebar({ activo = "", perfil = null, pendientes = 0 } = {}) {
  const aside = document.getElementById("sidebar");
  if (!aside) return;
  const nombre = perfil ? perfil.nombre : "";
  aside.innerHTML = `
    <a class="sidebar-brand" href="index.html">
      <span class="sidebar-brand-logo">${ICONOS.rinon}</span>
      <span>
        <strong>KidneyChef</strong>
        <small>Portal clínico</small>
      </span>
    </a>
    <nav class="sidebar-nav">
      <a class="nav-item" href="index.html" data-nav="pacientes" aria-label="Pacientes" title="Pacientes">
        ${ICONOS.pacientes}<span class="nav-texto">Pacientes</span>
      </a>
      <a class="nav-item" href="index.html#solicitudes" data-nav="solicitudes" aria-label="Solicitudes" title="Solicitudes">
        ${ICONOS.solicitudes}<span class="nav-texto">Solicitudes</span>
        <span class="nav-badge" id="nav-badge-pendientes" hidden></span>
      </a>
    </nav>
    <div class="sidebar-pie">
      <div class="perfil-chip">
        ${avatarHtml(null, nombre || "?", "avatar-sm")}
        <span class="perfil-chip-texto">
          <strong>${escapeHtml(nombre || "Sin perfil")}</strong>
          <small>${escapeHtml(perfil ? tipoTratanteLabel(perfil.tipo) : "")}</small>
        </span>
      </div>
      <button class="nav-item" id="cerrar-sesion-btn" aria-label="Cerrar sesión" title="Cerrar sesión">
        ${ICONOS.salir}<span class="nav-texto">Cerrar sesión</span>
      </button>
    </div>`;

  const actual = aside.querySelector(`[data-nav="${activo}"]`);
  if (actual) actual.setAttribute("aria-current", "page");

  aside.querySelector("#cerrar-sesion-btn").addEventListener("click", () => {
    cerrarSesion();
    location.href = "login.html";
  });

  actualizarBadgePendientes(pendientes);
}

function actualizarBadgePendientes(cantidad) {
  const badge = document.getElementById("nav-badge-pendientes");
  if (!badge) return;
  badge.textContent = cantidad;
  badge.hidden = !cantidad;
  badge.title = cantidad === 1 ? "1 solicitud pendiente" : `${cantidad} solicitudes pendientes`;
}

function estadoVacio(titulo, detalle) {
  return `<div class="vacio">${ICONOS.vacio}<strong>${escapeHtml(titulo)}</strong>${escapeHtml(detalle || "")}</div>`;
}
