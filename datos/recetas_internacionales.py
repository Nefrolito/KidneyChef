# Recetas internacionales: gramos de ingrediente por 100 g de plato terminado.
#
# Van en un archivo aparte de recetas_chilenas.py a propósito: aquellas fueron
# validadas clínicamente por Camilo en julio de 2026, y estas todavía no. No
# conviene mezclarlas hasta que pasen por la misma revisión.
#
# Por qué mediterránea: es de las cocinas más recomendadas en nefrología
# (mucha verdura, pescado, legumbre y aceite de oliva; poco procesado y poco
# sodio añadido), así que amplía la variedad sin pelear con la dieta renal.
#
# Cómo se calcularon sus valores nutricionales: sumando los alimentos actuales
# de public/nutrientes.json por los gramos de cada proporción
# (datos/calcular_platos.py). Se eligieron a propósito ingredientes cuya forma
# guardada en la base coincide con cómo se come el plato — la pasta y los
# garbanzos ya están cocidos en nutrientes.json, así que los gramos son de
# producto cocido, no crudo.
#
# PENDIENTE: las proporciones las escribió Claude, no salen de una tabla
# medida. Quedan marcadas _PENDIENTE_VALIDAR en nutrientes.json hasta que
# Camilo las revise, igual que estuvieron las 34 chilenas antes de julio.

RECETAS = {
 "pasta_berenjena": ("Pasta con berenjena y tomate", "Plato preparado",
    ["pasta con berenjena", "pasta al pomodoro"],
    {"pasta_cocida": 55, "berenjena": 20, "tomate": 15, "cebolla": 5, "ajo": 1,
     "aceite": 3, "sal": 0.4}),
 "tortilla_espanola": ("Tortilla española", "Plato preparado",
    ["tortilla de papas", "tortilla de patatas"],
    {"papa": 55, "huevo": 30, "cebolla": 10, "aceite": 5, "sal": 0.5}),
 "salmon_horno": ("Salmón al horno con limón", "Pescado",
    ["salmon al horno", "salmon con esparragos"],
    {"salmon": 65, "esparrago": 25, "limon": 5, "aceite": 3, "sal": 0.4}),
 "ensalada_garbanzos": ("Ensalada de garbanzos", "Legumbre",
    ["ensalada de garbanzos", "garbanzos con tomate"],
    {"garbanzo_cocido": 40, "tomate": 25, "pepino": 22, "cebolla": 6,
     "aceite": 4, "sal": 0.4}),
 "verduras_asadas": ("Verduras asadas al horno", "Verdura",
    ["verduras al horno", "verduras asadas", "pisto"],
    {"calabacin": 32, "pimiento": 26, "berenjena": 24, "cebolla": 14,
     "aceite": 4, "sal": 0.4}),
 "ensalada_atun": ("Ensalada de atún con verduras", "Plato preparado",
    ["ensalada de atun"],
    {"atun": 32, "lechuga": 26, "tomate": 24, "pepino": 12, "aceite": 4,
     "sal": 0.3}),
}

PREPARACIONES = {
 "pasta_berenjena": [
    "Corta la berenjena en cubos y déjala 20 minutos con un poco de sal para que largue agua; después enjuágala y sécala.",
    "Sofríe la cebolla y el ajo picados finos en el aceite.",
    "Agrega la berenjena y cocínala hasta que esté blanda y dorada.",
    "Suma el tomate picado y deja reducir a fuego suave hasta que se deshaga.",
    "Cuece la pasta en agua hirviendo hasta que esté al dente, escúrrela y mézclala con la salsa.",
    "Ajusta la sal al final: el tomate y la berenjena ya traen bastante sabor.",
 ],
 "tortilla_espanola": [
    "Pela las papas y córtalas en láminas delgadas.",
    "Si necesitas bajarle el potasio, cuece las papas en agua abundante y bota esa agua antes de seguir. La papa es lo que más potasio aporta a esta tortilla.",
    "Fríe las papas y la cebolla en el aceite a fuego suave, sin dorarlas, hasta que estén blandas. Escúrrelas.",
    "Bate los huevos, mézclalos con las papas y deja reposar 10 minutos.",
    "Cuaja la tortilla en la sartén a fuego medio, dándola vuelta con un plato, hasta que esté firme por dentro.",
 ],
 "salmon_horno": [
    "Seca el salmón y ponlo en una fuente con el aceite y unas rodajas de limón.",
    "Acomoda los espárragos alrededor.",
    "Hornea a 200 °C entre 12 y 15 minutos, hasta que el salmón se separe en láminas.",
    "Exprime el resto del limón al servir: el ácido reemplaza bien a la sal.",
 ],
 "ensalada_garbanzos": [
    "Si usas garbanzos secos, remójalos toda la noche, bota esa agua, cuécelos en agua nueva abundante y bota también esa agua.",
    "Corta el tomate y el pepino en cubos, y la cebolla en pluma fina.",
    "Deja la cebolla unos minutos en agua fría para quitarle el picor y escúrrela.",
    "Mezcla todo con el aceite y ajusta la sal al final.",
 ],
 "verduras_asadas": [
    "Corta el calabacín, el pimiento, la berenjena y la cebolla en trozos parejos.",
    "Revuélvelos con el aceite en una fuente para horno, en una sola capa.",
    "Hornea a 200 °C entre 30 y 40 minutos, revolviendo a la mitad, hasta que estén doradas.",
    "Ajusta la sal recién al sacarlas: asadas concentran su sabor y necesitan menos.",
 ],
 "ensalada_atun": [
    "Escurre bien el atún: el líquido de la lata es donde se concentra el sodio.",
    "Corta el tomate y el pepino en cubos, y trocea la lechuga.",
    "Mezcla todo con el aceite.",
    "Ajusta la sal al final, teniendo en cuenta que el atún de lata ya aporta bastante.",
 ],
}
