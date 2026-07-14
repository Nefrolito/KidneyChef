#!/usr/bin/env python3
"""Prueba rápida: confirma que ANTHROPIC_API_KEY (en .env) es válida."""
import json
import os
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).parent


def load_dotenv():
    env_path = ROOT / ".env"
    if not env_path.exists():
        print("No existe .env. Copia .env.example a .env y pon tu key ahí.")
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main():
    load_dotenv()
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key or "tu-api-key-aqui" in api_key:
        print("❌ ANTHROPIC_API_KEY no está configurada (sigue el placeholder). Edita .env primero.")
        return

    body = json.dumps({
        "model": "claude-sonnet-5",
        "max_tokens": 16,
        "messages": [{"role": "user", "content": "Responde solo con: ok"}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            json.loads(resp.read().decode("utf-8"))
        print("✅ La API key funciona correctamente.")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        print(f"❌ Error {e.code}: {detail}")


if __name__ == "__main__":
    main()
