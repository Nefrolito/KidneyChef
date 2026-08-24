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
KNOWN_FOODS_BY_ID = {f["id"]: f for f in KNOWN_FOODS}

NUTRIENTES_RECETA = ["potasio_mg", "fosforo_mg", "sodio_mg", "carbohidratos_g"]

# Para identificar ingredientes de refrigerador (crudos/sin preparar) se
# excluyen los platos chilenos compuestos de KNOWN_FOODS_LIST: son el mismo
# nombre que usaría el reconocimiento de un plato ya servido ("cazuela",
# "empanada de pino"), y sugerírselos a la IA como candidato para una foto de
# ingredientes sueltos la empujaba a adivinar un plato preparado en vez de
# listar cada ingrediente individual.
_RECETAS_IDS = {r["id"] for r in json.loads((PUBLIC_DIR / "recetas.json").read_text())}

# Catálogo de robots de cocina para el "Modo robot" (ver public/robots-cocina.json,
# con la procedencia de cada cifra). El backend lo usa para acotar los pasos que
# escribe la IA a lo que la máquina del paciente puede ejecutar de verdad.
ROBOTS_COCINA = {
    r["id"]: r
    for r in json.loads((PUBLIC_DIR / "robots-cocina.json").read_text())["robots"]
}
INGREDIENTES_CRUDOS_LIST = ", ".join(f["nombre"] for f in KNOWN_FOODS if f["id"] not in _RECETAS_IDS)

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

PROMPT_INGREDIENTES = f"""Eres un asistente que identifica ingredientes y productos de \
alimentos en una fotografía de un refrigerador, despensa o mesón de cocina, para una app de \
nutrición renal usada por pacientes con enfermedad renal crónica. La precisión importa: una \
identificación incorrecta puede llevar a sugerir una receta con un ingrediente equivocado.

A diferencia de una foto de un plato ya servido, acá el paciente muestra ingredientes CRUDOS \
o productos SIN preparar (verduras, carnes, lácteos, abarrotes). Identifica cada ingrediente \
individual que veas — no adivines un plato preparado a partir de ellos.

Responde EXCLUSIVAMENTE con un array JSON válido (sin texto adicional, sin bloques de \
código markdown), con esta forma:

[{{"alimento": "nombre del ingrediente", "confianza": numero_entre_0_y_1, \
"alternativas": ["otro nombre posible", "..."]}}]

Reglas:
- Incluye un objeto por cada ingrediente o producto distinto que identifiques (máximo 8).
- Siempre que el ingrediente corresponda razonablemente a uno de esta lista conocida, usa \
EXACTAMENTE ese nombre (coincidencia exacta de texto): {INGREDIENTES_CRUDOS_LIST}.
- Preferí el nombre del ingrediente crudo o individual (ej. "Pechuga de pollo", "Cebolla") \
en vez de un plato preparado — acá el paciente todavía no ha cocinado nada.
- Si no corresponde a ninguno de la lista, usa un nombre genérico simple en español (sin \
marcas ni preparaciones específicas).
- "confianza" debe reflejar tu certeza real: usa un valor bajo (menos de 0.5) si el \
ingrediente es ambiguo, está parcialmente oculto, o el empaque no deja verlo con claridad.
- "alternativas": incluye 1-2 nombres de la lista conocida que también podrían encajar si \
no estás seguro (deja el array vacío si tienes alta confianza)."""


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


def _call_claude_vision_con_prompt(data_url, prompt):
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
        # Sonnet 5 piensa por defecto (adaptive thinking). Desactivarlo del
        # todo ("disabled") hace que a veces escriba su razonamiento como
        # texto plano antes del JSON en vez de pensar internamente — efort
        # bajo consigue lo mismo (respuestas rápidas, sin pensar de más) sin
        # ese riesgo.
        "output_config": {"effort": "low"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64data}},
                {"type": "text", "text": prompt},
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


def call_claude_vision(data_url):
    return _call_claude_vision_con_prompt(data_url, PROMPT)


def call_claude_vision_ingredientes(data_url):
    return _call_claude_vision_con_prompt(data_url, PROMPT_INGREDIENTES)


