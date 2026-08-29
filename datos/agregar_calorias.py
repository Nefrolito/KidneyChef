# Agrega calorias_kcal a public/nutrientes.json, misma fuente que el resto
# (USDA FoodData Central, SR Legacy 2018-04) y mismo criterio: valor ya cocido
# cuando el alimento se prepara hervido/horneado (ver README, seccion Criterios
# aplicados). Ya se corrio una vez (2026-08-12); se deja para volver a correrlo
# si se agregan alimentos nuevos a nutrientes.json.
#
# KCAL_POR_FDC_ID viene del bulk download oficial (mismo zip que cita el
# README), no de la API publica de FoodData Central: la API con DEMO_KEY tiene
# un limite de 10 solicitudes/hora que no alcanza para 166 alimentos.

import json
from pathlib import Path

NUTR_PATH = Path(__file__).parent.parent / "public" / "nutrientes.json"

# fdc_id -> kcal por 100 g, para los 131 alimentos que ya tienen fdc_id propio
# en nutrientes.json (fuente.fdc_id). El comentario es la descripcion USDA tal
# cual, para poder auditar cada eleccion sin volver a bajar el dataset.
KCAL_POR_FDC_ID = {
    "167746": 29.0,  # Lemons, raw, without peel
    "167755": 52.0,  # Raspberries, raw
    "167762": 32.0,  # Strawberries, raw
    "167765": 30.0,  # Watermelon, raw
    "167812": 518.0,  # Pork, fresh, belly, raw
    "167853": 277.0,  # Pork, fresh, spareribs, separable lean and fat, raw
    "167914": 548.0,  # Pork, cured, bacon, cooked, baked
    "168153": 61.0,  # Kiwifruit, green, raw
    "168191": 277.0,  # Dates, medjool
    "168224": 136.0,  # Pork, fresh, leg (ham), whole, separable lean only, raw
    "168238": 170.0,  # Pork, fresh, loin, center loin (chops), bone-in, separable lean and fat, raw
    "168240": 180.0,  # Pork, fresh, loin, center loin (chops), bone-in, separable lean only, cooked, broiled
    "168389": 20.0,  # Asparagus, raw
    "168409": 15.0,  # Cucumber, with peel, raw
    "168429": 13.0,  # Lettuce, butterhead (includes boston and bibb types), raw
    "168448": 26.0,  # Pumpkin, raw
    "168462": 23.0,  # Spinach, raw
    "168556": 101.0,  # Catsup
    "168609": 149.0,  # Beef, flank, steak, separable lean only, trimmed to 0" fat, choice, raw
    "168746": 43.0,  # Alcoholic beverage, beer, regular, all
    "168878": 130.0,  # Rice, white, long-grain, regular, enriched, cooked
    "168917": 120.0,  # Quinoa, cooked
    "169092": 34.0,  # Melons, cantaloupe, raw
    "169094": 116.0,  # Olives, ripe, canned (small-extra large)
    "169097": 47.0,  # Oranges, raw, all commercial varieties
    "169100": 49.0,  # Orange juice, chilled, includes from concentrate
    "169105": 53.0,  # Tangerines, (mandarin oranges), raw
    "169118": 57.0,  # Pears, raw
    "169124": 50.0,  # Pineapple, raw, all varieties
    "169134": 83.0,  # Pomegranates, raw
    "169145": 43.0,  # Beets, raw
    "169228": 25.0,  # Eggplant, raw
    "169230": 149.0,  # Garlic, raw
    "169251": 22.0,  # Mushrooms, white, raw
    "169291": 17.0,  # Squash, summer, zucchini, includes skin, raw
    "169640": 304.0,  # Honey
    "169641": 278.0,  # Jams and preserves
    "169677": 532.0,  # Snacks, potato chips, plain, salted
    "169704": 123.0,  # Rice, brown, long-grain, cooked (Includes foods for USDA's Food Distribution Program)
    "169737": 158.0,  # Pasta, cooked, enriched, without added salt
    "169910": 60.0,  # Mangos, raw
    "169926": 43.0,  # Papayas, raw
    "169928": 39.0,  # Peaches, yellow, raw
    "169949": 46.0,  # Plums, raw
    "169975": 25.0,  # Cabbage, raw
    "169986": 25.0,  # Cauliflower, raw
    "169988": 14.0,  # Celery, raw
    "169991": 19.0,  # Chard, swiss, raw
    "169999": 96.0,  # Corn, sweet, yellow, cooked, boiled, drained, without salt
    "170000": 40.0,  # Onions, raw
    "170026": 77.0,  # Potatoes, flesh and skin, raw
    "170108": 26.0,  # Peppers, sweet, red, raw
    "170174": 19.0,  # Nuts, coconut water (liquid from coconuts)
    "170187": 654.0,  # Nuts, walnuts, english
    "170273": 598.0,  # Chocolate, dark, 70-85% cacao solids
    "170317": 268.0,  # Pizza, cheese topping, regular crust, frozen, cooked
    "170379": 34.0,  # Broccoli, raw
    "170393": 41.0,  # Carrots, raw
    "170420": 84.0,  # Peas, green, cooked, boiled, drained, without salt
    "170457": 18.0,  # Tomatoes, red, ripe, raw, year round average
    "170458": 17.0,  # Tomato juice, canned, with salt added
    "170554": 486.0,  # Seeds, chia seeds, dried
    "170562": 584.0,  # Seeds, sunflower seed kernels, dried
    "170567": 579.0,  # Nuts, almonds
    "170827": 240.0,  # Beef, chuck, short ribs, boneless, separable lean and fat, trimmed to 0" fat, choice, raw
    "170853": 366.0,  # Cheese, pasteurized process, American, fortified with vitamin D
    "170889": 99.0,  # Yogurt, fruit, low fat,9 g protein/8 oz
    "171009": 680.0,  # Salad dressing, mayonnaise, regular
    "171077": 120.0,  # Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw
    "171269": 34.0,  # Milk, nonfat, fluid, with added vitamin A and vitamin D (fat free or skim)
    "171284": 61.0,  # Yogurt, plain, whole milk
    "171287": 143.0,  # Egg, whole, raw, fresh
    "171477": 165.0,  # Chicken, broilers or fryers, breast, meat only, cooked, roasted
    "171561": 170.0,  # Soup, beef broth, cubed, dry
    "171688": 52.0,  # Apples, raw, with skin (Includes foods for USDA's Food Distribution Program)
    "171705": 160.0,  # Avocados, raw, all commercial varieties
    "171711": 57.0,  # Blueberries, raw
    "171719": 63.0,  # Cherries, sweet, raw
    "171768": 143.0,  # Beef, loin, tenderloin steak, boneless, separable lean only, trimmed to 0" fat, choice, raw
    "171796": 215.0,  # Beef, ground, 85% lean meat / 15% fat, raw (Includes foods for USDA's Food Distribution Program)
    "171890": 1.0,  # Beverages, coffee, brewed, prepared with tap water
    "172012": 299.0,  # Bologna, beef
    "172217": 61.0,  # Milk, whole, 3.25% milkfat, without added vitamin A and vitamin D
    "172223": 299.0,  # Cheese, fresh, queso fresco
    "172234": 60.0,  # Mustard, prepared, yellow
    "172347": 713.0,  # Margarine, regular, 80% fat, composite, tub, with salt
    "172378": 214.0,  # Chicken, broilers or fryers, leg, meat and skin, raw
    "172390": 191.0,  # Chicken, broilers or fryers, wing, meat and skin, raw
    "172421": 116.0,  # Lentils, mature seeds, cooked, boiled, without salt
    "172430": 567.0,  # Peanuts, all types, raw
    "172475": 144.0,  # Tofu, raw, firm, prepared with calcium sulfate
    "172688": 252.0,  # Bread, whole-wheat, commercially prepared
    "172796": 279.0,  # Rolls, hamburger or hotdog, plain
    "172818": 267.0,  # Bread, white, commercially prepared, low sodium, no salt
    "172930": 319.0,  # Pate, liver, not specified, canned
    "172989": 371.0,  # Cereals, QUAKER, Quick Oats, Dry
    "173021": 74.0,  # Figs, raw
    "173044": 68.0,  # Guavas, common, raw
    "173190": 85.0,  # Alcoholic beverage, wine, table, red
    "173205": 41.0,  # Beverages, carbonated, lemon-lime soda, no caffeine
    "173227": 1.0,  # Beverages, tea, black, brewed, prepared with tap water
    "173410": 717.0,  # Butter, salted
    "173414": 403.0,  # Cheese, cheddar (Includes foods for USDA's Food Distribution Program)
    "173418": 350.0,  # Cheese, cream
    "173461": 315.0,  # Dulce de Leche
    "173468": 0.0,  # Salt, table
    "173709": 86.0,  # Fish, tuna, light, canned in water, drained solids (Includes foods for USDA's Food Distribution Program)
    "173713": 90.0,  # Fish, whiting, mixed species, raw
    "175161": 116.0,  # Fish, whiting, mixed species, cooked, dry heat
    "173735": 132.0,  # Beans, black, mature seeds, cooked, boiled, without salt
    "173753": 110.0,  # Broadbeans (fava beans), mature seeds, cooked, boiled, without salt
    "173757": 164.0,  # Chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt
    "173862": 315.0,  # Frankfurter, beef, unheated
    "173864": 164.0,  # Ham, sliced, regular (approximately 11% fat)
    "173944": 89.0,  # Bananas, raw
    "173999": 124.0,  # Beef, round, eye of round roast, boneless, separable lean only, trimmed to 0" fat, choice, raw
    "174003": 149.0,  # Beef, loin, top loin steak, boneless, lip off, separable lean only, trimmed to 0" fat, choice, raw
    "174032": 250.0,  # Beef, ground, 85% lean meat / 15% fat, patty, cooked, broiled
    "174056": 139.0,  # Beef, chuck, arm pot roast, separable lean only, trimmed to 1/8" fat, choice, raw
    "174058": 140.0,  # Beef, round, bottom round, roast, separable lean only, trimmed to 1/8" fat, choice, raw
    "174278": 60.0,  # Soy sauce made from soy (tamari)
    "174519": 127.0,  # Turkey, breast, from whole bird, meat only, with added solution, roasted
    "174683": 69.0,  # Grapes, red or green (European type, such as Thompson seedless), raw
    "174832": 15.0,  # Beverages, almond milk, unsweetened, shelf stable
    "174852": 42.0,  # Beverages, carbonated, cola, regular
    "174971": 464.0,  # Cookies, sugar, commercially prepared, regular (includes vanilla)
    "175036": 218.0,  # Tortillas, ready-to-bake or -fry, corn
    "175037": 306.0,  # Tortillas, ready-to-bake or -fry, flour, refrigerated
    "175121": 156.0,  # Fish, mackerel, jack, canned, drained solids
    "175139": 208.0,  # Fish, sardine, Atlantic, canned in oil, drained solids with bone
    "175168": 206.0,  # Fish, salmon, Atlantic, farmed, cooked, dry heat
    "175180": 99.0,  # Crustaceans, shrimp, cooked
    # Agregados el 2026-08-24 junto con los seis alimentos que faltaban.
    "169997": 23.0,  # Coriander (cilantro) leaves, raw
    "171241": 356.0,  # Cheese, gouda
    "168894": 364.0,  # Wheat flour, white, all-purpose, enriched, bleached
    "171401": 902.0,  # Lard
    "170287": 83.0,  # Bulgur, cooked
    "169112": 74.0,  # Peaches, canned, heavy syrup pack, solids and liquids
}

