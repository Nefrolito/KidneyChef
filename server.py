#!/usr/bin/env python3
"""Servidor local para la app KidneyChef.

Sirve los archivos estáticos de public/ y expone POST /api/analyze,
que reenvía la foto a la API de Claude (visión) para identificar el
alimento y estimar la porción, sin exponer la API key al navegador.
"""
import base64
import hmac
import json
import os
import re
import threading
import time
import urllib.request
import urllib.error
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

PUBLIC_DIR = ROOT / "public"
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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # flush inmediato: en Render la salida va a un archivo/pipe y sin esto
        # el buffering de Python retrasa los logs hasta que se llena el búfer.
        print(f"[{self.log_date_time_string()}] {fmt % args}", flush=True)

    def _cors_headers(self):
        # Permite que la app empaquetada (Capacitor, origen distinto al del
        # servidor) llame a /api/analyze. X-App-Key debe ir listado acá: al ser
        # un header custom, el navegador manda un preflight OPTIONS antes del
        # POST y sin este permiso la app empaquetada no podría analizar.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-App-Key")

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

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        file_path = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if PUBLIC_DIR.resolve() not in file_path.parents and file_path != PUBLIC_DIR.resolve():
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

    def do_POST(self):
        if self.path != "/api/analyze":
            self._send_json(404, {"error": "No encontrado"})
            return

        # El orden importa: las peticiones sin clave o mal formadas se rechazan
        # ANTES de tocar el rate limit, para que no consuman el cupo de los
        # pacientes legítimos.
        if APP_KEY:
            provided = self.headers.get("X-App-Key", "")
            if not hmac.compare_digest(provided, APP_KEY):
                print(f"[auth] rechazado ip={self._client_ip()}", flush=True)
                self._send_json(401, {"error": "Acceso no autorizado a la API."})
                return

        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send_json(400, {"error": "Content-Length inválido"})
            return

        if length > MAX_BODY_BYTES:
            self._send_json(413, {
                "error": "La imagen es demasiado grande. Intenta con una foto de menor resolución."
            })
            return

        try:
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            image = payload.get("image")
            if not image:
                self._send_json(400, {"error": "Falta la imagen"})
                return

            ip = self._client_ip()
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
                self._send_json(429, {"error": mensaje}, {"Retry-After": str(retry_after)})
                return

            items = call_claude_vision(image)
            self._send_json(200, {"items": items})
        except RuntimeError as e:
            self._send_json(500, {"error": str(e)})
        except Exception as e:
            self._send_json(500, {"error": f"Error inesperado: {e}"})


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
