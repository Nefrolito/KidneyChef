#!/usr/bin/env python3
"""Chequeo de salud de KidneyChef en producción.

Revisa lo que de verdad usa un paciente y lo que, cuando se cae, no avisa
solo: la app web, la IA (con una llamada real a Anthropic), el portal del
tratante, la base de datos (Supabase), la clave de RevenueCat y la fecha de
término de la demo.

Nació del 2026-09-24, cuando la clave de Anthropic venció y nadie se enteró
hasta que Camilo abrió la app y vio el error.

Uso:
    python3 scripts/chequeo_salud.py          # informe legible
    python3 scripts/chequeo_salud.py --json   # para automatizar

Sale con código 0 si todo está bien y 1 si algo falla, así una tarea
programada puede avisar solo cuando corresponde. Las claves se leen del .env
(o del entorno) y nunca se imprimen.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
BASE = os.environ.get("KIDNEYCHEF_URL", "https://kidneychef-api.onrender.com")

# Imagen de 1x1 px: alcanza para comprobar que la API de Claude responde,
# gastando lo mínimo. La respuesta esperada es "no reconocible", y da igual:
# lo que se verifica es que conteste, no qué ve.
PIXEL = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
         "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

# Cliente real de RevenueCat, solo para comprobar que la clave secreta del
# servidor sigue sirviendo. Consultar un ID inexistente lo crearía, así que
# se usa uno que ya existe.
RC_CLIENTE = "$RCAnonymousID:c33133bb317e423eaa7dabe68cd5cdfc"

# Cuántos días antes de que venza la demo web conviene avisar.
AVISO_DEMO_DIAS = 7


def cargar_env():
    ruta = RAIZ / ".env"
    if not ruta.exists():
        return
    for linea in ruta.read_text().splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        os.environ.setdefault(clave.strip(), valor.strip().strip('"').strip("'"))


def pedir(url, metodo="GET", cuerpo=None, headers=None, timeout=90):
    """(status, texto, segundos). status es None si ni siquiera hubo respuesta."""
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(url, data=datos, method=metodo, headers=headers or {})
    inicio = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), time.monotonic() - inicio
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.monotonic() - inicio
    except Exception as e:  # red caída, DNS, timeout
        return None, f"{type(e).__name__}: {e}", time.monotonic() - inicio


def app_key():
    """La clave que la app manda al backend. Vive en public/app.js, no es secreta."""
    for linea in (RAIZ / "public" / "app.js").read_text().splitlines():
        if linea.startswith("const APP_KEY"):
            return linea.split('"')[1]
    return ""


def revisar_web():
    status, _, seg = pedir(f"{BASE}/")
    if status == 200:
        # El plan gratuito de Render duerme el servicio: el primer golpe del
        # día puede tardar casi un minuto y eso no es una falla.
        return ok("App web", f"responde 200 en {seg:.1f}s")
    if status == 410:
        return falla("App web", "la demo web está vencida (DEMO_HASTA ya pasó)",
                     "Si todavía la compartes, cambia DEMO_HASTA en Render.")
    return falla("App web", f"respondió {status}", "Revisa el servicio en Render.")


def revisar_ia():
    status, cuerpo, seg = pedir(
        f"{BASE}/api/analyze", "POST", {"image": PIXEL},
        {"Content-Type": "application/json", "X-App-Key": app_key()},
    )
    if status == 200 and "items" in cuerpo:
        return ok("IA (Claude)", f"analiza fotos, {seg:.1f}s")
    if status == 401:
        return falla("IA (Claude)", "el backend rechazó la clave de la app (APP_KEY)",
                     "Revisa que APP_KEY en Render coincida con la de public/app.js.")
    if status == 502:
        # Desde el 2026-09-24 el servidor ya no filtra el detalle al cliente:
        # está en los logs de Render como [ia] fallo en analyze.
        return falla("IA (Claude)", "el servidor no pudo hablar con la API de Claude",
                     "Mira los logs de Render y busca [ia]. Si dice 401, la clave "
                     "de Anthropic venció o se borró: crea otra en console.anthropic.com "
                     "con vencimiento Nunca, cámbiala en Render y usa "
                     "'Save, rebuild, and deploy'.")
    return falla("IA (Claude)", f"respondió {status}: {cuerpo[:120]}",
                 "Revisa los logs de Render.")


def revisar_commit():
    """Avisa si producción quedó corriendo un commit distinto al de GitHub,
    que es lo que pasa cuando un despliegue falla y nadie se da cuenta."""
    status, cuerpo, _ = pedir(f"{BASE}/api/version", timeout=30)
    if status != 200:
        return aviso("Versión desplegada", f"/api/version respondió {status}",
                     "Si es 404, producción todavía corre una versión anterior a este chequeo.")
    try:
        desplegado = json.loads(cuerpo).get("commit", "")
    except json.JSONDecodeError:
        return aviso("Versión desplegada", "respuesta ilegible", "")
    local = os.popen("cd %s && git rev-parse origin/main 2>/dev/null" % RAIZ).read().strip()[:7]
    if not local:
        return ok("Versión desplegada", f"commit {desplegado}")
    if desplegado == local:
        return ok("Versión desplegada", f"commit {desplegado}, al día con GitHub")
    return aviso("Versión desplegada", f"corre {desplegado} y GitHub va en {local}",
                 "Puede ser un despliegue en curso o uno que falló: revisa Deploys en Render.")


def revisar_portal():
    status, _, _ = pedir(f"{BASE}/tratante/")
    if status == 200:
        return ok("Portal del tratante", "responde 200")
    return falla("Portal del tratante", f"respondió {status}",
                 "Revisa el servicio en Render; si el portal falla al entrar, "
                 "puede ser Supabase pausado por inactividad.")


def revisar_supabase():
    """Hace que producción consulte Supabase y, de paso, lo mantiene despierto:
    el plan gratuito pausa el proyecto tras unos 7 días sin actividad, y
    mientras la pestaña del tratante esté oculta nadie más lo toca.

    Se pide un paciente que no existe: el servidor tiene que buscarlo en la
    tabla `pacientes` para responder 401. Si Supabase no contesta, el
    servidor responde 500."""
    status, _, _ = pedir(f"{BASE}/api/pacientes/me", headers={
        "X-App-Key": app_key(),
        "X-Codigo-Cliente": "CHEQUEO-SALUD",
        "X-Device-Secret": "chequeo",
    }, timeout=30)
    if status == 401:
        return ok("Base de datos (Supabase)", "responde; consulta hecha, el proyecto sigue activo")
    if status == 500:
        return falla("Base de datos (Supabase)", "el servidor no pudo consultarla",
                     "Probablemente Supabase se pausó por inactividad: entra a "
                     "supabase.com/dashboard y pulsa Restore en el proyecto. Si no, "
                     "mira los logs de Render y busca [error].")
    return aviso("Base de datos (Supabase)", f"respuesta inesperada ({status})",
                 "Revisa los logs de Render.")


def revisar_revenuecat():
    clave = os.environ.get("REVENUECAT_SECRET_KEY", "")
    if not clave:
        return aviso("RevenueCat", "no hay clave en este equipo, no se pudo probar",
                     "Agrega REVENUECAT_SECRET_KEY al .env local para incluirla.")
    url = "https://api.revenuecat.com/v1/subscribers/" + urllib.parse.quote(RC_CLIENTE, safe="")
    status, cuerpo, _ = pedir(url, headers={"Authorization": f"Bearer {clave}"}, timeout=20)
    if status == 200:
        return ok("RevenueCat", "la clave del servidor consulta suscriptores")
    if status in (401, 403):
        return falla("RevenueCat", "la clave secreta ya no sirve",
                     "Crea otra en app.revenuecat.com (Project settings → API keys, "
                     "versión V1) y cámbiala en Render.")
    return falla("RevenueCat", f"respondió {status}: {cuerpo[:120]}", "Reintenta más tarde.")


def revisar_demo():
    """La demo web tiene fecha de término y vencerla sin querer deja fuera a
    quien la esté usando desde el navegador."""
    hasta = os.environ.get("DEMO_HASTA", "").strip()
    if not hasta:
        for linea in (RAIZ / "render.yaml").read_text().splitlines():
            if "value:" in linea and "-" in linea and linea.strip().startswith('value: "20'):
                hasta = linea.split('"')[1]
                break
    if not hasta:
        return aviso("Demo web", "no se pudo leer DEMO_HASTA", "")
    try:
        fin = datetime.strptime(hasta, "%Y-%m-%d").date()
    except ValueError:
        return falla("Demo web", f"DEMO_HASTA mal escrita ({hasta})", "Corrígela en Render.")
    faltan = (fin - datetime.now().date()).days
    if faltan < 0:
        return aviso("Demo web", f"venció el {hasta}", "Era lo planeado; ignóralo si ya no la compartes.")
    if faltan <= AVISO_DEMO_DIAS:
        return aviso("Demo web", f"vence en {faltan} días ({hasta})",
                     "Si aún la compartes, corre la fecha en Render.")
    return ok("Demo web", f"vigente hasta el {hasta}")


def ok(que, detalle):
    return {"estado": "ok", "que": que, "detalle": detalle, "arreglo": ""}


def aviso(que, detalle, arreglo):
    return {"estado": "aviso", "que": que, "detalle": detalle, "arreglo": arreglo}


def falla(que, detalle, arreglo):
    return {"estado": "falla", "que": que, "detalle": detalle, "arreglo": arreglo}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="salida en JSON")
    args = parser.parse_args()

    cargar_env()

    resultados = [revisar_web(), revisar_ia(), revisar_commit(), revisar_portal(),
                  revisar_supabase(), revisar_revenuecat(), revisar_demo()]
    hay_falla = any(r["estado"] == "falla" for r in resultados)

    if args.json:
        print(json.dumps({"hay_falla": hay_falla, "resultados": resultados},
                         ensure_ascii=False, indent=1))
    else:
        icono = {"ok": "✅", "aviso": "⚠️ ", "falla": "❌"}
        print(f"KidneyChef — chequeo del {datetime.now():%Y-%m-%d %H:%M}")
        for r in resultados:
            print(f"{icono[r['estado']]} {r['que']}: {r['detalle']}")
            if r["arreglo"]:
                print(f"     → {r['arreglo']}")
    return 1 if hay_falla else 0


if __name__ == "__main__":
    sys.exit(main())