# Alimentos calculados desde una receta (fuente.receta_g_por_100g), no desde un
# fdc_id propio: platos chilenos y preparaciones caseras. Cada clave de
# ingrediente se resuelve contra KCAL_POR_FDC_ID (via INGREDIENTE_A_CANONICO,
# reusando el fdc_id de un alimento que YA esta en nutrientes.json) o, si no
# hay equivalente canonico, contra un fdc_id propio buscado a mano en USDA
# SR Legacy y verificado (INGREDIENTE_KCAL_DIRECTO).
INGREDIENTE_A_CANONICO = {
    "cebolla": "cebolla", "huevo": "huevo", "leche": "leche_entera",
    "mantequilla": "mantequilla", "palta": "aguacate", "pan_blanco": "pan_blanco",
    "papa": "papa", "pollo": "pollo", "tomate": "tomate", "vacuno": "res",
    "zanahoria": "zanahoria", "cerdo": "cerdo", "choclo_cocido": "maiz",
    "lenteja_cocida": "lenteja", "porotos_negros": "frijol_negro",
    "arroz_crudo": "arroz_blanco", "fideo_crudo": "pasta", "vienesa": "salchicha",
    "merluza": "merluza", "merluza_cocida": "merluza_cocida",
    "sal": "sal", "zapallo": "calabaza",
}