# --- Lectura de recetas de terceros ------------------------------------
# El paciente trae una receta que ya tiene (Cookidoo, la app de su robot, un
# libro, la libreta de su mamá) y la app le calcula el semáforo renal.
#
# Deliberadamente NO se guarda ni se devuelve el texto de preparación: de esas
# recetas solo se extrae la lista de ingredientes con sus cantidades, que es lo
# único que la app necesita para calcular. Copiar las instrucciones de una
# receta ajena sería republicar contenido con derechos de otro (Cookidoo es
# contenido pagado de Vorwerk), y no aporta nada al análisis.
#
# El modelo solo TRANSCRIBE y convierte a gramos. Los valores de potasio,
# fósforo y sodio salen después de nutrientes.json en el cliente, nunca de lo
# que el modelo sepa o crea sobre un alimento.

def _build_prompt_leer_receta(texto=None):
    origen = (
        "La receta viene en la imagen adjunta: puede ser la pantalla de Cookidoo o de la "
        "app de un robot de cocina, la página de un libro, o una receta escrita a mano."
        if texto is None else
        f"La receta es esta:\n\n{texto}"
    )

    return f"""Eres un asistente que TRANSCRIBE una receta para una app de nutrición renal \
usada por pacientes con enfermedad renal crónica.

Tu única tarea es extraer los ingredientes con su cantidad en gramos. NO evalúes si la \
receta es sana, NO propongas cambios y NO copies las instrucciones de preparación: el \
análisis lo hace la app con su propia base de datos auditada.

{origen}

Responde EXCLUSIVAMENTE con un JSON válido (sin texto adicional, sin bloques de código \
markdown), con esta forma:

{{"nombre": "nombre de la receta", "porciones": numero o null, \
"ingredientes": [{{"texto": "la línea tal como aparece en la receta", \
"alimento": "nombre de la lista conocida o null", "gramos": numero o null}}]}}

Reglas:
- "alimento": si el ingrediente corresponde razonablemente a uno de esta lista conocida, \
usa EXACTAMENTE ese nombre (coincidencia exacta de texto): {KNOWN_FOODS_LIST}
- Si un ingrediente NO corresponde a ninguno de la lista, deja "alimento" en null. Es \
mucho mejor que forzar una equivalencia dudosa: la app le avisa al paciente qué \
ingredientes no pudo contar, pero no puede detectar una equivalencia mal hecha.
- "gramos": convierte la cantidad de la receta a gramos usando equivalencias caseras \
estándar (por ejemplo "2 cebollas" ≈ 300 g, "1 taza de arroz" ≈ 185 g, "1 cucharadita de \
sal" ≈ 6 g). Si la receta no indica cantidad, deja null.
- No omitas la sal, los caldos concentrados, la salsa de soya ni los embutidos aunque \
aparezcan en cantidades chicas: son justo los que más sodio aportan.
- No incluyas el agua ni el hielo.
- "texto": copia la línea del ingrediente tal cual, para que el paciente pueda revisarla \
y corregirla en la app.
- "porciones": cuántas porciones rinde, solo si la receta lo dice. Si no lo dice, null.
- Máximo 25 ingredientes."""


def _parsear_respuesta_receta(payload):
    text = "".join(
        block.get("text", "") for block in payload.get("content", []) if block.get("type") == "text"
    ).strip()
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        datos = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"No se pudo interpretar la respuesta de la IA: {text[:300]}") from e
    if not isinstance(datos, dict) or not isinstance(datos.get("ingredientes"), list):
        raise RuntimeError("La IA no devolvió una receta con el formato esperado")
    return datos


