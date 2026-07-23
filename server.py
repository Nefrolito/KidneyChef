#!/usr/bin/env python3
"""Servidor local para la app KidneyChef.

Sirve los archivos estáticos de public/ y expone POST /api/analyze,
que reenvía la foto a la API de Claude (visión) para identificar el
alimento y estimar la porción, sin exponer la API key al navegador.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent


def load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


# Se llama acá, antes de leer las constantes de abajo: si se hiciera dentro de
# main() las variables del .env llegarían tarde y se ignorarían en local (en
# Render sí funcionarían, porque ahí vienen del entorno real).
load_dotenv()

# supabase_client lee SUPABASE_* de os.environ a nivel de módulo, así que se
# importa DESPUÉS de load_dotenv() por la misma razón de arriba — si se
# importara antes (ej. en el bloque de imports), leería el entorno vacío.
import supabase_client  # noqa: E402

PUBLIC_DIR = ROOT / "public"
TRATANTE_DIR = ROOT / "tratante"
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

# Límites de uso de /api/analyze. Cada análisis cuesta dinero en la API de
# Anthropic, así que estos topes acotan el gasto máximo posible si alguien
# descubre la URL del backend. Se pueden ajustar por variables de entorno sin
# tocar el código (útil para tunear desde el dashboard de Render).
RATE_LIMIT_PER_IP = int(os.environ.get("RATE_LIMIT_PER_IP", 20))
RATE_LIMIT_PER_IP_WINDOW = int(os.environ.get("RATE_LIMIT_PER_IP_WINDOW", 3600))
RATE_LIMIT_GLOBAL = int(os.environ.get("RATE_LIMIT_GLOBAL", 500))
RATE_LIMIT_GLOBAL_WINDOW = int(os.environ.get("RATE_LIMIT_GLOBAL_WINDOW", 86400))

# Clave compartida con la app. No es un secreto real: viaja en el bundle del
# cliente y alguien técnico puede extraerla. Sirve para frenar el uso casual de
# quien descubra la URL del backend. Si queda vacía, no se exige (así el
# desarrollo local funciona sin configurar nada).
APP_KEY = os.environ.get("APP_KEY", "")

# Tope de tamaño del body. Las fotos llegan como data URL en base64; 8 MB da
# holgura para una foto de celular y evita que alguien mande payloads enormes.
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", 8 * 1024 * 1024))

KNOWN_FOODS = json.loads((PUBLIC_DIR / "nutrientes.json").read_text())
KNOWN_FOODS_LIST = ", ".join(f["nombre"] for f in KNOWN_FOODS)

PROMPT = f"""Eres un asistente que identifica alimentos en fotografías para una app de \
nutrición renal usada por pacientes con enfermedad renal crónica. La precisión importa: \
una identificación incorrecta puede llevar a una estimación de potasio/fósforo/sodio \
equivocada. Mira la imagen con cuidado, fijándote en color, textura, forma, y el contexto \
del plato, antes de responder.

Responde EXCLUSIVAMENTE con un array JSON válido (sin texto adicional, sin bloques de \
código markdown), con esta forma:

[{{"alimento": "nombre del alimento", "porcion_g": numero_estimado_de_gramos, \
"confianza": numero_entre_0_y_1, "alternativas": ["otro nombre posible", "..."]}}]

