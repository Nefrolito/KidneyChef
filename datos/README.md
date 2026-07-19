# Procedencia de los datos nutricionales

`public/nutrientes.json` no se edita a mano: se construye desde fuentes oficiales.

## Fuentes

- **Potasio, fósforo, sodio, carbohidratos**: USDA FoodData Central, SR Legacy 2018-04.
  Descarga: https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
- **Índice glucémico**: tablas internacionales de la Universidad de Sydney
  (Atkinson 2021), obtenidas desde https://glycemicindex.com/gi-search/

## Archivos

- `usda_mapeo.py` — qué entrada exacta de USDA corresponde a cada alimento nuestro.
  Está escrito a mano a propósito: el matching automático por texto daba falsos
  positivos graves (naranja → sherbet, salmón → aceite de salmón, manzana →
  custard apple). No reemplazar por búsqueda difusa.
- `recetas_chilenas.py` — gramos de cada ingrediente por 100 g de plato terminado,
  para los platos que USDA no tiene. Las proporciones son estimaciones de
  preparación casera y están PENDIENTES de validación clínica.
- `gi_busquedas.py` — términos usados para ubicar cada alimento en la base de IG.

## Criterios aplicados

- Las preparaciones hervidas usan el valor USDA del alimento **ya cocido**, no del
  crudo: al hervir se lixivia potasio al agua (papa cocida 321 mg vs 417 cruda).
  Es la misma lógica de la doble cocción que se enseña al paciente renal.
- El IG se guarda como mediana de las mediciones publicadas, junto al número de
  estudios y el rango, porque varía mucho por variedad y preparación
  (arroz blanco: 17 a 114 según el estudio).
- No se asigna IG a alimentos sin hidratos ni a platos preparados sin IG publicado.
