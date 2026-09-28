# Android: cómo construir y publicar KidneyChef

El proyecto Android es el mismo Capacitor que la app de iOS: el código vive en
`public/` y acá solo se empaqueta. Al 2026-09-28 la app está publicada en la
App Store y **no** en Google Play. El Android va en la misma versión que iOS:
1.2, `versionCode` 8 (el mismo número del build de Xcode).

## 1. Requisitos locales

Esta Mac tiene el SDK de Android en `~/Library/Android/sdk` y el JDK que trae
Android Studio. Gradle necesita ese JDK, así que las órdenes de abajo lo
apuntan explícitamente:

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

## 2. Crear la llave de subida (una sola vez)

Google firma la app por ti, pero necesitas una **llave de subida** propia para
mandarle los bundles. Guárdala fuera del repositorio y no la pierdas: sin ella
no se puede publicar una actualización.

```bash
"$JAVA_HOME/bin/keytool" -genkeypair -v -keystore ~/Documents/kidneychef-upload.jks -alias kidneychef -keyalg RSA -keysize 2048 -validity 10000
```

Te va a pedir una contraseña y tus datos. Después crea
`android/keystore.properties` (git lo ignora) con:

```properties
storeFile=/Users/camiloulloa/Documents/kidneychef-upload.jks
storePassword=la-que-pusiste
keyAlias=kidneychef
keyPassword=la-que-pusiste
```

Guarda una copia del `.jks` y de las contraseñas en tu gestor de contraseñas.

## 3. Construir el bundle

```bash
npm run cap:sync                     # copia public/ al proyecto Android
cd android && ./gradlew bundleRelease
```

El archivo queda en `android/app/build/outputs/bundle/release/app-release.aab`.
Sin `keystore.properties` el bundle sale sin firmar y Play lo rechaza.

Para subir una versión nueva hay que aumentar `versionCode` en
`android/app/build.gradle` (Play no acepta dos veces el mismo número).

## 4. Lo que falta antes de publicar

1. **Cuenta de Google Play Developer de organización** (a nombre de la SpA):
   pago único de 25 USD, número D-U-N-S de la empresa y verificación de la
   organización. Las cuentas de organización no tienen que pasar la prueba
   cerrada de 12 testers durante 14 días que se exige a las personales. La razón social,
   el RUT y la dirección tienen que coincidir con el SII y con el D-U-N-S.
2. **Llave de subida y `keystore.properties`** (sección 2).
3. **Suscripciones en Play Console** (Monetizar → Suscripciones). Seis
   suscripciones con **los mismos ids que en App Store Connect**, cada una con
   un solo plan base:

   | Suscripción (id) | Plan base | Precio |
   |---|---|---|
   | `com.kidneychef.app.gold` | `mensual`, renovación mensual | $5.990 |
   | `com.kidneychef.app.gold.annual` | `anual`, renovación anual | $49.990 |
   | `com.kidneychef.app.platinum` | `mensual` | $7.990 |
   | `com.kidneychef.app.platinum.annual` | `anual` | $69.990 |
   | `com.kidneychef.app.diamond` | `mensual` | $9.990 |
   | `com.kidneychef.app.diamond.annual` | `anual` | $89.990 |

   En cada una, una **oferta de prueba gratis de 1 mes** con elegibilidad
   "Adquisición de clientes nuevos → nunca tuvo ninguna suscripción" (lo mismo
   que en Apple, donde la prueba se da una vez por grupo). Play entrega como id
   `suscripción:plan base`; la app le quita el plan base (`idProductoTienda()`
   en `public/app.js`), así que el código es el mismo para las dos tiendas.
4. **RevenueCat**: agregar la app Android (`com.kidneychef.app`), subir la
   credencial de la cuenta de servicio de Google (Play Console → Configuración →
   Acceso a la API; los permisos pueden demorar hasta 36 h en activarse),
   importar los seis productos y colgarlos de los mismos entitlements `gold`,
   `platinum` y `diamond`, y de la misma offering. Después, poner la clave pública
   `goog_...` en `REVENUECAT_API_KEY_ANDROID` (`public/app.js`), que hoy está
   vacía. Sin ella la app de Android usa el contador local de 30 días de la
   demo web y no puede cobrar. El servidor consulta RevenueCat sin importar la
   tienda, así que no hay que cambiarlo.
5. **Países: solo Chile**, igual que en la App Store (restricción legal).
6. **Formularios de Play Console**: seguridad de los datos (sección 6),
   clasificación de contenido (IARC: sin violencia ni contenido sensible),
   público objetivo mayores de 18, sin anuncios, y la **declaración de apps de
   salud** (sección 7).
7. **Probar en un teléfono Android real** con una prueba interna antes de
   producción: cámara, paywall con precios de Play y compra con una cuenta de
   prueba de licencias.