def call_claude_leer_receta(imagen=None, texto=None):
    """Transcribe una receta (foto o texto pegado) a ingredientes con gramos.

    Devuelve cada ingrediente ya resuelto contra nutrientes.json cuando se pudo
    (`id`), o con `id: null` cuando no hay equivalente confiable — el cliente
    usa esa distinción para no dar nunca un semáforo verde sobre datos
    incompletos."""
    if not imagen and not (texto or "").strip():
        raise ValueError("Hay que mandar una foto de la receta o su texto")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta ANTHROPIC_API_KEY. Crea un archivo .env en la raíz del proyecto "
            "con la línea: ANTHROPIC_API_KEY=tu_api_key"
        )

    prompt = _build_prompt_leer_receta(None if imagen else texto)

    if imagen:
        match = re.match(r"^data:(image/\w+);base64,(.+)$", imagen, re.DOTALL)
        if not match:
            raise ValueError("Formato de imagen inválido")
        contenido = [
            {"type": "image", "source": {"type": "base64",
                                         "media_type": match.group(1), "data": match.group(2)}},
            {"type": "text", "text": prompt},
        ]
    else:
        contenido = prompt

    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 3072,
        "output_config": {"effort": "low"},
        "messages": [{"role": "user", "content": contenido}],
    }).encode("utf-8")

    req = urllib.request.Request(ANTHROPIC_URL, data=body, method="POST", headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            datos = _parsear_respuesta_receta(json.loads(resp.read().decode("utf-8")))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Error de la API de Claude ({e.code}): {detail}") from e

    # El nombre que da el modelo se resuelve acá contra nutrientes.json: al
    # cliente le llega el id exacto o null, no un nombre suelto que tendría que
    # volver a adivinar.
    por_nombre = {f["nombre"].strip().lower(): f["id"] for f in KNOWN_FOODS}
    ingredientes = []
    for item in datos["ingredientes"][:25]:
        if not isinstance(item, dict):
            continue
        nombre = str(item.get("alimento") or "").strip()
        fid = por_nombre.get(nombre.lower())
        try:
            gramos = float(item.get("gramos"))
            gramos = round(gramos) if gramos > 0 else None
        except (TypeError, ValueError):
            gramos = None
        ingredientes.append({
            "texto": str(item.get("texto") or nombre or "").strip()[:120],
            "id": fid,
            "nombre": KNOWN_FOODS_BY_ID[fid]["nombre"] if fid else None,
            "gramos": gramos,
        })

    if not ingredientes:
        raise RuntimeError("No se pudo leer ningún ingrediente de la receta")

    try:
        porciones = int(datos.get("porciones"))
        porciones = porciones if 1 <= porciones <= 30 else None
    except (TypeError, ValueError):
        porciones = None

    return {
        "nombre": str(datos.get("nombre") or "Receta").strip()[:120],
        "porciones": porciones,
        "ingredientes": ingredientes,
    }


# Tamaño de un plato principal para una persona. Sin decírselo, el modelo
# armaba platos de 80-100 g que "cumplían" el presupuesto por ser diminutos —
# y un plato diminuto siempre da semáforo verde, porque el semáforo mide la
# porción. La app ya usa 300 g como porción de referencia de una receta
# (PORCION_REFERENCIA_RECETA_G en public/app.js).
PORCION_OBJETIVO_G = (300, 400)

NUTRIENTE_UNIDAD = {"potasio_mg": "mg", "fosforo_mg": "mg", "sodio_mg": "mg", "carbohidratos_g": "g"}
NUTRIENTE_NOMBRE = {"potasio_mg": "potasio", "fosforo_mg": "fósforo", "sodio_mg": "sodio", "carbohidratos_g": "carbohidratos"}


def _bloque_robot(robot):
    """Instrucciones para que la IA escriba los pasos en el lenguaje de la
    máquina del paciente. Lo que puede o no puede hacer cada robot sale de
    public/robots-cocina.json, no de lo que el modelo recuerde de la marca."""
    if not robot:
        return "", ""

    vel = robot["velocidad"]
    temp = robot["temperatura"]
    vapor = robot.get("vapor") or {}
    reglas = "\n".join(f"- {r}" for r in robot.get("reglas", []))
    inverso = (
        f'- Tiene {vel["nombre_inverso"]}: úsalo cuando haya que remover sin triturar '
        "(guisos, carnes en trozos, verduras cocidas).\n"
        if vel.get("inverso") else
        "- No des por hecho que tiene giro inverso: si un paso necesita remover sin triturar, "
        "indica velocidad muy baja y tiempo corto.\n"
    )

    bloque = f"""

El paciente cocina en un {robot["nombre"]}. Además de los pasos normales, escribe los mismos \
pasos traducidos a esa máquina, respetando EXACTAMENTE estos límites:
- Velocidades: de {vel["min"]} a {vel["max"]}. Para remover suave, {vel["suave"]}.
- Temperatura: de {temp["min_c"]} °C a {temp["max_c"]} °C. Nunca indiques una temperatura \
mayor a {temp["max_c"]} °C, aunque la máquina llegue más arriba.
- En cualquier paso que lleve temperatura, la velocidad NO puede pasar de \
{vel["max_con_calor"]}.
- Para cocinar al vapor, el accesorio se llama "{vapor.get("accesorio", "accesorio de vapor")}".
{inverso}{reglas}

Seguridad alimentaria (esto es obligatorio, el paciente es renal y una infección \
alimentaria le pega más fuerte):
- El pollo, el cerdo, la carne molida, el pescado y el huevo tienen que quedar bien \
cocidos por dentro. Nunca escribas un paso que los deje crudos, jugosos o "a punto".
- No uses cocción a baja temperatura, sous vide ni fermentación para carnes o pescado.
- Para cocinar carnes y pescado usa 100 °C o la temperatura de vapor, con tiempo \
suficiente; si dudas entre dos tiempos, elige el más largo.
- Si la receta lleva papa, zanahoria, zapallo o legumbres, y el consejo menciona la \
doble cocción, refléjalo en los pasos del robot: cocer en agua abundante y botar esa \
agua antes de seguir."""

    forma = (
        ', "pasos_robot": [{"texto": "qué hacer", "minutos": numero, '
        '"temperatura_c": numero o null, "velocidad": "1" (o \"vapor\"/\"turbo\" si aplica), '
        '"inverso": true o false}]'
    )
    return bloque, forma


def _build_prompt_receta(foods, presupuesto, densidad_maxima=None, situacion_clinica=None, riesgo_hiperkalemia=False, robot=None):
    lineas_ingredientes = []
    for f in foods:
        aportes = ", ".join(
            f"{NUTRIENTE_NOMBRE[n]} {f.get(n) or 0}{NUTRIENTE_UNIDAD[n]}" for n in NUTRIENTES_RECETA
        )
        lineas_ingredientes.append(f'- id "{f["id"]}" ({f["nombre"]}): por 100 g tiene {aportes}.')

    if presupuesto:
        lineas_presupuesto = [
            f"- {NUTRIENTE_NOMBRE[n]}: no más de {v}{NUTRIENTE_UNIDAD[n]} en total"
            for n, v in presupuesto.items()
            if n in NUTRIENTES_RECETA
        ]
    else:
        lineas_presupuesto = []
    if not lineas_presupuesto:
        lineas_presupuesto = ["- sin límite numérico fijado: igual arma una porción moderada de una comida, no una olla familiar"]

    # Sin meta personal de potasio/fósforo (paciente sin Plan Clínico), no hay
    # un total que no superar, pero igual existe una guía general de cuánto es
    # "alto" en contenido (mg por 100 g) — sin esto, la IA no tenía con qué
    # comparar para saber si valía la pena avisar, aunque el semáforo del
    # celular sí marcara amarillo/rojo por contenido.
    lineas_densidad = [
        f"- {NUTRIENTE_NOMBRE[n]}: no más de {v}mg por cada 100 g del plato final (sumando todos los ingredientes)"
        for n, v in (densidad_maxima or {}).items()
        if n in NUTRIENTES_RECETA
    ]
    bloque_densidad = (
        f"""

Además, aunque no haya un presupuesto total fijado para estos nutrientes, el equipo \
tratante recomienda en general no superar esta densidad en el plato final:
{chr(10).join(lineas_densidad)}"""
        if lineas_densidad else ""
    )

    # La situación clínica declarada (etapa ERC o modalidad de diálisis) es
    # el pilar de la app: sin esto, la receta generada quedaría idéntica la
    # declare el paciente o no, y esa personalización es justo lo que importa.
    if situacion_clinica and situacion_clinica.get("declarada"):
        bloque_situacion = (
            f"\nSituación clínica declarada por el paciente: {situacion_clinica.get('etiqueta')}. "
            f"{situacion_clinica.get('consideracion')} Ten esto en cuenta al elegir cantidades — "
            "por ejemplo, si la consideración indica que el potasio puede liberalizarse, no seas "
            "más estricto de lo necesario; si indica mayor riesgo o vigilancia, sé más conservador."
        )
    else:
        bloque_situacion = (
            "\nEl paciente no declaró su etapa de enfermedad renal ni si está en diálisis — "
            "usa solo los criterios generales de arriba, sin asumir una situación más grave o más "
            "leve que la que se te indicó."
        )
    if riesgo_hiperkalemia:
        bloque_situacion += (
            " El paciente tiene además factores de riesgo de hiperpotasemia (diabetes o "
            "medicamentos que retienen potasio) — prioriza especialmente mantener el potasio bajo."
        )

    bloque_robot, forma_robot = _bloque_robot(robot)

    return f"""Eres un asistente que arma una receta casera chilena para un paciente con \
enfermedad renal crónica, usando SOLO los ingredientes que tiene disponibles. La precisión \
de las cantidades importa para su salud: si te pasas del presupuesto de un nutriente, el \
paciente puede terminar con niveles peligrosos de potasio o fósforo en la sangre.

Ingredientes disponibles, con su aporte por 100 g:
{chr(10).join(lineas_ingredientes)}

Presupuesto que le queda disponible al paciente hoy (no lo superes):
{chr(10).join(lineas_presupuesto)}{bloque_densidad}
{bloque_situacion}{bloque_robot}

Responde EXCLUSIVAMENTE con un JSON válido (sin texto adicional, sin bloques de código \
markdown), con esta forma:

{{"nombre": "nombre del plato", "pasos": ["paso 1", "paso 2"], \
"ingredientes": [{{"id": "id_exacto_de_la_lista", "gramos": numero}}], \
"consejo": "sugerencia opcional, o cadena vacía"{forma_robot}}}

Reglas:
- Usa solo ids exactos de la lista de ingredientes disponibles — no inventes otros ni \
cambies el texto del id.
- Trata de usar TODOS los ingredientes disponibles en la receta. Solo deja alguno afuera si \
de verdad no combina en un plato coherente, o si incluirlo te hace pasar el presupuesto de \
algún nutriente con límite fijado.
- Antes de responder, suma tú mismo el aporte de los gramos que elegiste para cada \
nutriente con presupuesto fijado, y ajusta las cantidades hasta quedar dentro del límite.
- "consejo": si al sumar los gramos algún nutriente con presupuesto fijado queda usando más \
de la mitad de ese presupuesto, O si la densidad de potasio/fósforo del plato final supera \
la guía de arriba, escribe una sugerencia breve y concreta para bajarlo usando SOLO los \
ingredientes ya disponibles. Para papa, zanahoria, zapallo y legumbres (lentejas, porotos), \
antes de sugerir solo reducir la cantidad, considera sugerir la técnica de remojar en trozos \
por al menos 2 horas (o toda la noche) y cocer en agua nueva abundante, botando el agua de \
cocción — es la técnica de doble cocción que se le enseña al paciente renal para lixiviar \
potasio, y suele bajar más el potasio que reducir la porción. Para carnes/pescado/sodio, \
sigue sugiriendo ajustes de cantidad o evitar sal añadida (ej. "no le agregues sal, el tomate \
y la cebolla ya aportan sodio").
- Si algún nutriente queda directamente por ENCIMA del presupuesto o de la densidad guía (no \
solo cerca — de verdad alto/rojo), identifica cuál de los ingredientes es el que más aporta \
ese nutriente por sí solo, y sugiere en el consejo ELIMINARLO por completo de la receta como \
alternativa (no solo reducirlo) — sobre todo si ni bajándolo a la mitad alcanzaría a dejarlo \
dentro del límite. Sé específico: nombra el ingrediente exacto que conviene sacar y por qué.
- Si todo queda holgado, deja "consejo" como cadena vacía.
- En el "consejo" NO escribas cifras ni porcentajes de nutrientes (nada de "usa el 98% de \
tu potasio" ni "aporta 703 mg"). Los números que ve el paciente los calcula la app sumando \
los valores auditados de su base de datos, y una cifra tuya que no coincida con el semáforo \
que tiene al lado lo confunde y le hace desconfiar de los dos. Escribe la ACCIÓN concreta \
("baja la papa a la mitad", "no le agregues sal", "cuece la papa en agua nueva y bótala"), \
no la aritmética. Sí puedes nombrar gramos de un ingrediente, porque esos los propones tú.
- Si aun cambiando la composición algún nutriente queda POR ENCIMA del presupuesto, dilo \
derecho al principio del consejo ("esta receta se pasa de tu potasio del día") en vez de \
describirla como si cupiera.
- Los nombres de la lista son categorías amplias (ej. "Carne de res", "Pechuga de pollo") y \
no distinguen el corte o la forma exacta del ingrediente (molida, en trozos, entera, etc.). \
No asumas un corte específico que el nombre no aclara — evita preparaciones que solo \
funcionan con un corte particular (ej. "bistec" o "filete" para carne de res genérica); \
preferí preparaciones versátiles que funcionan con cualquier forma del ingrediente (guisos, \
salteados, cazuelas, revueltos).
- Tamaño del plato: arma una porción realista de una comida para una persona, del orden \
de {PORCION_OBJETIVO_G[0]} a {PORCION_OBJETIVO_G[1]} g en total para un plato principal \
(un guiso o una sopa puede ir algo por encima; un acompañamiento, por debajo).
- Si con una porción realista te pasas del presupuesto de algún nutriente, NO achiques el \
plato para que quepa: cambia la COMPOSICIÓN. Baja el ingrediente que más aporta ese \
nutriente y compensa con los que aportan poco, hasta llegar a un plato de tamaño normal \
que sí entre en el presupuesto. Un plato de 80 g que "cumple" no le sirve al paciente: se \
queda con hambre, come otra cosa después, y el semáforo verde que vio no representó su \
comida real.
- Solo si de verdad no hay manera de llegar a una porción realista dentro del presupuesto, \
arma la mayor porción que sí quepa y dilo explícitamente en el "consejo".
- Pasos de preparación breves (máximo 5), en español, para una preparación casera simple."""


def _intentar_llamada_receta(prompt, api_key):
    """Un intento de llamada a Claude + parseo del JSON. Lanza RuntimeError en
    cualquier falla (HTTP, JSON inválido, forma inesperada) para que el
    llamador pueda reintentar."""
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 3072,
        "output_config": {"effort": "low"},
        "messages": [{"role": "user", "content": prompt}],
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
        receta = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"No se pudo interpretar la respuesta de la IA: {text[:300]}") from e

    if not isinstance(receta, dict) or not isinstance(receta.get("ingredientes"), list):
        raise RuntimeError("La IA no devolvió una receta con el formato esperado")

    return receta


