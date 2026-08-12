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

## Criterios aplicados

- Las preparaciones hervidas usan el valor USDA del alimento **ya cocido**, no del
  crudo: al hervir se lixivia potasio al agua (papa cocida 321 mg vs 417 cruda).
  Es la misma lógica de la doble cocción que se enseña al paciente renal.
- El IG se guarda como mediana de las mediciones publicadas, junto al número de
  estudios y el rango, porque varía mucho por variedad y preparación
  (arroz blanco: 17 a 114 según el estudio).
- No se asigna IG a alimentos sin hidratos ni a platos preparados sin IG publicado.
