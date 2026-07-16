# KidneyChef — Semáforo Nutricional

Prototipo web para pacientes con enfermedad renal crónica: toma o sube una foto
de tu comida y obtén un semáforo (verde/amarillo/rojo) de potasio, fósforo y
sodio, con la porción estimada por IA de visión.

## Cómo funciona

1. El frontend (HTML/CSS/JS sin frameworks, en `public/`) captura o recibe una foto.
2. Se envía al backend local (`server.py`), que reenvía la imagen a la API de
   Claude (visión) para identificar el alimento y estimar la porción en gramos.
   La API key nunca se expone al navegador.
3. El nombre del alimento se cruza contra `public/nutrientes.json`, una base de
   datos curada de ~90 alimentos con potasio, fósforo y sodio por 100 g.
4. Se calculan los valores para la porción estimada y se clasifican con un
   semáforo de referencia (ver umbrales en `public/app.js`).
5. El historial del día se guarda en el `localStorage` del navegador (no hay
   base de datos ni cuentas de usuario — es un prototipo local).

## Requisitos

- Python 3.9+ (no requiere `pip install` nada, solo librería estándar).
- Una API key de Anthropic (https://console.anthropic.com/).

## Configuración

```bash
cp .env.example .env
# Edita .env y pon tu API key real:
# ANTHROPIC_API_KEY=sk-ant-...
```

## Ejecutar

```bash
python3 server.py
```

Abre http://localhost:8000 en el navegador (en el celular, usa la IP de tu
computadora en la misma red, ej. http://192.168.1.5:8000, para poder usar la
cámara).

## Desplegar el backend en Render (para la app empaquetada o producción)

La app nativa (Capacitor) no tiene un servidor Python corriendo en el
teléfono, así que necesita un backend accesible por internet. Pasos:

1. Sube este repo a GitHub (necesitas una cuenta de GitHub).
2. Crea una cuenta en [render.com](https://render.com) (tiene plan gratuito,
   no pide tarjeta).
3. En el dashboard de Render: **New +** → **Blueprint**, y apunta al repo. Va a
   detectar `render.yaml` automáticamente y crear el servicio.
4. En la configuración del servicio, agrega la variable de entorno
   `ANTHROPIC_API_KEY` con tu key real (nunca la subas al repo).
5. Cuando termine el deploy, Render te da una URL tipo
   `https://kidneychef-api.onrender.com`. Actualiza esa URL en
   `public/app.js` (constante `API_BASE`) para que coincida con la tuya.

**Advertencia de seguridad:** este backend no tiene autenticación ni límite de
uso. Cualquiera que descubra la URL puede llamar a `/api/analyze` y consumir
tu API key de Anthropic (con su costo asociado). Para una beta pública real,
conviene agregar al menos un límite de tasa (rate limiting) o una clave
compartida simple antes de difundir la URL ampliamente.

El plan gratuito de Render "duerme" el servicio tras ~15 minutos sin uso; la
primera petición después de eso tarda unos segundos extra en responder
mientras despierta.

## Limitaciones importantes

- Los valores nutricionales son de referencia general por 100 g (no
  personalizados ni verificados clínicamente) — este es un prototipo educativo,
  no un dispositivo médico.
- Los umbrales del semáforo son genéricos; deben ajustarse con el nefrólogo(a)
  o nutricionista de cada paciente según sus límites reales.
- El reconocimiento de alimentos depende de la IA de visión y puede
  equivocarse; siempre se puede corregir manualmente el alimento identificado.
- Si la IA identifica un alimento que no está en la base de datos, se pide
  seleccionarlo manualmente de la lista existente.

## Créditos

- Foto decorativa de la pantalla de captura: "Healthy Gnocchi Buddha Bowl" por
  Jonas Zeschke (FitTasteTic), Wikimedia Commons, licencia
  [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/deed.es).
  https://commons.wikimedia.org/wiki/File:Healthy_Gnocchi_Buddha_Bowl_-_49859053553.jpg