def _sanear_pasos_robot(pasos, robot):
    """Los ajustes que devuelve la IA no se muestran tal cual: se recortan a lo
    que la máquina declara en robots-cocina.json. Un modelo puede escribir
    "180 °C velocidad 8" sin que la máquina pueda hacerlo, y ese paso en manos
    del paciente es, en el mejor caso, una receta arruinada.

    Lo importante acá es la combinación calor + velocidad: casi todos estos
    robots desconectan el calentamiento sobre cierta velocidad, así que un paso
    con temperatura y velocidad alta simplemente no calienta."""
    if not robot or not isinstance(pasos, list):
        return []

    vel = robot["velocidad"]
    temp = robot["temperatura"]
    vapor = robot.get("vapor") or {}
    nombre_vapor = (vapor.get("accesorio") or "vapor").lower()

    salida = []
    for paso in pasos[:8]:
        if not isinstance(paso, dict):
            continue
        texto = str(paso.get("texto") or "").strip()
        if not texto:
            continue

        temperatura = paso.get("temperatura_c")
        try:
            temperatura = int(round(float(temperatura)))
        except (TypeError, ValueError):
            temperatura = None
        if temperatura is not None:
            temperatura = max(temp["min_c"], min(temperatura, temp["max_c"]))

        velocidad = str(paso.get("velocidad") or "").strip().lower()
        if velocidad in ("vapor", "varoma", nombre_vapor):
            velocidad = vapor.get("accesorio") or "vapor"
        elif velocidad == "turbo":
            # Turbo con comida caliente es justo lo que los manuales prohíben,
            # y en un robot que no declara turbo tampoco corresponde ofrecerlo:
            # en ambos casos cae al tope de velocidad que sí aplica.
            tope = vel["max_con_calor"] if temperatura is not None else vel["max"]
            velocidad = "turbo" if (vel.get("turbo") and temperatura is None) else str(tope)
        else:
            try:
                n = float(velocidad.replace(",", "."))
            except ValueError:
                n = None
            if n is None:
                velocidad = ""
            else:
                tope = vel["max_con_calor"] if temperatura is not None else vel["max"]
                n = max(vel["min"], min(n, tope))
                velocidad = str(int(n)) if n == int(n) else str(n).replace(".", ",")

        try:
            minutos = int(round(float(paso.get("minutos"))))
        except (TypeError, ValueError):
            minutos = None
        if minutos is not None:
            minutos = max(1, min(minutos, 240))

        salida.append({
            "texto": texto,
            "minutos": minutos,
            "temperatura_c": temperatura,
            "velocidad": velocidad,
            "inverso": bool(paso.get("inverso")) and bool(vel.get("inverso")),
        })

    return salida


