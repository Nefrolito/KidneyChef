# Calcula el aporte nutricional de un plato desde sus proporciones y lo escribe
# en public/nutrientes.json.
#
# Este script no existía: los 35 platos chilenos originales se calcularon una
# vez y quedaron guardados, pero sin la herramienta para rehacerlo. Al intentar
# reproducirlos con los alimentos actuales, 3 de los 8 que se pueden recalcular
# no calzan — el caso más claro es "Merluza al vapor" (401 mg de potasio
# guardados contra 242 recalculados), porque el valor original salió de pescado
# COCIDO y el alimento `merluza` que hay hoy en la base es crudo. Por eso este
# script NO toca los platos que ya están: solo agrega los que se le pidan.
#
# Ocho claves de ingrediente de las recetas chilenas (papa_cocida,
# zapallo_cocido, zanahoria_cocida, acelga_cocida_ing, aceite, azucar,
# aji_color, polvo_hornear) no tienen alimento equivalente en nutrientes.json,
# solo calorías en agregar_calorias.py. Mientras eso siga así, esos platos no
# se pueden recalcular acá.
#
# Uso: python3 datos/calcular_platos.py

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recetas_internacionales import RECETAS

NUTRIENTES = ["potasio_mg", "fosforo_mg", "sodio_mg", "carbohidratos_g", "calorias_kcal"]

# Clave de ingrediente -> id en nutrientes.json. Se eligieron formas cuya
# versión guardada coincide con cómo se come el plato: `pasta` y `garbanzo` ya
# son el producto cocido en la base, así que los gramos de la receta son de
# producto cocido y no crudo.
#
# El aceite es el único sin equivalente: aporta 0 mg de potasio, fósforo y
# sodio, así que su ausencia no cambia el semáforo (sí deja las calorías del
# plato algo por debajo de la realidad, lo que queda declarado en la nota).
INGREDIENTE_A_ALIMENTO = {
    "pasta_cocida": "pasta",
    "garbanzo_cocido": "garbanzo",
    "berenjena": "berenjena",
    "tomate": "tomate",
    "cebolla": "cebolla",
    "ajo": "ajo",
    "papa": "papa",
    "huevo": "huevo",
    "salmon": "salmon",
    "limon": "limon",
    "esparrago": "esparrago",
    "pepino": "pepino",
    "calabacin": "calabacin",
    "pimiento": "pimiento",
    "atun": "atun",
    "lechuga": "lechuga",
    "sal": "sal",
    "aceite": None,
}

NOTA = (
    "Proporciones escritas para KidneyChef, calculadas sumando los alimentos de "
    "nutrientes.json por los gramos de la receta (datos/calcular_platos.py). El aceite "
    "no está en la base: no afecta al potasio, fósforo ni sodio, pero deja las calorías "
    "algo por debajo de la realidad."
)
PENDIENTE = (
    "Las proporciones no salen de una tabla medida: las escribió Claude a partir de "
    "preparaciones estándar. Requieren la misma validación clínica de Camilo que "
    "recibieron las 34 recetas chilenas en julio de 2026."
)


def calcular(receta, foods):
    total = {n: 0.0 for n in NUTRIENTES}
    for clave, gramos in receta.items():
        alimento_id = INGREDIENTE_A_ALIMENTO.get(clave, "__falta__")
        if alimento_id is None:
            continue
        if alimento_id == "__falta__":
            raise ValueError(f"Ingrediente sin mapear en calcular_platos.py: {clave}")
        alimento = foods.get(alimento_id)
        if alimento is None:
            raise ValueError(f"Alimento inexistente en nutrientes.json: {alimento_id}")
        for n in NUTRIENTES:
            total[n] += (alimento.get(n) or 0) * gramos / 100
    return total


def main():
    ruta = Path(__file__).parent.parent / "public" / "nutrientes.json"
    data = json.loads(ruta.read_text())
    foods = {f["id"]: f for f in data}

    agregados = 0
    for rid, (nombre, categoria, alias, receta) in RECETAS.items():
        total = calcular(receta, foods)
        entrada = {
            "id": rid,
            "nombre": nombre,
            "categoria": categoria,
            "alias": alias,
            "potasio_mg": round(total["potasio_mg"]),
            "fosforo_mg": round(total["fosforo_mg"]),
            "sodio_mg": round(total["sodio_mg"]),
            "carbohidratos_g": round(total["carbohidratos_g"], 1),
            "calorias_kcal": round(total["calorias_kcal"], 1),
            "aditivos_fosfato": None,
            "fuente": {
                "base": "Calculado desde receta con ingredientes USDA SR Legacy 2018-04",
                "receta_g_por_100g": receta,
                "_nota": NOTA,
                "_PENDIENTE_VALIDAR": PENDIENTE,
            },
            "indice_glucemico": None,
        }
        existente = next((i for i, f in enumerate(data) if f["id"] == rid), None)
        if existente is None:
            data.append(entrada)
            agregados += 1
        else:
            data[existente] = entrada

    ruta.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"{len(RECETAS)} platos calculados ({agregados} nuevos) -> public/nutrientes.json")


if __name__ == "__main__":
    main()