Reglas:
- Incluye un objeto por cada alimento distinto que identifiques en la foto (máximo 6).
- Siempre que el alimento corresponda razonablemente a uno de esta lista conocida, usa \
EXACTAMENTE ese nombre (coincidencia exacta de texto): {KNOWN_FOODS_LIST}.
- Si no corresponde a ninguno de la lista, usa un nombre genérico simple en español (sin \
marcas ni preparaciones muy específicas).
- "confianza" debe reflejar tu certeza real: usa un valor bajo (menos de 0.5) si el \
alimento es ambiguo, está parcialmente oculto, o podrías estar confundiéndolo con algo \
visualmente similar.
- "alternativas": incluye 1-2 nombres de la lista conocida que también podrían encajar si \
no estás seguro (deja el array vacío si tienes alta confianza).
- Estima la porción visible en gramos según el tamaño aparente del alimento en la imagen."""


class RateLimiter:
    """Ventana deslizante en memoria, con tope por IP y tope global.

    El tope por IP reparte el uso entre pacientes y frena el abuso accidental
    (por ejemplo, apretar el botón muchas veces). El tope global es el que
    realmente acota el gasto: la IP del cliente se lee de X-Forwarded-For, que
    es falsificable, así que un atacante decidido podría rotar IPs falsas —
    pero no puede pasarse del tope global.

    El estado vive en memoria y el servidor es multi-hilo (ThreadingHTTPServer),
    así que todo acceso va bajo lock.
    """

    def __init__(self, per_ip_limit, per_ip_window, global_limit, global_window):
        self.per_ip_limit = per_ip_limit
        self.per_ip_window = per_ip_window
        self.global_limit = global_limit
        self.global_window = global_window
        self._lock = threading.Lock()
        self._by_ip = {}
        self._global = deque()
        self._last_sweep = time.time()

    @staticmethod
    def _trim(bucket, cutoff):
        while bucket and bucket[0] < cutoff:
            bucket.popleft()

    @staticmethod
    def _retry_after(bucket, window, now):
        # Si el tope está en 0 la cola queda vacía y no hay un "más antiguo"
        # del que calcular la espera: en ese caso se devuelve la ventana entera.
        if not bucket:
            return window
        return int(bucket[0] + window - now) + 1

    def _sweep(self, now):
        """Descarta IPs sin actividad reciente para que la memoria no crezca sin tope."""
        if now - self._last_sweep < 300:
            return
        self._last_sweep = now
        cutoff = now - self.per_ip_window
        for ip in [ip for ip, b in self._by_ip.items() if not b or b[-1] < cutoff]:
            del self._by_ip[ip]

    def check(self, ip):
        """Registra un uso si hay cupo.

        Devuelve (permitido, segundos_para_reintentar, motivo).
        """
        now = time.time()
        with self._lock:
            self._sweep(now)

            self._trim(self._global, now - self.global_window)
            if len(self._global) >= self.global_limit:
                retry = self._retry_after(self._global, self.global_window, now)
                return False, retry, "global"

            bucket = self._by_ip.setdefault(ip, deque())
            self._trim(bucket, now - self.per_ip_window)
            if len(bucket) >= self.per_ip_limit:
                retry = self._retry_after(bucket, self.per_ip_window, now)
                return False, retry, "ip"

            bucket.append(now)
            self._global.append(now)
            return True, 0, None


RATE_LIMITER = RateLimiter(
    RATE_LIMIT_PER_IP, RATE_LIMIT_PER_IP_WINDOW,
    RATE_LIMIT_GLOBAL, RATE_LIMIT_GLOBAL_WINDOW,
)


def format_espera(segundos):
    """Texto amigable para el mensaje de error del 429."""
    if segundos < 60:
        return "menos de un minuto"
    minutos = segundos // 60
    if minutos < 60:
        return f"{minutos} minuto{'s' if minutos != 1 else ''}"
    horas = minutos // 60
    return f"{horas} hora{'s' if horas != 1 else ''}"


def call_claude_vision(data_url):
    match = re.match(r"^data:(image/\w+);base64,(.+)$", data_url, re.DOTALL)
    if not match:
        raise ValueError("Formato de imagen inválido")
    media_type, b64data = match.group(1), match.group(2)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta ANTHROPIC_API_KEY. Crea un archivo .env en la raíz del proyecto "
            "con la línea: ANTHROPIC_API_KEY=tu_api_key"
        )

    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64data}},
                {"type": "text", "text": PROMPT},
            ],
        }],
    }).encode("utf-8")

    req = urllib.request.Request(ANTHROPIC_URL, data=body, method="POST", headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Error de la API de Claude ({e.code}): {detail}") from e

    text = "".join(
        block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text"
    ).strip()

    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()

    try:
        items = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"No se pudo interpretar la respuesta de la IA: {text[:300]}") from e

    if not isinstance(items, list):
        raise RuntimeError("La IA no devolvió una lista de alimentos")
    return items


# --- Identidad del paciente (código de cliente + secreto de dispositivo) ---
# El paciente no tiene login tradicional: se identifica con un código corto
# que comparte con su tratante, y el celular guarda un secreto de alta
# entropía que autentica ese dispositivo específico sin pedir contraseña.

# Sin 0/O/1/I: el código se transcribe a mano (el paciente se lo dicta o
# muestra a su tratante), y esos caracteres se confunden fácilmente.
CODIGO_CLIENTE_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODIGO_CLIENTE_LONGITUD = 8


def generar_codigo_cliente():
    return "".join(
        secrets.choice(CODIGO_CLIENTE_ALFABETO) for _ in range(CODIGO_CLIENTE_LONGITUD)
    )


def generar_device_secret():
    return secrets.token_urlsafe(32)


def hash_device_secret(secret):
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def verificar_device_secret(secret, hash_guardado):
    return hmac.compare_digest(hash_device_secret(secret), hash_guardado)


def require_device_secret(handler):
    """Autentica al paciente por X-Codigo-Cliente + X-Device-Secret.

    Devuelve la fila de `pacientes` si son válidos, o None (el llamador debe
    responder 401)."""
    codigo = handler.headers.get("X-Codigo-Cliente", "")
    secret = handler.headers.get("X-Device-Secret", "")
    if not codigo or not secret:
        return None
    paciente = supabase_client.get_paciente_por_codigo(codigo)
    if not paciente or not verificar_device_secret(secret, paciente["device_secret_hash"]):
        return None
    return paciente


def require_tratante_auth(handler):
    """Autentica al tratante por su Bearer token de Supabase (se valida
    llamando al endpoint /auth/v1/user de Supabase, sin verificar el JWT
    localmente — ver supabase_client._auth_get_user).

    Devuelve el user de Supabase (con 'id'/'email') si es válido, o None."""
    auth_header = handler.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header[len("Bearer "):].strip()
    if not token:
        return None
    return supabase_client._auth_get_user(token)


# Límite de creación de vínculos por cuenta de tratante: sin esto, alguien
# con una cuenta de tratante podría probar códigos de cliente al azar hasta
# adivinar uno real. Reutiliza la clase RateLimiter tal cual (su "per_ip" es
# en la práctica "por clave", acá la clave es el id del tratante) — el tope
# global queda holgado porque no busca acotar gasto como en /api/analyze,
# solo frenar fuerza bruta de una cuenta individual.
VINCULOS_RATE_LIMIT_POR_TRATANTE = int(os.environ.get("VINCULOS_RATE_LIMIT_POR_TRATANTE", 10))
VINCULOS_RATE_LIMIT_WINDOW = int(os.environ.get("VINCULOS_RATE_LIMIT_WINDOW", 3600))
VINCULOS_RATE_LIMITER = RateLimiter(
    VINCULOS_RATE_LIMIT_POR_TRATANTE, VINCULOS_RATE_LIMIT_WINDOW,
    VINCULOS_RATE_LIMIT_POR_TRATANTE * 1000, VINCULOS_RATE_LIMIT_WINDOW,
)


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".webmanifest": "application/manifest+json",
}


def handle_analyze(handler):
    """POST /api/analyze — reenvía la foto a Claude Vision y devuelve los alimentos."""
    # El orden importa: las peticiones sin clave o mal formadas se rechazan
    # ANTES de tocar el rate limit, para que no consuman el cupo de los
    # pacientes legítimos.
    if APP_KEY:
        provided = handler.headers.get("X-App-Key", "")
        if not hmac.compare_digest(provided, APP_KEY):
            print(f"[auth] rechazado ip={handler._client_ip()}", flush=True)
            handler._send_json(401, {"error": "Acceso no autorizado a la API."})
            return

    try:
        length = int(handler.headers.get("Content-Length", 0))
    except ValueError:
        handler._send_json(400, {"error": "Content-Length inválido"})
        return

    if length > MAX_BODY_BYTES:
        handler._send_json(413, {
            "error": "La imagen es demasiado grande. Intenta con una foto de menor resolución."
        })
        return

    try:
        raw = handler.rfile.read(length)
        payload = json.loads(raw.decode("utf-8"))
        image = payload.get("image")
        if not image:
            handler._send_json(400, {"error": "Falta la imagen"})
            return

        ip = handler._client_ip()
        permitido, retry_after, motivo = RATE_LIMITER.check(ip)
        if not permitido:
            print(
                f"[rate-limit] bloqueado ip={ip} motivo={motivo} retry_after={retry_after}s",
                flush=True,
            )
            espera = format_espera(retry_after)
            if motivo == "global":
                mensaje = (
                    "La app alcanzó su límite de análisis por hoy. "
                    f"Vuelve a intentarlo en {espera}."
                )
            else:
                mensaje = (
                    "Hiciste muchos análisis en poco tiempo. "
                    f"Vuelve a intentarlo en {espera}."
                )
            handler._send_json(429, {"error": mensaje}, {"Retry-After": str(retry_after)})
            return

        items = call_claude_vision(image)
        handler._send_json(200, {"items": items})
    except RuntimeError as e:
        handler._send_json(500, {"error": str(e)})
    except Exception as e:
        handler._send_json(500, {"error": f"Error inesperado: {e}"})


def _leer_body_json(handler):
    """Lee y parsea el body como JSON. Si hay un error de formato, ya responde
    (400/413) y devuelve None — el llamador debe cortar ahí con `if body is
    None: return`. Body vacío se trata como `{}`."""
    try:
        length = int(handler.headers.get("Content-Length", 0))
    except ValueError:
        handler._send_json(400, {"error": "Content-Length inválido"})
        return None
    if length > MAX_BODY_BYTES:
        handler._send_json(413, {"error": "Cuerpo de la petición demasiado grande"})
        return None
    if length == 0:
        return {}
    try:
        raw = handler.rfile.read(length)
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        handler._send_json(400, {"error": "JSON inválido"})
        return None


# --- Paciente: registro y flujo de vínculo --------------------------------

def handle_crear_paciente(handler):
    """POST /api/pacientes — activa el Plan Clínico: genera código de cliente
    + secreto de dispositivo y crea el registro. El secreto se devuelve UNA
    sola vez acá; el celular debe guardarlo, no hay forma de recuperarlo
    después. Protegido con X-App-Key (igual que /api/analyze) porque en este
    punto el paciente todavía no tiene un device_secret propio."""
    if APP_KEY:
        provided = handler.headers.get("X-App-Key", "")
        if not hmac.compare_digest(provided, APP_KEY):
            handler._send_json(401, {"error": "Acceso no autorizado a la API."})
            return

    secret = generar_device_secret()
    secret_hash = hash_device_secret(secret)
    paciente = None
    for _ in range(5):
        codigo = generar_codigo_cliente()
        try:
            paciente = supabase_client.insert_paciente(codigo, secret_hash)
            break
        except supabase_client.SupabaseError as e:
            if e.status == 409:
                continue  # código ya existía, reintenta con uno nuevo
            raise
    if paciente is None:
        handler._send_json(500, {"error": "No se pudo generar un código de cliente único"})
        return
    handler._send_json(201, {"codigo_cliente": paciente["codigo_cliente"], "device_secret": secret})


def handle_get_paciente_me(handler):
    """GET /api/pacientes/me — código propio y metas vigentes."""
    paciente = require_device_secret(handler)
    if not paciente:
        handler._send_json(401, {"error": "Credenciales de dispositivo inválidas"})
        return
    handler._send_json(200, {
        "codigo_cliente": paciente["codigo_cliente"],
        "metasDiarias": {
            "potasio_mg": paciente.get("metas_potasio_mg"),
            "fosforo_mg": paciente.get("metas_fosforo_mg"),
        },
    })


def handle_get_vinculos_paciente(handler):
    """GET /api/pacientes/me/vinculos — pendientes (para aceptar/rechazar) y
    activos (para poder revocar). El nombre/tipo del tratante SÍ se muestra
    acá (a diferencia del alias, que es privado del tratante): es su
    identidad profesional, no un dato del paciente."""
    paciente = require_device_secret(handler)
    if not paciente:
        handler._send_json(401, {"error": "Credenciales de dispositivo inválidas"})
        return
    vinculos = supabase_client.get_vinculos_por_paciente(paciente["id"])
    perfiles_cache = {}
    resultado = []
    for v in vinculos:
        tratante_id = v["tratante_id"]
        if tratante_id not in perfiles_cache:
            perfiles_cache[tratante_id] = supabase_client.get_perfil_tratante(tratante_id) or {}
        perfil = perfiles_cache[tratante_id]
        resultado.append({
            "id": v["id"],
            "estado": v["estado"],
            "creado_at": v["creado_at"],
            "tratante_nombre": perfil.get("nombre"),
            "tratante_tipo": perfil.get("tipo"),
        })
    handler._send_json(200, {"vinculos": resultado})


# Transiciones que el PACIENTE puede disparar sobre un vínculo propio. Nunca
# se puede reactivar uno ya cerrado (revocado/rechazado) — el tratante tendría
# que mandar una solicitud nueva.
TRANSICIONES_VALIDAS_PACIENTE = {
    "pendiente": {"activo", "rechazado"},
    "activo": {"revocado"},
}


def handle_actualizar_vinculo_paciente(handler, id):
    """PATCH /api/pacientes/me/vinculos/{id} — aceptar/rechazar una solicitud
    pendiente, o revocar un vínculo activo. Este es el paso de confirmación
    legal (Ley 20.584): sin este PATCH con estado=activo, el tratante nunca
    llega a ver datos clínicos del paciente."""
    paciente = require_device_secret(handler)
    if not paciente:
        handler._send_json(401, {"error": "Credenciales de dispositivo inválidas"})
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    nuevo_estado = body.get("estado")
    vinculo = supabase_client.get_vinculo_por_id(id)
    if not vinculo or vinculo["paciente_id"] != paciente["id"]:
        handler._send_json(404, {"error": "Vínculo no encontrado"})
        return
    permitidos = TRANSICIONES_VALIDAS_PACIENTE.get(vinculo["estado"], set())
    if nuevo_estado not in permitidos:
        handler._send_json(409, {
            "error": f"No se puede pasar de '{vinculo['estado']}' a '{nuevo_estado}'"
        })
        return
    actualizado = supabase_client.update_vinculo_estado(id, nuevo_estado)
    handler._send_json(200, {"vinculo": actualizado})


# --- Tratante: perfil y flujo de vínculo ----------------------------------

TIPOS_TRATANTE_VALIDOS = {"nefrologo", "nutricionista"}


def handle_crear_perfil_tratante(handler):
    """POST /api/tratantes/perfil — completa nombre/tipo tras el signup de
    Supabase Auth (que solo trae email/password). Upsert: también sirve para
    corregir el perfil más adelante."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    nombre = (body.get("nombre") or "").strip()
    tipo = (body.get("tipo") or "").strip()
    if not nombre or tipo not in TIPOS_TRATANTE_VALIDOS:
        handler._send_json(400, {
            "error": f"Falta nombre, o tipo debe ser uno de: {', '.join(TIPOS_TRATANTE_VALIDOS)}"
        })
        return
    perfil = supabase_client.insert_perfil_tratante(user["id"], nombre, tipo)
    handler._send_json(200, {"perfil": perfil})