def call_claude_receta(ingrediente_ids, presupuesto, densidad_maxima=None, situacion_clinica=None, riesgo_hiperkalemia=False, robot_id=None):
    foods = []
    for fid in ingrediente_ids:
        food = KNOWN_FOODS_BY_ID.get(fid)
        if food is None:
            raise ValueError(f"Ingrediente desconocido: {fid}")
        foods.append(food)
    if not foods:
        raise ValueError("No se recibió ningún ingrediente")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Falta ANTHROPIC_API_KEY. Crea un archivo .env en la raíz del proyecto "
            "con la línea: ANTHROPIC_API_KEY=tu_api_key"
        )

    # Un robot desconocido (o ninguno) simplemente no agrega el bloque: la
    # receta sale igual, solo sin los pasos para máquina.
    robot = ROBOTS_COCINA.get(robot_id) if robot_id else None

    prompt = _build_prompt_receta(foods, presupuesto, densidad_maxima, situacion_clinica, riesgo_hiperkalemia, robot)

    # Sonnet 5 piensa por defecto (adaptive thinking) y con varias
    # restricciones a la vez (presupuesto + densidad + situación + consejo)
    # a veces gasta todo max_tokens pensando y devuelve una respuesta vacía o
    # cortada — "effort": "low" lo hace mucho menos frecuente, pero no lo
    # elimina del todo (es una llamada a un modelo, no determinista).
    # Reintentar una vez antes de fallarle al paciente es más barato que
    # mostrarle un error por algo que la segunda vez sale bien.
    ultimo_error = None
    for intento in range(2):
        try:
            receta = _intentar_llamada_receta(prompt, api_key)
            break
        except RuntimeError as e:
            ultimo_error = e
    else:
        raise ultimo_error

    # El total que ve el paciente SIEMPRE sale de sumar los valores reales de
    # nutrientes.json por los gramos que propuso la IA — nunca de un número
    # que la IA haya calculado o afirmado por su cuenta. Cualquier id que la
    # IA haya inventado (fuera de los ingredientes que le pasamos) se descarta.
    ingredientes_out = []
    totales = {n: 0.0 for n in NUTRIENTES_RECETA}
    total_gramos = 0.0
    for item in receta["ingredientes"]:
        fid = item.get("id")
        food = KNOWN_FOODS_BY_ID.get(fid)
        if food is None or fid not in ingrediente_ids:
            continue
        try:
            gramos = float(item.get("gramos"))
        except (TypeError, ValueError):
            continue
        if gramos <= 0:
            continue
        factor = gramos / 100
        for n in NUTRIENTES_RECETA:
            totales[n] += (food.get(n) or 0) * factor
        total_gramos += gramos
        ingredientes_out.append({"id": fid, "nombre": food["nombre"], "gramos": round(gramos)})

    if not ingredientes_out:
        raise RuntimeError("La IA no propuso cantidades utilizables para los ingredientes recibidos")

    consejo = receta.get("consejo")

    return {
        "nombre": str(receta.get("nombre") or "Receta"),
        "pasos": [str(p) for p in receta.get("pasos", []) if isinstance(p, (str, int, float))][:8],
        "ingredientes": ingredientes_out,
        "totales": {n: round(v, 1) for n, v in totales.items()},
        "total_gramos": round(total_gramos),
        "consejo": str(consejo).strip() if isinstance(consejo, str) and consejo.strip() else None,
        "robot": {"id": robot["id"], "nombre": robot["nombre"]} if robot else None,
        "pasos_robot": _sanear_pasos_robot(receta.get("pasos_robot"), robot),
    }


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


