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

Para el portal del equipo tratante (`/tratante/`, ver más abajo) hace falta además
un proyecto de [Supabase](https://supabase.com/dashboard) (Postgres + Auth):

1. Crear el proyecto en supabase.com/dashboard.
2. Correr `supabase/schema.sql` en su SQL Editor (crea las 4 tablas y deja RLS
   encendido sin políticas permisivas — el acceso real lo controla `server.py`).
3. Copiar de **Project Settings → API**: `Project URL`, la key `service_role` y
   la key `anon`, y completar `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y
   `SUPABASE_ANON_KEY` en `.env` (ver comentarios en `.env.example`).
4. Completar `SUPABASE_URL`/`SUPABASE_ANON_KEY` (los mismos valores públicos,
   nunca la `service_role`) en `tratante/config.js`.

Sin esto, la app del paciente funciona igual que siempre (semáforo, historial
local); solo la sección "Equipo tratante" y el portal quedan sin poder
vincularse.

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
5. Agrega también `APP_KEY` con **el mismo valor** que tiene la constante
   `APP_KEY` en `public/app.js` (ver "Protección del backend" abajo).
5.1. Si vas a usar el portal del tratante, agrega también `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY` y `SUPABASE_ANON_KEY` (ver "Equipo tratante" abajo).
6. Cuando termine el deploy, Render te da una URL tipo
   `https://kidneychef-api.onrender.com`. Actualiza esa URL en
   `public/app.js` (constante `API_BASE`) para que coincida con la tuya.

## Protección del backend

Cada análisis cuesta dinero en la API de Anthropic, así que `/api/analyze` está
protegido en tres capas:

- **Clave de app** (`APP_KEY`): la app manda el header `X-App-Key` en cada
  llamada; sin él el backend responde 401. **No es un secreto**: viaja en el
  bundle del cliente y alguien técnico puede extraerla. Sirve para que quien
  descubra la URL no pueda usar el backend directamente. Si la variable queda
  vacía en el servidor, no se exige (cómodo para desarrollo local).
- **Límite por IP**: 20 análisis por hora. Reparte el uso entre pacientes y
  frena el abuso accidental (apretar el botón muchas veces).
- **Límite global**: 500 análisis por día → techo de gasto de ~US$10/día en el
  peor caso. Este es el resguardo que realmente acota el costo, porque la IP se
  lee de `X-Forwarded-For` (Render corre detrás de un proxy) y ese header es
  falsificable.

Los cuatro límites se ajustan por variables de entorno sin tocar código:
`RATE_LIMIT_PER_IP`, `RATE_LIMIT_PER_IP_WINDOW`, `RATE_LIMIT_GLOBAL`,
`RATE_LIMIT_GLOBAL_WINDOW` (ventanas en segundos). También hay un tope de
tamaño de payload (`MAX_BODY_BYTES`, 8 MB por defecto).

**Limitación conocida:** los contadores viven en memoria, así que se reinician
cuando Render duerme o redespliega el servicio. Durante un abuso sostenido el
tráfico mantiene el servicio despierto y el contador sí acumula, que es el caso
que importa para acotar el gasto. Si más adelante hace falta algo estricto, el
siguiente paso sería un store persistente (Redis o una tabla en base de datos).

El plan gratuito de Render "duerme" el servicio tras ~15 minutos sin uso; la
primera petición después de eso tarda unos segundos extra en responder
mientras despierta.

## Equipo tratante (portal en `/tratante/`)

Además de la app del paciente (`public/`), el repo incluye un portal web
separado para el nefrólogo(a)/nutricionista, servido por el mismo `server.py`
en `/tratante/` (sin build ni framework, igual que `public/`).

- El paciente activa "Plan Clínico" en su celular y recibe un **código de
  cliente** que comparte con su tratante.
- El tratante crea su cuenta en `/tratante/login.html` (usa Supabase Auth
  directamente) e ingresa ese código en su dashboard para pedir el vínculo.
- El vínculo queda `pendiente` hasta que **el propio paciente lo acepta desde
  su celular** — es un paso de confirmación obligatorio (no solo de UX):
  sin él, el tratante nunca llega a ver datos clínicos del paciente.
- Una vez aceptado, el tratante puede ajustar las metas de potasio/fósforo y
  ver un gráfico del consumo diario del paciente (solo se sincroniza consumo
  al servidor si existe al menos un vínculo activo).

Requiere el proyecto de Supabase de la sección "Configuración" de más arriba.
Localmente, con `server.py` corriendo, el portal está en
`http://localhost:8000/tratante/`. `tratante/config.js` necesita
`SUPABASE_URL`/`SUPABASE_ANON_KEY` (los mismos valores del `.env`, son
públicos por diseño — no la `service_role` key, esa es solo del servidor).

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