def handle_get_tratante_me(handler):
    """GET /api/tratantes/me — 404 si todavía no completó el perfil (así el
    portal sabe cuándo mostrar el paso de "completar perfil")."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    perfil = supabase_client.get_perfil_tratante(user["id"])
    if not perfil:
        handler._send_json(404, {"error": "Falta completar el perfil"})
        return
    respuesta = dict(perfil)
    respuesta["email"] = user.get("email")
    handler._send_json(200, respuesta)


def handle_crear_vinculo(handler):
    """POST /api/vinculos — el tratante ingresa el código de cliente del
    paciente y queda un vínculo en 'pendiente' hasta que el paciente lo
    confirme desde su celular. Con rate limit por cuenta de tratante para que
    no sirva de fuerza bruta contra códigos de paciente."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    permitido, retry_after, _ = VINCULOS_RATE_LIMITER.check(user["id"])
    if not permitido:
        handler._send_json(429, {
            "error": f"Demasiadas solicitudes de vínculo. Intenta de nuevo en {format_espera(retry_after)}."
        }, {"Retry-After": str(retry_after)})
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    codigo = (body.get("codigo_cliente") or "").strip().upper()
    alias = (body.get("alias") or "").strip()
    if not codigo:
        handler._send_json(400, {"error": "Falta el código de cliente"})
        return
    paciente = supabase_client.get_paciente_por_codigo(codigo)
    if not paciente:
        handler._send_json(404, {"error": "No existe un paciente con ese código"})
        return
    try:
        vinculo = supabase_client.insert_vinculo(paciente["id"], user["id"], alias)
    except supabase_client.SupabaseError as e:
        if e.status == 409:
            handler._send_json(409, {"error": "Ya existe una solicitud o vínculo con este paciente"})
            return
        raise
    handler._send_json(201, {"vinculo": vinculo})


