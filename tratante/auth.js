// Identidad del tratante: habla DIRECTO con la API de Auth de Supabase (con
// la anon key), sin pasar por server.py — es infraestructura de login, no
// lógica de negocio. server.py valida el access_token después, llamando al
// mismo /auth/v1/user de Supabase (ver require_tratante_auth en server.py).
const AUTH_STORAGE_KEY = "kidneyChefTratanteAuth";

function guardarSesion(sesion) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sesion));
}

function obtenerSesion() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY));
  } catch {
    return null;
  }
}

function cerrarSesion() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function tokenActual() {
  const sesion = obtenerSesion();
  return sesion ? sesion.access_token : null;
}

function requireSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "El portal todavía no tiene configurado SUPABASE_URL/SUPABASE_ANON_KEY en config.js"
    );
  }
}

async function registrarse(email, password) {
  requireSupabaseConfig();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "No se pudo crear la cuenta");
  if (data.access_token) {
    guardarSesion(data);
    return { confirmado: true };
  }
  // Si el proyecto de Supabase exige confirmar el correo, signup no
  // devuelve un token todavía — la cuenta existe pero falta ese paso.
  return { confirmado: false };
}

async function iniciarSesion(email, password) {
  requireSupabaseConfig();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Credenciales inválidas");
  guardarSesion(data);
  return data;
}
