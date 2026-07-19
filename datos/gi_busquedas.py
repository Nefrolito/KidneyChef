# Búsquedas en la base de la Universidad de Sydney para asignar IG.
# Solo se asigna a alimentos con carbohidratos relevantes: el IG no tiene
# sentido en carnes, pescados, aceites, quesos ni verduras casi sin hidratos.
# Cada entrada: id nuestro -> lista de términos que deben aparecer en el nombre.

BUSCAR = {
 # Frutas
 "manzana": ["apple, raw"], "platano": ["banana, raw"], "naranja": ["orange, raw"],
 "pera": ["pear, raw"], "uva": ["grapes, raw"], "sandia": ["watermelon, raw"],
 "melon": ["cantaloupe"], "fresa": ["strawberr"], "kiwi": ["kiwi"],
 "pina": ["pineapple, raw"], "mango": ["mango, raw"], "durazno": ["peach, raw"],
 "ciruela": ["plum, raw"], "cereza": ["cherries"], "papaya": ["papaya, raw"],
 "mandarina": ["mandarin"], "higo": ["fig"], "datil": ["dates"],
 "arandano": ["blueberr"], "granada": ["pomegranate"], "guayaba": ["guava"],
 # Verduras con hidratos
 "papa": ["potato, boiled"], "papas_cocidas": ["potato, boiled"],
 "pure_papas": ["mashed potato"], "papas_duquesa": ["potato, roasted"],
 "papas_fritas": ["potato crisps"], "zanahoria": ["carrot"],
 "remolacha": ["beetroot"], "calabaza": ["pumpkin"], "maiz": ["sweet corn"],
 "choclo": ["sweet corn"],
 # Legumbres
 "frijol_negro": ["black beans"], "lenteja": ["lentils"], "garbanzo": ["chickpeas"],
 "guisante": ["green peas"], "haba": ["broad beans"],
 "lentejas_guisadas": ["lentils"], "porotos_granados": ["black beans"],
 # Cereales
 "arroz_blanco": ["white rice, boiled"], "arroz_integral": ["brown rice"],
 "pasta": ["spaghetti, white, boiled"], "tallarines_salsa": ["spaghetti, white, boiled"],
 "pan_blanco": ["white wheat flour bread"], "pan_integral": ["wholemeal wheat bread"],
 "pan_hamburguesa": ["hamburger bun"], "avena": ["porridge oats"],
 "quinoa": ["quinoa"], "tortilla_maiz": ["corn tortilla"],
 "tortilla_harina": ["wheat tortilla"], "marraqueta": ["white wheat flour bread"],
 "hallulla": ["white wheat flour bread"],
 # Lácteos
 "leche_entera": ["milk, full-fat"], "leche_descremada": ["milk, skim"],
 "yogur": ["yoghurt, natural"], "yogur_fruta": ["yoghurt, fruit"],
 "leche_almendra": ["almond milk"], "arroz_leche": ["rice pudding"],
 # Azúcares y postres
 "azucar": ["sucrose"], "miel": ["honey"], "mermelada": ["jam"],
 "manjar": ["condensed milk"], "chocolate": ["chocolate, dark"],
 "galleta": ["shortbread"], "helado": ["ice cream"],
 # Bebidas
 "cola": ["coca cola"], "bebida_gaseosa": ["fanta"], "jugo_naranja": ["orange juice"],
 "jugo_tomate": ["tomato juice"], "cerveza": ["beer"],
 # Otros con hidratos
 "pizza": ["pizza"], "empanada_pino": ["pastry"], "sopaipilla": ["doughnut"],
 "mote_huesillo": ["wheat, whole kernels"],
}