## 5. Ficha de Play Store (español, Latinoamérica)

Los gráficos están en `~/Desktop/ficha-google-play-kidneychef/`, fuera del repo:
`icono-512.png`, `grafico-destacado-1024x500.png` y cinco capturas de
1080×2160. Son las de iPhone de 6,9" con márgenes laterales del color del
borde, porque Play no acepta una proporción mayor que 2:1. La app es la misma
vista web, así que en Android se ve igual.

**Nombre (máx. 30):** KidneyChef

**Categoría:** Medicina

**Descripción corta (máx. 80 caracteres)**

> Semáforo de potasio, fósforo y sodio para la dieta renal, con foto.

**Descripción larga**

> KidneyChef ayuda a personas con enfermedad renal crónica a entender qué tiene
> su comida. Tomas una foto del plato y la app identifica el alimento, estima la
> porción y muestra un semáforo de potasio, fósforo y sodio.
>
> • Registro del día con tus metas de potasio, fósforo, sodio, carbohidratos y
>   calorías, y del agua y el peso si estás en diálisis.
> • Recetas con lo que tienes en el refrigerador, ajustadas a tu situación.
> • Lista de supermercado con cortes reales y precios de referencia de cadenas
>   chilenas.
> • Datos nutricionales de USDA FoodData Central, y criterios de la National
>   Kidney Foundation, KDIGO y KDOQI, todos citados dentro de la app.
>
> KidneyChef no es un dispositivo médico y no diagnostica, trata, cura ni
> previene ninguna enfermedad. Es una herramienta educativa de apoyo: consulta
> siempre a tu equipo de nefrología y nutrición antes de cambiar tu dieta o tu
> tratamiento.
>
> Tres planes (Gold, Platinum y Diamond), mensuales o anuales, con un mes de
> prueba gratis. La suscripción se renueva sola y se cancela cuando quieras
> desde Google Play.

(Se sacó la línea del portal del tratante: esa pestaña está oculta en la 1.2 y
Google rechaza fichas que describen funciones que la app no tiene. Volverá con
la 1.3.)

**Enlaces**

- Privacidad: https://kidneychef-api.onrender.com/privacidad.html
- Términos: https://kidneychef-api.onrender.com/terminos.html
- Soporte: https://kidneychef-api.onrender.com/soporte.html
- Correo de contacto: soporte.kidneychef@gmail.com

## 6. Seguridad de los datos (respuestas para Play Console)

Revisado contra el código de la 1.2 el 2026-09-28. Todo viaja por HTTPS
("encriptados en tránsito": sí). El paciente no tiene cuenta, así que no hay
URL de borrado de cuenta; su historial se borra al desinstalar.

| Tipo de dato (Play) | ¿Se recopila? | Detalle |
|---|---|---|
| Fotos | Sí, **procesamiento efímero** | Fotos del plato, del refrigerador y de recetas: el backend las pasa a la IA (Anthropic) para analizarlas y no las guarda. Obligatorio para la función. |
| Información de salud | Sí, **procesamiento efímero** | Con "Analizar mi día" y las recetas se envían la etapa renal, las metas y lo que comió, sin nombre, para que la IA comente. No se guardan. Opcional. |
| Historial de compras | Sí | RevenueCat recibe las compras de Google Play para dar el nivel. Funcionalidad de la app. |
| ID del dispositivo u otros | Sí | ID anónimo de RevenueCat, que va al servidor en cada llamada (`X-RevenueCat-Id`) para comprobar el nivel. Funcionalidad de la app. No es el ID de publicidad. |
| Dirección IP | Solo en registros del servidor | Para el límite de uso y el diagnóstico (`[rate-limit]`, `[auth]`). |

Compartir con terceros: **no**. Anthropic y RevenueCat procesan los datos por
cuenta de KidneyChef, y Google no cuenta eso como "compartir". El nombre, la
fecha de nacimiento (solo para calcular la edad y el eGFR), el historial, el
perfil clínico y las metas quedan en el teléfono (`localStorage`) y no se
declaran. El vínculo
con el tratante (Supabase) está apagado en la 1.2; al encenderlo en la 1.3 hay
que agregar "nombre", "información de salud: almacenada" y la URL de borrado.

## 7. Declaración de apps de salud

- Funciones: **nutrición y control de peso** (dieta renal) y **gestión de
  enfermedades** (enfermedad renal crónica).
- No es dispositivo médico, no está regulada como tal y no pretende
  diagnosticar ni tratar. El descargo va en la descripción larga y dentro de
  la app (Acerca de y cada análisis).
- Fuentes citadas dentro de la app: `fuentes.html`
  (https://kidneychef-api.onrender.com/fuentes.html).