# Ingredientes SIN equivalente canonico en nutrientes.json (condimentos de
# despensa, o casos donde la receta pide la version YA COCIDA de algo que en
# nutrientes.json solo existe crudo, ej. "papa" vs "papa_cocida" -- misma
# logica de lixiviacion de potasio que ya aplica el resto de la app).
INGREDIENTE_KCAL_DIRECTO = {
    "aceite": 884.0,           # Oil, canola (FDC 172336)
    "acelga_cocida_ing": 20.0,  # Chard, swiss, cooked, boiled, drained, without salt (FDC 170401)
    "aji_color": 282.0,        # Spices, paprika (FDC 171329)
    "azucar": 387.0,           # Sugars, granulated (FDC 169655)
    "cilantro": 23.0,          # Coriander (cilantro) leaves, raw (FDC 169997)
    "durazno_conserva": 74.0,  # Peaches, canned, heavy syrup, solids and liquids (FDC 169112)
    "harina": 364.0,           # Wheat flour, white, all-purpose, enriched, bleached (FDC 168894)
    "manteca": 900.0,          # Shortening, household, lard and vegetable oil (FDC 172327)
    "polvo_hornear": 51.0,     # Leavening agents, baking powder, double-acting, straight phosphate (FDC 172804)
    "queso_gauda": 356.0,      # Cheese, gouda (FDC 171241)
    # Grano de trigo crudo: USDA no tiene "mote" (trigo pelado y cocido, muy
    # especifico de Chile) -- aproximacion declarada, no una cifra chilena medida.
    "trigo_mote": 327.0,       # Wheat, hard red winter (FDC 168890)
    "papa_cocida": 86.0,       # Potatoes, boiled, cooked without skin, without salt (FDC 170440)
    "zapallo_cocido": 20.0,    # Pumpkin, cooked, boiled, drained, without salt (FDC 168449)
    "zanahoria_cocida": 35.0,  # Carrots, cooked, boiled, drained, without salt (FDC 170394)
}


