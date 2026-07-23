"""Cliente mínimo de Supabase para KidneyChef.

Habla con la API REST autogenerada de Supabase (PostgREST, para las tablas) y
con su API de Auth, usando solo `urllib` — sin el paquete `supabase-py`, para
mantener a `server.py` sin dependencias externas (ver decisión en
`~/.claude/plans/spicy-knitting-thimble.md`).

Este módulo asume que `server.py` ya llamó a `load_dotenv()` antes de
importarlo (así `os.environ` ya tiene las variables del `.env`) — no vuelve a
cargar el archivo por su cuenta.
"""
import datetime
import json
import os
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")


class SupabaseError(RuntimeError):
    """Error al hablar con Supabase (REST de datos o Auth). `status` trae el
    código HTTP cuando viene de una respuesta de error, para que el llamador
    pueda distinguir casos esperados (ej. 409 por choque de código único) de
    fallas reales."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _request(url, method, headers, body=None, timeout=15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise SupabaseError(f"Error de Supabase ({e.code}): {detail}", status=e.code) from e


def _postgrest_request(method, table, params=None, body=None, prefer=None):
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        raise SupabaseError(
            "Falta configurar SUPABASE_URL/SUPABASE_SERVICE_KEY (ver .env.example)."
        )
    query = f"?{urllib.parse.urlencode(params)}" if params else ""
    url = f"{SUPABASE_URL}/rest/v1/{table}{query}"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": prefer or "return=representation",
    }
    return _request(url, method, headers, body)


def _auth_get_user(bearer_token):
    """Valida el token del tratante llamando al propio endpoint de Supabase
    Auth — no hace falta verificar el JWT localmente ni guardar su secreto.
    Devuelve el user (con 'id'/'email') si el token es válido, o None si es
    inválido/expiró (401/403). Cualquier otro error se propaga."""
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise SupabaseError(
            "Falta configurar SUPABASE_URL/SUPABASE_ANON_KEY (ver .env.example)."
        )
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        method="GET",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {bearer_token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return None
        detail = e.read().decode("utf-8", errors="replace")
        raise SupabaseError(f"Error de Supabase Auth ({e.code}): {detail}", status=e.code) from e


# --- pacientes ---------------------------------------------------------

def get_paciente_por_codigo(codigo_cliente):
    rows = _postgrest_request(
        "GET", "pacientes",
        params={"codigo_cliente": f"eq.{codigo_cliente}", "select": "*", "limit": "1"},
    )
    return rows[0] if rows else None


def get_paciente_por_id(paciente_id):
    rows = _postgrest_request(
        "GET", "pacientes",
        params={"id": f"eq.{paciente_id}", "select": "*", "limit": "1"},
    )
    return rows[0] if rows else None


def insert_paciente(codigo_cliente, device_secret_hash):
    rows = _postgrest_request(
        "POST", "pacientes",
        body={"codigo_cliente": codigo_cliente, "device_secret_hash": device_secret_hash},
    )
    return rows[0]


def update_metas_paciente(paciente_id, potasio_mg, fosforo_mg, actualizado_por):
    rows = _postgrest_request(
        "PATCH", "pacientes",
        params={"id": f"eq.{paciente_id}"},
        body={
            "metas_potasio_mg": potasio_mg,
            "metas_fosforo_mg": fosforo_mg,
            "metas_actualizado_por": actualizado_por,
            "metas_actualizado_at": _now_iso(),
        },
    )
    return rows[0] if rows else None


# --- perfiles_tratante ---------------------------------------------------

def insert_perfil_tratante(tratante_id, nombre, tipo):
    # Upsert (por la PK `id`): permite completar el perfil la primera vez y
    # también corregirlo después sin necesitar un endpoint de update aparte.
    rows = _postgrest_request(
        "POST", "perfiles_tratante",
        body={"id": tratante_id, "nombre": nombre, "tipo": tipo},
        prefer="resolution=merge-duplicates,return=representation",
    )
    return rows[0]


def get_perfil_tratante(tratante_id):
    rows = _postgrest_request(
        "GET", "perfiles_tratante",
        params={"id": f"eq.{tratante_id}", "select": "*", "limit": "1"},
    )
    return rows[0] if rows else None


# --- vinculos ------------------------------------------------------------

def insert_vinculo(paciente_id, tratante_id, alias):
    rows = _postgrest_request(
        "POST", "vinculos",
        body={
            "paciente_id": paciente_id,
            "tratante_id": tratante_id,
            "alias": alias,
            "estado": "pendiente",
        },
    )
    return rows[0]


def get_vinculos_por_paciente(paciente_id):
    return _postgrest_request(
        "GET", "vinculos",
        params={"paciente_id": f"eq.{paciente_id}", "select": "*", "order": "creado_at.desc"},
    ) or []


def get_vinculos_por_tratante(tratante_id):
    return _postgrest_request(
        "GET", "vinculos",
        params={"tratante_id": f"eq.{tratante_id}", "select": "*", "order": "creado_at.desc"},
    ) or []


def get_vinculo_por_id(vinculo_id):
    rows = _postgrest_request(
        "GET", "vinculos",
        params={"id": f"eq.{vinculo_id}", "select": "*", "limit": "1"},
    )
    return rows[0] if rows else None


def update_vinculo_estado(vinculo_id, nuevo_estado):
    body = {"estado": nuevo_estado}
    if nuevo_estado == "activo":
        body["confirmado_at"] = _now_iso()
    rows = _postgrest_request(
        "PATCH", "vinculos",
        params={"id": f"eq.{vinculo_id}"},
        body=body,
    )
    return rows[0] if rows else None


def delete_vinculo(vinculo_id):
    _postgrest_request(
        "DELETE", "vinculos", params={"id": f"eq.{vinculo_id}"}, prefer="return=minimal"
    )


def find_vinculo_activo(paciente_id, tratante_id=None):
    params = {"paciente_id": f"eq.{paciente_id}", "estado": "eq.activo", "select": "*", "limit": "1"}
    if tratante_id:
        params["tratante_id"] = f"eq.{tratante_id}"
    rows = _postgrest_request("GET", "vinculos", params=params)
    return rows[0] if rows else None


# --- consumos_diarios ------------------------------------------------------

def upsert_consumo_diario(paciente_id, fecha, potasio_mg, fosforo_mg):
    _postgrest_request(
        "POST", "consumos_diarios",
        body={
            "paciente_id": paciente_id,
            "fecha": fecha,
            "potasio_mg": potasio_mg,
            "fosforo_mg": fosforo_mg,
            "actualizado_at": _now_iso(),
        },
        prefer="resolution=merge-duplicates,return=representation",
    )


def get_consumos_rango(paciente_id, desde, hasta):
    # PostgREST permite repetir la misma columna como filtro para armar un
    # rango (AND implícito entre filtros) — de ahí la lista de tuplas en vez
    # de un dict, que no podría tener dos entradas "fecha".
    params = [
        ("paciente_id", f"eq.{paciente_id}"),
        ("fecha", f"gte.{desde}"),
        ("fecha", f"lte.{hasta}"),
        ("select", "*"),
        ("order", "fecha.asc"),
    ]
    return _postgrest_request("GET", "consumos_diarios", params=params) or []
