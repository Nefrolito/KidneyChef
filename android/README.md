# Android: cómo construir y publicar KidneyChef

El proyecto Android es el mismo Capacitor que la app de iOS: el código vive en
`public/` y acá solo se empaqueta. Al 2026-09-17 la app está publicada en la
App Store y **no** en Google Play.

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

1. **Cuenta de Google Play Developer**: pago único de 25 USD y verificación de
   identidad.
2. **Prueba cerrada obligatoria**: una cuenta personal creada después del
   13-11-2023 necesita 12 testers inscritos 14 días seguidos antes de pedir
   acceso a producción. Cuentas de organización están exentas.
3. **Suscripciones**: crearlas en Play Console con los mismos identificadores
   que en RevenueCat, agregar la app Android en RevenueCat y poner su clave
   pública en `REVENUECAT_API_KEY_ANDROID` (`public/app.js`), hoy vacía. Sin
   eso el paywall no puede cobrar en Android.
4. **Formularios de Play Console**: seguridad de los datos, clasificación de
   contenido, público objetivo y la **declaración de apps de salud**.
5. **Ficha**: para una app de salud que no es dispositivo médico, la
   descripción debe decirlo y recordar consultar a un profesional.

## 5. Borrador de la ficha

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
> • Lista de supermercado con precios de referencia de cadenas chilenas.
> • Tu nefrólogo(a) o nutricionista puede fijarte metas propias desde su portal.
> • Datos nutricionales de USDA FoodData Central, y criterios de la National
>   Kidney Foundation, KDIGO y KDOQI, todos citados dentro de la app.
>
> KidneyChef no es un dispositivo médico y no diagnostica, trata, cura ni
> previene ninguna enfermedad. Es una herramienta educativa de apoyo: consulta
> siempre a tu equipo de nefrología y nutrición antes de cambiar tu dieta o tu
> tratamiento.
>
> Suscripción con un mes de prueba. Se renueva sola y se cancela desde Google
> Play cuando quieras.

**Enlaces obligatorios**

- Privacidad: https://kidneychef-api.onrender.com/privacidad.html
- Términos: https://kidneychef-api.onrender.com/terminos.html
- Soporte: https://kidneychef-api.onrender.com/soporte.html

## 6. Seguridad de los datos (borrador de respuestas)

- Las fotos de comida se envían al backend solo para analizarlas y no se
  guardan.
- El historial, el perfil clínico y las metas viven en el teléfono
  (`localStorage`).
- Solo si el paciente activa el vínculo con un tratante se suben al servidor su
  código de cliente y el total diario de potasio y fósforo.
- No hay cuentas de usuario para el paciente ni publicidad.
