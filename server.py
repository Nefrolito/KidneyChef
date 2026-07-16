#!/usr/bin/env python3
"""Servidor local para la app KidneyChef.

Sirve los archivos estáticos de public/ y expone POST /api/analyze,
que reenvía la foto a la API de Claude (visión) para identificar el
alimento y estimar la porción, sin exponer la API key al navegador.
"""
import base64
import json
import os
import re
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
PUBLIC_DIR = ROOT / "public"
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"

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
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _cors_headers(self):
        # Permite que la app empaquetada (Capacitor, origen distinto al del
        # servidor) llame a /api/analyze. No hay autenticación de por medio,
        # así que esto no protege contra abuso del API key: ver README.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

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
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            image = payload.get("image")
            if not image:
                self._send_json(400, {"error": "Falta la imagen"})
                return
            items = call_claude_vision(image)
            self._send_json(200, {"items": items})
        except RuntimeError as e:
            self._send_json(500, {"error": str(e)})
        except Exception as e:
            self._send_json(500, {"error": f"Error inesperado: {e}"})


def main():
    load_dotenv()
    port = int(os.environ.get("PORT", 8000))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"KidneyChef corriendo en http://localhost:{port}")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("AVISO: no se encontró ANTHROPIC_API_KEY. Crea un archivo .env (ver .env.example).")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
