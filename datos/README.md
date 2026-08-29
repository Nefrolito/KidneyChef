# Procedencia de los datos nutricionales

`public/nutrientes.json` no se edita a mano: se construye desde fuentes oficiales.

## Fuentes

- **Potasio, fósforo, sodio, carbohidratos, calorías**: USDA FoodData Central, SR Legacy 2018-04.
  Descarga: https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
  (la API pública con `DEMO_KEY` solo permite 10 solicitudes/hora — no alcanza
  para 166 alimentos, hay que usar el ZIP del bulk download).
- **Índice glucémico**: tablas internacionales de la Universidad de Sydney
  (Atkinson 2021), obtenidas desde https://glycemicindex.com/gi-search/

## Archivos

- `usda_mapeo.py` — qué entrada exacta de USDA corresponde a cada alimento nuestro.
  Está escrito a mano a propósito: el matching automático por texto daba falsos
  positivos graves (naranja → sherbet, salmón → aceite de salmón, manzana →
  custard apple). No reemplazar por búsqueda difusa.
- `recetas_chilenas.py` — gramos de cada ingrediente por 100 g de plato terminado,
  para los platos que USDA no tiene. Proporciones validadas clínicamente por
  Camilo (2026-07-22).
- `gi_busquedas.py` — términos usados para ubicar cada alimento en la base de IG.
- `generar_recetas_json.py` — construye `public/recetas.json` y
  `public/ingredientes-refrigerador.json` a partir de `recetas_chilenas.py`,
  para la feature "recetas con lo que tienes en el refrigerador". Traduce las
  claves de ingrediente de las recetas a un vocabulario más chico que el
  paciente marca en un checklist, y excluye condimentos de despensa (sal,
  aceite, azúcar, polvo de hornear, color de ají) del checklist. Se corre a
  mano cuando cambia `recetas_chilenas.py`:
  `python3 datos/generar_recetas_json.py`.
- `agregar_calorias.py` — agrega `calorias_kcal` a cada alimento de
  `public/nutrientes.json` (2026-08-12). Para los 131 alimentos con `fdc_id`
  propio usa el valor de USDA directo (tabla `KCAL_POR_FDC_ID`, embebida en el
  script con la descripción USDA de cada uno para poder auditarla). Para los
  35 platos/preparaciones sin `fdc_id` (calculados desde una receta, ver
  `fuente.receta_g_por_100g` de cada uno) sí pesa los ingredientes, resolviendo
  cada uno contra un alimento canónico ya existente o, si no hay equivalente
  confiable (condimentos de despensa, o una versión ya cocida que en
  `nutrientes.json` solo existe cruda — misma lógica de lixiviación de potasio
  del criterio de abajo), contra un `fdc_id` propio buscado a mano en USDA
  SR Legacy. Se corre a mano si se agrega un alimento nuevo:
  `python3 datos/agregar_calorias.py`.
  **Aproximación declarada:** "trigo_mote" (mote de trigo, un producto muy
  específico de la cocina chilena) usa el grano de trigo crudo de USDA porque
  no existe una cifra chilena medida ni un equivalente USDA de "mote" cocido.

## Alimentos agregados después de la carga inicial

Los 166 alimentos originales salieron de una pasada masiva sobre el bulk
download de USDA. Los agregados después se buscaron uno a uno en la **API de
FoodData Central** (`POST /fdc/v1/foods/search` con `dataType: ["SR Legacy"]`),
que devuelve los mismos valores del bulk y sirve para agregar unos pocos sin
volver a bajar el ZIP. El proyecto no tiene una API key propia de USDA, así que
se usó `DEMO_KEY`, limitada a 10 solicitudes por hora — alcanza para un puñado
de alimentos, no para una recarga completa.

**2026-08-24 — seis ingredientes que las recetas chilenas ya usaban pero que no
estaban en la base**, así que el checklist del refrigerador los mostraba sin dato
y el generador de recetas no podía proponerlos: cilantro, queso gauda, harina de
trigo, manteca, mote de trigo y durazno en conserva. Su mapeo quedó en
`usda_mapeo.py` y sus calorías en `agregar_calorias.py`, igual que el resto.

Dos equivalencias que conviene tener presentes:

- **Mote de trigo → bulgur cocido**, no grano de trigo crudo. El mote se come
  cocido, y el grano crudo da 431 mg de potasio por 100 g contra 68 del cocido:
  más de seis veces, porque al cocerse absorbe agua. Usar el crudo haría ver el
  mote como un alimento peligroso cuando no lo es.
- **Harina → harina blanca corriente**, no la que trae polvos de hornear
  (self-rising), que en USDA tiene 1190 mg de sodio y 595 mg de fósforo por
  100 g. Si una receta usa harina con polvos, este dato no aplica.

**2026-08-28 — merluza cocida (`merluza_cocida`, FDC 175161, "Fish, whiting,
mixed species, cooked, dry heat").** "Merluza al vapor" guardaba 401 mg de potasio
por 100 g, una cifra heredada del prototipo anterior a la carga USDA: no se derivaba
de su propia receta (`{merluza: 97, sal: 0.5}`) ni de ninguna entrada de USDA.
Recalcularla sobre la merluza **cruda** daba 242 mg, y eso habría sido peor: cocer
pescado no lixivia potasio como hervir una verdura, sino que lo concentra (el pescado
pierde agua, 80,3 g → 74,7 g por 100 g), así que el crudo **subestima** el potasio de
un plato cocido — el error peligroso para un paciente renal. Se agregó la entrada
cocida y la receta ahora pesa sobre ella: K 421, P 276, Na 322, 112,5 kcal, todo
derivable de la receta y de USDA. Es la misma lógica del criterio de abajo, con el
signo invertido: la papa hervida baja de 417 a 321 porque el potasio se va al agua;
la merluza al vapor sube de 249 a 434 porque el agua se va y el potasio se queda.

**Queda pendiente el mismo problema en dos platos más:** `completo` (K 203 guardado
contra 255 recalculado) y `merluza_frita` (usa la merluza cruda, y además ni su
fósforo ni su sodio se derivan de su receta). `merluza_frita` no se puede recalcular
entero hasta que `aceite` y `harina` tengan potasio/fósforo/sodio en la base, no solo
calorías — ver los ocho ingredientes de `INGREDIENTE_KCAL_DIRECTO` en
`agregar_calorias.py`.

## Robots de cocina

`public/robots-cocina.json` sigue el mismo criterio que este archivo: ninguna
cifra se escribe de memoria. Los rangos del Thermomix TM5 y TM6 salen de los
manuales de instrucciones oficiales de Vorwerk (PDF en vorwerk.com); los del
Cecotec Mambo, Taurus MyCook y Monsieur Cuisine, de la ficha o el manual del
fabricante. Donde solo hubo ficha comercial y no manual, la entrada queda
marcada con `_PENDIENTE_VALIDAR`, igual que el contenido clínico sin validar.
Ver la sección "Modo robot de cocina" del README principal.

## Criterios aplicados

- Las preparaciones hervidas usan el valor USDA del alimento **ya cocido**, no del
  crudo: al hervir se lixivia potasio al agua (papa cocida 321 mg vs 417 cruda).
  Es la misma lógica de la doble cocción que se enseña al paciente renal.
- El IG se guarda como mediana de las mediciones publicadas, junto al número de
  estudios y el rango, porque varía mucho por variedad y preparación
  (arroz blanco: 17 a 114 según el estudio).
- No se asigna IG a alimentos sin hidratos ni a platos preparados sin IG publicado.