def handle_identificar_ingredientes(handler):
    """POST /api/identificar-ingredientes — como /api/analyze, pero con un
    prompt aparte para ingredientes crudos de refrigerador/despensa en vez de
    un plato ya servido (ver PROMPT_INGREDIENTES). Comparte guardas y cupo con
    /api/analyze porque también llama a la API de Claude y cuesta dinero."""
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
            mensaje = (
                "La app alcanzó su límite de análisis por hoy. "
                f"Vuelve a intentarlo en {espera}."
                if motivo == "global" else
                f"Hiciste muchos análisis en poco tiempo. Vuelve a intentarlo en {espera}."
            )
            handler._send_json(429, {"error": mensaje}, {"Retry-After": str(retry_after)})
            return

        items = call_claude_vision_ingredientes(image)
        handler._send_json(200, {"items": items})
    except RuntimeError as e:
        handler._send_json(500, {"error": str(e)})
    except Exception as e:
        handler._send_json(500, {"error": f"Error inesperado: {e}"})


def handle_generar_receta(handler):
    """POST /api/generar-receta — arma una receta con los ingredientes que el
    paciente tiene, ajustada al presupuesto de nutrientes que le queda en el
    día. Comparte guardas con /api/analyze porque también llama a la API de
    Claude y cuesta dinero: misma clave de app y mismo cupo de uso."""
    if APP_KEY:
        provided = handler.headers.get("X-App-Key", "")
        if not hmac.compare_digest(provided, APP_KEY):
            print(f"[auth] rechazado ip={handler._client_ip()}", flush=True)
            handler._send_json(401, {"error": "Acceso no autorizado a la API."})
            return

    body = _leer_body_json(handler)
    if body is None:
        return

    ingredientes = body.get("ingredientes")
    if not isinstance(ingredientes, list) or not ingredientes:
        handler._send_json(400, {"error": "Falta la lista de ingredientes"})
        return
    presupuesto = body.get("presupuesto") if isinstance(body.get("presupuesto"), dict) else {}
    densidad_maxima = body.get("densidad_maxima") if isinstance(body.get("densidad_maxima"), dict) else {}
    situacion_clinica = body.get("situacion_clinica") if isinstance(body.get("situacion_clinica"), dict) else None
    riesgo_hiperkalemia = bool(body.get("riesgo_hiperkalemia"))
    robot_id = body.get("robot") if isinstance(body.get("robot"), str) else None

    ip = handler._client_ip()
    permitido, retry_after, motivo = RATE_LIMITER.check(ip)
    if not permitido:
        print(f"[rate-limit] bloqueado ip={ip} motivo={motivo} retry_after={retry_after}s", flush=True)
        espera = format_espera(retry_after)
        mensaje = (
            "La app alcanzó su límite de generación de recetas por hoy. "
            f"Vuelve a intentarlo en {espera}."
            if motivo == "global" else
            f"Hiciste muchas solicitudes en poco tiempo. Vuelve a intentarlo en {espera}."
        )
        handler._send_json(429, {"error": mensaje}, {"Retry-After": str(retry_after)})
        return

    try:
        receta = call_claude_receta(ingredientes, presupuesto, densidad_maxima, situacion_clinica, riesgo_hiperkalemia, robot_id)
        handler._send_json(200, receta)
    except ValueError as e:
        handler._send_json(400, {"error": str(e)})
    except RuntimeError as e:
        handler._send_json(500, {"error": str(e)})
    except Exception as e:
        handler._send_json(500, {"error": f"Error inesperado: {e}"})


