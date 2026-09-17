// Llamadas al backend (server.py) para todo lo que SÍ pasa por lógica de
// negocio en Python: perfil de tratante, vínculos, metas y consumo del
// paciente. El login/signup en sí vive en auth.js, hablando directo con
// Supabase Auth.
async function apiTratante(path, options = {}) {
  const token = tokenActual();
  if (!token) {
    location.href = "login.html";
    throw new Error("No hay sesión activa");
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    cerrarSesion();
    location.href = "login.html";
    throw new Error("Sesión expirada");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error de red (${res.status})`);
  return data;
}

function getPerfilPropio() {
  return apiTratante("/api/tratantes/me");
}

function guardarPerfilPropio(nombre, tipo) {
  return apiTratante("/api/tratantes/perfil", {
    method: "POST",
    body: JSON.stringify({ nombre, tipo }),
  });
}

function listarVinculos() {
  return apiTratante("/api/vinculos");
}

function crearVinculo(codigoCliente, alias) {
  return apiTratante("/api/vinculos", {
    method: "POST",
    body: JSON.stringify({ codigo_cliente: codigoCliente, alias }),
  });
}

function cancelarVinculo(id) {
  return apiTratante(`/api/vinculos/${id}`, { method: "DELETE" });
}

function revocarVinculo(id) {
  return apiTratante(`/api/vinculos/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ estado: "revocado" }),
  });
}

function getMetasPaciente(pacienteId) {
  return apiTratante(`/api/pacientes/${pacienteId}/metas`);
}

// `metas` lleva los nombres que valida server.py (sodio_mg, potasio_mg,
// fosforo_mg, carbohidratos_g, calorias_kcal, liquidos_ml). Un null borra
// esa meta; lo que no se manda queda como está.
function guardarMetasPaciente(pacienteId, metas) {
  return apiTratante(`/api/pacientes/${pacienteId}/metas`, {
    method: "PATCH",
    body: JSON.stringify(metas),
  });
}

function getConsumoPaciente(pacienteId, desde, hasta) {
  return apiTratante(`/api/pacientes/${pacienteId}/consumo?desde=${desde}&hasta=${hasta}`);
}
