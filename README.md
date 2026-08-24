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

## Suscripción

La app es gratis un mes desde la primera vez que se abre (`perfil.creadoEn`
en `localStorage`, ver `TRIAL_DIAS`/`estadoSuscripcion()`/`renderSuscripcion()`
en `public/app.js`). Pasado ese mes, toda la app queda bloqueada por el
paywall hasta que exista una suscripción activa.

Son **3 niveles con precio fijo**, cada uno mensual o anual (constante
`NIVELES_INFO` en `public/app.js`):

| Nivel    | Mensual | Anual | Incluye |
|----------|---------|-------|---------|
| Gold     | $5.990  | $49.990 | Semáforo Na/K/P/carbohidratos, "Tu día de hoy", historial |
| Platinum | $7.990  | $69.990 | Todo Gold + recetas con IA desde el refrigerador + pestaña Súper |
| Diamond  | $9.990  | $89.990 | Todo Platinum + Cookidoo (aún no construido) |

Los product IDs son `com.kidneychef.app.<nivel>` (mensual) y
`com.kidneychef.app.<nivel>.annual` (anual). En RevenueCat cada producto
otorga su propio entitlement (`gold`/`platinum`/`diamond`); el código guarda
el más alto activo en `perfil.suscripcion.nivel` y compara rangos con
`nivelSuficiente(minimo)` (`NIVELES_SUSCRIPCION` en `public/app.js`).
En App Store Connect los 6 productos viven en un solo grupo ("KidneyChef")
con 3 niveles de rank, para que Apple maneje el upgrade/downgrade.

La compra real se integra con **RevenueCat**
(`@revenuecat/purchases-capacitor`, ya instalado y sincronizado en
`ios/`/`android/` vía `npx cap sync`), llamado directo por
`window.Capacitor.Plugins.Purchases` sin bundler. La API key pública de iOS
ya está puesta en `REVENUECAT_API_KEY_IOS`; la compra sandbox se probó de
punta a punta en un iPhone real.

El Plan Clínico (vínculo con el tratante) **no** se ofrece en ningún nivel
mientras `MOSTRAR_TAB_TRATANTE` sea `false` en `public/app.js`: esa función
vive entera en la pestaña Tratante, y vender algo que el usuario no puede
abrir es motivo de rechazo en la App Store. Al volver a prender la pestaña
—después de reactivar el proyecto de Supabase, que está pausado— hay que
reponer ese bullet en `NIVELES_INFO.gold.features`.

Lo que falta:

1. Enviar los 6 productos a revisión **junto con el primer build** de la app
   (Apple exige que las suscripciones de una app nueva se envíen con el
   binario, no antes ni por separado).
2. La cuenta de Google Play Developer y el equivalente Android: completar
   `REVENUECAT_API_KEY_ANDROID` en `public/app.js`.

Mientras una key esté vacía, `initRevenueCat()` no hace nada en esa
plataforma y el botón del paywall solo muestra "disponible muy pronto" — la
app sigue funcionando con el trial local.

## Documentos legales

`public/terminos.html` y `public/privacidad.html` son los Términos y
Condiciones y la Política de Privacidad que la app muestra antes de dejar
entrar (overlay bloqueante `#terminos-overlay`, ver `TERMINOS_VERSION` /
`terminosAceptados()` en `public/app.js`). La aceptación se guarda en
`perfil.terminos`; subir `TERMINOS_VERSION` vuelve a pedirla a todos.

Ambos documentos están completos y con el correo de contacto real
(contacto@kidneychef.com), pero **los escribió Claude, no un abogado**.
Antes de publicar conviene que los revise uno, sobre todo por tratarse de
una app relacionada con salud y por la Ley 21.719 de protección de datos
personales en Chile (vigente desde diciembre de 2026). La advertencia que
decía esto vivía dentro de los propios documentos y se sacó de ahí: el
usuario final —y el revisor de Apple— no tienen por qué leer una nota
interna en un documento legal.

Al editar cualquiera de los dos hay que actualizar a mano la fecha de
"Última actualización" del encabezado.

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