def handle_get_vinculos_tratante(handler):
    """GET /api/vinculos — los propios, con el código de cliente (que el
    tratante ya conoce, lo escribió él mismo) pero sin datos clínicos."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    vinculos = supabase_client.get_vinculos_por_tratante(user["id"])
    pacientes_cache = {}
    resultado = []
    for v in vinculos:
        pid = v["paciente_id"]
        if pid not in pacientes_cache:
            pacientes_cache[pid] = supabase_client.get_paciente_por_id(pid) or {}
        resultado.append({
            "id": v["id"],
            "estado": v["estado"],
            "alias": v["alias"],
            "codigo_cliente": pacientes_cache[pid].get("codigo_cliente"),
            "creado_at": v["creado_at"],
            "paciente_id": pid,
        })
    handler._send_json(200, {"vinculos": resultado})


def handle_delete_vinculo(handler, id):
    """DELETE /api/vinculos/{id} — el tratante cancela una solicitud propia
    que sigue 'pendiente' (si ya fue aceptada/rechazada, no aplica)."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    vinculo = supabase_client.get_vinculo_por_id(id)
    if not vinculo or vinculo["tratante_id"] != user["id"]:
        handler._send_json(404, {"error": "Vínculo no encontrado"})
        return
    if vinculo["estado"] != "pendiente":
        handler._send_json(409, {"error": "Solo se puede cancelar una solicitud pendiente"})
        return
    supabase_client.delete_vinculo(id)
    handler._send_json(200, {"ok": True})


