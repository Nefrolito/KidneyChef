"""Cliente mínimo de RevenueCat para KidneyChef: responde qué nivel de
suscripción tiene activo un usuario de la app.

Usa la API REST v1 (`GET /v1/subscribers/{app_user_id}`) con la clave
SECRETA del proyecto (empieza con `sk_`), que vive solo en el servidor — no
confundir con las claves públicas `appl_`/`goog_` de `public/app.js`. Solo
`urllib`, igual que `supabase_client.py`, para no sumar dependencias.

La prueba gratis es una oferta introductoria de la App Store, así que durante
el mes de prueba el entitlement ya aparece activo (con period_type "trial"):
para el servidor, quien está en prueba y quien pagó se ven igual.

Este módulo asume que `server.py` ya cargó el `.env`.
"""
import datetime
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

REVENUECAT_SECRET_KEY = os.environ.get("REVENUECAT_SECRET_KEY", "")
REVENUECAT_URL = "https://api.revenuecat.com/v1/subscribers/"

# Mismo orden y nombres que NIVELES_SUSCRIPCION / RANGO_NIVEL en public/app.js.
RANGO_NIVEL = {"gold": 1, "platinum": 2, "diamond": 3}

# La app configura RevenueCat sin appUserID, así que cada instalación tiene un
# ID anónimo con este formato. Se aceptan solo esos: consultar un ID
# inventado crea ese suscriptor en RevenueCat, y no queremos que cualquiera
# llene el proyecto de basura.
ID_ANONIMO = re.compile(r"^\$RCAnonymousID:[0-9a-f]{32}$")

# Cuánto se recuerda la respuesta. Con nivel se recuerda más; sin nivel,
# poco, para que quien recién compró no espere mucho en ser reconocido.
CACHE_CON_NIVEL = int(os.environ.get("REVENUECAT_CACHE_CON_NIVEL", 300))
CACHE_SIN_NIVEL = int(os.environ.get("REVENUECAT_CACHE_SIN_NIVEL", 60))
CACHE_MAX = 5000

_cache = {}
_cache_lock = threading.Lock()


class RevenueCatError(RuntimeError):
    pass


def configurado():
    return bool(REVENUECAT_SECRET_KEY)


def id_valido(app_user_id):
    return bool(app_user_id) and bool(ID_ANONIMO.match(app_user_id))


def _parse_fecha(valor):
    if not valor:
        return None
    return datetime.datetime.fromisoformat(valor.replace("Z", "+00:00"))


def nivel_desde_suscriptor(subscriber, ahora=None):
    """El nivel más alto entre los entitlements vigentes, o None. Un
    entitlement sin fecha de término es de por vida; el período de gracia
    (cobro fallido que la tienda sigue reintentando) cuenta como vigente."""
    ahora = ahora or datetime.datetime.now(datetime.timezone.utc)
    mejor = None
    for nombre, ent in (subscriber.get("entitlements") or {}).items():
        if nombre not in RANGO_NIVEL:
            continue
        fin = _parse_fecha(ent.get("expires_date"))
        gracia = _parse_fecha(ent.get("grace_period_expires_date"))
        vigente = fin is None or fin > ahora or (gracia is not None and gracia > ahora)
        if vigente and (mejor is None or RANGO_NIVEL[nombre] > RANGO_NIVEL[mejor]):
            mejor = nombre
    return mejor


def _consultar(app_user_id):
    url = REVENUECAT_URL + urllib.parse.quote(app_user_id, safe="")
    req = urllib.request.Request(url, method="GET", headers={
        "Authorization": f"Bearer {REVENUECAT_SECRET_KEY}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8")).get("subscriber") or {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:200]
        raise RevenueCatError(f"RevenueCat respondió {e.code}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise RevenueCatError(f"No se pudo consultar RevenueCat: {e}") from e


def nivel_de(app_user_id):
    """Nivel activo ("gold"/"platinum"/"diamond") o None. Lanza
    RevenueCatError si no hay clave o RevenueCat falla — los errores no se
    recuerdan, así que el siguiente intento vuelve a consultar."""
    if not configurado():
        raise RevenueCatError("Falta REVENUECAT_SECRET_KEY")
    ahora = time.monotonic()
    with _cache_lock:
        guardado = _cache.get(app_user_id)
        if guardado and guardado[1] > ahora:
            return guardado[0]
    nivel = nivel_desde_suscriptor(_consultar(app_user_id))
    vence = ahora + (CACHE_CON_NIVEL if nivel else CACHE_SIN_NIVEL)
    with _cache_lock:
        if len(_cache) >= CACHE_MAX:
            for clave in [k for k, (_, v) in _cache.items() if v <= ahora]:
                del _cache[clave]
            if len(_cache) >= CACHE_MAX:
                _cache.clear()
        _cache[app_user_id] = (nivel, vence)
    return nivel


def alcanza(nivel, minimo):
    return bool(nivel) and RANGO_NIVEL[nivel] >= RANGO_NIVEL[minimo]
