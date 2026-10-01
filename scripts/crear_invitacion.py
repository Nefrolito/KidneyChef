"""Crea un link personal para probar KidneyChef en el navegador.

    python3 scripts/crear_invitacion.py          # vence en 7 días
    python3 scripts/crear_invitacion.py 3        # vence en 3 días

Firma el vencimiento con INVITACION_SECRETO (la misma clave que tiene Render;
se lee del .env o del entorno). Sin esa clave no se puede fabricar ni alargar
un link. Un link por paciente: así cada uno vence por su cuenta.
"""

import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402  (carga el .env)

BASE = "https://kidneychef-api.onrender.com"


def main():
    dias = float(sys.argv[1]) if len(sys.argv) > 1 else 7
    secreto = os.environ.get("INVITACION_SECRETO", "").strip()
    if not secreto:
        sys.exit("Falta INVITACION_SECRETO en el .env (la misma que en Render).")
    vence = time.time() + dias * 86400
    token = server.firmar_invitacion(vence, secreto)
    print(f"{BASE}/i/{token}")
    print(f"Vence: {datetime.fromtimestamp(vence):%d-%m-%Y %H:%M}")


if __name__ == "__main__":
    main()