def handle_actualizar_vinculo_tratante(handler, id):
    """PATCH /api/vinculos/{id} — el tratante revoca un vínculo ACTIVO de su
    lado (ej. dejó de atender al paciente). Simétrico al revoke que ya tiene
    el paciente sobre el suyo; ninguno de los dos gana permisos que el otro no
    tuviera ya acordado. Cancelar una solicitud pendiente sigue siendo el
    DELETE de arriba, no este PATCH."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    nuevo_estado = body.get("estado")
    vinculo = supabase_client.get_vinculo_por_id(id)
    if not vinculo or vinculo["tratante_id"] != user["id"]:
        handler._send_json(404, {"error": "Vínculo no encontrado"})
        return
    if vinculo["estado"] != "activo" or nuevo_estado != "revocado":
        handler._send_json(409, {"error": "El tratante solo puede revocar un vínculo activo"})
        return
    actualizado = supabase_client.update_vinculo_estado(id, nuevo_estado)
    handler._send_json(200, {"vinculo": actualizado})


def handle_get_metas_paciente(handler, id):
    """GET /api/pacientes/{id}/metas — solo si el tratante tiene un vínculo
    activo con este paciente."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    if not supabase_client.find_vinculo_activo(id, user["id"]):
        handler._send_json(403, {"error": "No tienes un vínculo activo con este paciente"})
        return
    paciente = supabase_client.get_paciente_por_id(id)
    if not paciente:
        handler._send_json(404, {"error": "Paciente no encontrado"})
        return
    handler._send_json(200, {
        "potasio_mg": paciente.get("metas_potasio_mg"),
        "fosforo_mg": paciente.get("metas_fosforo_mg"),
        "actualizado_por": paciente.get("metas_actualizado_por"),
        "actualizado_at": paciente.get("metas_actualizado_at"),
    })