def handle_leer_receta(handler):
    """POST /api/leer-receta — transcribe una receta que el paciente ya tiene
    (foto o texto pegado) a ingredientes con gramos. Mismas guardas que el
    resto de los endpoints que llaman a Claude: clave de app y cupo de uso."""
    if APP_KEY:
        provided = handler.headers.get("X-App-Key", "")
        if not hmac.compare_digest(provided, APP_KEY):
            print(f"[auth] rechazado ip={handler._client_ip()}", flush=True)
            handler._send_json(401, {"error": "Acceso no autorizado a la API."})
            return

    body = _leer_body_json(handler)
    if body is None:
        return

    imagen = body.get("imagen") if isinstance(body.get("imagen"), str) else None
    texto = body.get("texto") if isinstance(body.get("texto"), str) else None
    if not imagen and not (texto or "").strip():
        handler._send_json(400, {"error": "Falta la foto o el texto de la receta"})
        return

    ip = handler._client_ip()
    permitido, retry_after, motivo = RATE_LIMITER.check(ip)
    if not permitido:
        print(f"[rate-limit] bloqueado ip={ip} motivo={motivo} retry_after={retry_after}s", flush=True)
        espera = format_espera(retry_after)
        mensaje = (
            f"La app alcanzó su límite de lecturas de receta por hoy. Vuelve a intentarlo en {espera}."
            if motivo == "global" else
            f"Hiciste muchas solicitudes en poco tiempo. Vuelve a intentarlo en {espera}."
        )
        handler._send_json(429, {"error": mensaje}, {"Retry-After": str(retry_after)})
        return

    try:
        handler._send_json(200, call_claude_leer_receta(imagen, texto))
    except ValueError as e:
        handler._send_json(400, {"error": str(e)})
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
    ("POST", re.compile(r"^/api/identificar-ingredientes$"), handle_identificar_ingredientes),
    ("POST", re.compile(r"^/api/generar-receta$"), handle_generar_receta),
    ("POST", re.compile(r"^/api/leer-receta$"), handle_leer_receta),
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