def main():
    data = json.loads(NUTR_PATH.read_text(encoding="utf-8"))

    kcal_por_id = {}
    for item in data:
        fdc = item.get("fuente", {}).get("fdc_id")
        if fdc and str(fdc) in KCAL_POR_FDC_ID:
            kcal_por_id[item["id"]] = KCAL_POR_FDC_ID[str(fdc)]

    ingrediente_kcal = dict(INGREDIENTE_KCAL_DIRECTO)
    for clave, canon_id in INGREDIENTE_A_CANONICO.items():
        if canon_id not in kcal_por_id:
            raise ValueError(f"Sin kcal canonico para {canon_id} (ingrediente {clave})")
        ingrediente_kcal[clave] = kcal_por_id[canon_id]

    nuevo_data = []
    calculados, directos, sin_dato = 0, 0, []
    for item in data:
        fdc = item.get("fuente", {}).get("fdc_id")
        if fdc and str(fdc) in KCAL_POR_FDC_ID:
            kcal = KCAL_POR_FDC_ID[str(fdc)]
            directos += 1
        else:
            receta = item.get("fuente", {}).get("receta_g_por_100g")
            if not receta:
                sin_dato.append(item["id"])
                nuevo_data.append(item)
                continue
            total = 0.0
            for ingrediente, gramos in receta.items():
                if ingrediente not in ingrediente_kcal:
                    raise ValueError(f"Ingrediente sin kcal: {ingrediente} (item {item['id']})")
                total += ingrediente_kcal[ingrediente] * gramos / 100.0
            kcal = round(total, 1)
            calculados += 1

        nuevo_item = {}
        for k, v in item.items():
            nuevo_item[k] = v
            if k == "carbohidratos_g":
                nuevo_item["calorias_kcal"] = kcal
        nuevo_data.append(nuevo_item)

    print(f"{directos} directos desde fdc_id, {calculados} calculados desde receta, {len(sin_dato)} sin dato: {sin_dato}")
    NUTR_PATH.write_text(json.dumps(nuevo_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("nutrientes.json actualizado.")


if __name__ == "__main__":
    main()