def handle_patch_metas_paciente(handler, id):
    """PATCH /api/pacientes/{id}/metas — solo con vínculo activo; registra
    quién y cuándo hizo el ajuste, para que quede auditable."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    if not supabase_client.find_vinculo_activo(id, user["id"]):
        handler._send_json(403, {"error": "No tienes un vínculo activo con este paciente"})
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    actualizado = supabase_client.update_metas_paciente(
        id, body.get("potasio_mg"), body.get("fosforo_mg"), user["id"]
    )
    handler._send_json(200, {"metas": actualizado})


def handle_upsert_consumo(handler, fecha):
    """PUT /api/pacientes/me/consumo/{fecha} — sube el total del día de
    potasio/fósforo. Solo se acepta si el paciente tiene al menos un vínculo
    activo: antes de eso el consumo se queda solo en el celular, igual que
    hoy — no hay razón para guardar datos de salud en el servidor sin que
    exista una relación clínica real detrás. Esto se valida ACÁ, del lado
    del servidor, no solo confiando en que el cliente no llame el endpoint
    antes de tiempo."""
    paciente = require_device_secret(handler)
    if not paciente:
        handler._send_json(401, {"error": "Credenciales de dispositivo inválidas"})
        return
    if not supabase_client.find_vinculo_activo(paciente["id"]):
        handler._send_json(403, {
            "error": "No hay un vínculo activo con ningún tratante; el consumo no se sincroniza."
        })
        return
    body = _leer_body_json(handler)
    if body is None:
        return
    supabase_client.upsert_consumo_diario(
        paciente["id"], fecha, body.get("potasio_mg"), body.get("fosforo_mg")
    )
    handler._send_json(200, {"ok": True})


def handle_get_consumo_paciente(handler, id):
    """GET /api/pacientes/{id}/consumo?desde=&hasta= — solo con vínculo
    activo del tratante que consulta, para el gráfico del portal."""
    user = require_tratante_auth(handler)
    if not user:
        handler._send_json(401, {"error": "Token inválido o expirado"})
        return
    if not supabase_client.find_vinculo_activo(id, user["id"]):
        handler._send_json(403, {"error": "No tienes un vínculo activo con este paciente"})
        return
    qs = handler.path.split("?", 1)
    query = urllib.parse.parse_qs(qs[1]) if len(qs) > 1 else {}
    desde = (query.get("desde") or [""])[0]
    hasta = (query.get("hasta") or [""])[0]
    if not desde or not hasta:
        handler._send_json(400, {"error": "Faltan los parámetros desde/hasta"})
        return
    consumos = supabase_client.get_consumos_rango(id, desde, hasta)
    handler._send_json(200, {"consumos": consumos})


# Router mínimo: cada ruta es (método HTTP, regex del path, función que recibe
# el Handler y los grupos nombrados del regex como kwargs). Las fases
# siguientes (metas, consumo) solo agregan tuplas acá — no tocan
# do_GET/do_POST/do_PATCH/do_DELETE, que quedan como despachadores genéricos.
ROUTES = [
    ("POST", re.compile(r"^/api/analyze$"), handle_analyze),
    ("POST", re.compile(r"^/api/pacientes$"), handle_crear_paciente),
    ("GET", re.compile(r"^/api/pacientes/me$"), handle_get_paciente_me),
    ("GET", re.compile(r"^/api/pacientes/me/vinculos$"), handle_get_vinculos_paciente),
    ("PATCH", re.compile(r"^/api/pacientes/me/vinculos/(?P<id>[^/]+)$"), handle_actualizar_vinculo_paciente),
    ("POST", re.compile(r"^/api/tratantes/perfil$"), handle_crear_perfil_tratante),
    ("GET", re.compile(r"^/api/tratantes/me$"), handle_get_tratante_me),
    ("POST", re.compile(r"^/api/vinculos$"), handle_crear_vinculo),
    ("GET", re.compile(r"^/api/vinculos$"), handle_get_vinculos_tratante),
    ("DELETE", re.compile(r"^/api/vinculos/(?P<id>[^/]+)$"), handle_delete_vinculo),
    ("PATCH", re.compile(r"^/api/vinculos/(?P<id>[^/]+)$"), handle_actualizar_vinculo_tratante),
    ("GET", re.compile(r"^/api/pacientes/(?P<id>[^/]+)/metas$"), handle_get_metas_paciente),
    ("PATCH", re.compile(r"^/api/pacientes/(?P<id>[^/]+)/metas$"), handle_patch_metas_paciente),
    ("PUT", re.compile(r"^/api/pacientes/me/consumo/(?P<fecha>[^/]+)$"), handle_upsert_consumo),
    ("GET", re.compile(r"^/api/pacientes/(?P<id>[^/]+)/consumo$"), handle_get_consumo_paciente),
]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # flush inmediato: en Render la salida va a un archivo/pipe y sin esto
        # el buffering de Python retrasa los logs hasta que se llena el búfer.
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def _cors_headers(self):
        # Permite que la app empaquetada (Capacitor, origen distinto al del
        # servidor) llame a la API. Los headers custom (X-App-Key y, desde el
        # portal del tratante / vínculo, X-Device-Secret / X-Codigo-Cliente /
        # Authorization) deben ir listados acá: al ser headers no estándar, el
        # navegador manda un preflight OPTIONS antes del request real y sin
        # este permiso el llamador no podría completarlo.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-App-Key, X-Device-Secret, X-Codigo-Cliente, Authorization",
        )

    def _send_json(self, status, obj, extra_headers=None):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self):
        # Render corre detrás de un proxy, así que client_address es la IP del
        # proxy y no la del usuario. El primer valor de X-Forwarded-For es la IP
        # que declara el cliente: sirve para separar usuarios normales, pero es
        # falsificable — por eso el tope global es el resguardo real.
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _dispatch(self, method):
        """Busca en ROUTES una entrada que matchee método+path. Devuelve True
        si encontró una (el handler ya respondió, incluso si fue con un 500),
        False si ninguna matcheó (el llamador decide qué hacer — 404, o caer a
        archivo estático en el caso de GET).

        Si el handler deja escapar una excepción, se responde 500 acá mismo:
        cada handler nuevo no tiene por qué repetir el try/except que
        `handle_analyze` ya traía desde antes del refactor."""
        path = self.path.split("?", 1)[0]
        for route_method, pattern, handler_fn in ROUTES:
            if route_method != method:
                continue
            match = pattern.match(path)
            if match:
                try:
                    handler_fn(self, **match.groupdict())
                except supabase_client.SupabaseError as e:
                    self._send_json(500, {"error": str(e)})
                except Exception as e:
                    self._send_json(500, {"error": f"Error inesperado: {e}"})
                return True
        return False

    def _servir_estatico(self, base_dir, path):
        """Sirve un archivo bajo `base_dir` (public/ o tratante/), con chequeo
        de path-traversal — misma lógica para las dos raíces estáticas."""
        file_path = (base_dir / path.lstrip("/")).resolve()
        if base_dir.resolve() not in file_path.parents and file_path != base_dir.resolve():
            self._send_json(403, {"error": "Prohibido"})
            return
        if not file_path.exists() or not file_path.is_file():
            self._send_json(404, {"error": "No encontrado"})
            return
        content_type = CONTENT_TYPES.get(file_path.suffix, "application/octet-stream")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self._dispatch("GET"):
            return
        path = self.path.split("?", 1)[0]
        # El portal del tratante es una segunda raíz estática, separada de
        # public/ (que es la app del paciente) — mismo estilo sin build ni
        # framework, solo otro directorio.
        if path == "/tratante" or path.startswith("/tratante/"):
            sub_path = path[len("/tratante"):] or "/"
            if sub_path == "/":
                sub_path = "/index.html"
            self._servir_estatico(TRATANTE_DIR, sub_path)
            return
        if path == "/":
            path = "/index.html"
        self._servir_estatico(PUBLIC_DIR, path)

    def do_POST(self):
        if not self._dispatch("POST"):
            self._send_json(404, {"error": "No encontrado"})

    def do_PUT(self):
        if not self._dispatch("PUT"):
            self._send_json(404, {"error": "No encontrado"})

    def do_PATCH(self):
        if not self._dispatch("PATCH"):
            self._send_json(404, {"error": "No encontrado"})

    def do_DELETE(self):
        if not self._dispatch("DELETE"):
            self._send_json(404, {"error": "No encontrado"})


def main():
    port = int(os.environ.get("PORT", 8000))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"KidneyChef corriendo en http://localhost:{port}", flush=True)
    print(
        f"Límites: {RATE_LIMIT_PER_IP} análisis por IP cada {RATE_LIMIT_PER_IP_WINDOW}s, "
        f"{RATE_LIMIT_GLOBAL} en total cada {RATE_LIMIT_GLOBAL_WINDOW}s.",
        flush=True,
    )
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "AVISO: no se encontró ANTHROPIC_API_KEY. Crea un archivo .env (ver .env.example).",
            flush=True,
        )
    if not APP_KEY:
        print(
            "AVISO: APP_KEY vacía, no se exige clave de app (correcto en desarrollo local).",
            flush=True,
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
