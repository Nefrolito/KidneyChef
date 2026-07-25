# Genera public/recetas.json a partir de recetas_chilenas.py, para la
# feature "recetas con lo que tienes en el refrigerador".
#
# Traduce las claves de ingrediente de RECETAS (ej. "papa_cocida",
# "zanahoria_cocida") a un vocabulario más chico que el paciente puede marcar
# en un checklist (ej. "papa", "zanahoria" — sin distinguir crudo/cocido).
# Los condimentos de despensa casi siempre disponibles (sal, aceite, azúcar,
# polvo de hornear, color de ají) se excluyen: no tiene sentido preguntarle al
# paciente si tiene sal.
#
# No se ejecuta en cada carga de la app: se corre a mano cuando cambia
# recetas_chilenas.py, igual que el resto de los datos en datos/README.md.

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from recetas_chilenas import RECETAS

STAPLES = {"sal", "aceite", "azucar", "polvo_hornear", "aji_color"}

# clave RECETAS -> (id canónico, nombre para el checklist, categoría, id en
# nutrientes.json o None si no hay un equivalente confiable ahí).
#
# El cuarto valor importa para "generar receta con IA": esa feature solo
# puede combinar ingredientes que tengan un valor de potasio/fósforo/sodio
# auditado en nutrientes.json (nunca lo inventa la IA). Un ingrediente con
# nutrientes_id=None sigue sirviendo para matchear contra las 34/35 recetas
# fijas, pero no se ofrece como candidato para la receta generada por IA.
INGREDIENTES = {
    "harina": ("harina", "Harina", "Abarrotes", None),
    "manteca": ("manteca", "Manteca", "Abarrotes", None),
    "zapallo": ("zapallo", "Zapallo", "Verduras y legumbres", "calabaza"),
    "zapallo_cocido": ("zapallo", "Zapallo", "Verduras y legumbres", "calabaza"),
    "vacuno": ("vacuno", "Carne de vacuno", "Carnes y pescados", "res"),
    "cebolla": ("cebolla", "Cebolla", "Verduras y legumbres", "cebolla"),
    "huevo": ("huevo", "Huevo", "Lácteos y huevos", "huevo"),
    "queso_gauda": ("queso_gauda", "Queso gauda o mantecoso", "Lácteos y huevos", None),
    "pan_blanco": ("pan_blanco", "Pan blanco (marraqueta, hallulla)", "Abarrotes", "pan_blanco"),
    "vienesa": ("vienesa", "Vienesa", "Carnes y pescados", "salchicha"),
    "palta": ("palta", "Palta", "Verduras y legumbres", "aguacate"),
    "tomate": ("tomate", "Tomate", "Verduras y legumbres", "tomate"),
    "papa": ("papa", "Papa", "Verduras y legumbres", "papa"),
    "papa_cocida": ("papa", "Papa", "Verduras y legumbres", "papa"),
    "choclo_cocido": ("choclo", "Choclo", "Verduras y legumbres", "maiz"),
    "arroz_crudo": ("arroz", "Arroz", "Abarrotes", "arroz_blanco"),
    "porotos_negros": ("porotos_negros", "Porotos negros", "Verduras y legumbres", "frijol_negro"),
    "lenteja_cocida": ("lenteja", "Lentejas", "Verduras y legumbres", "lenteja"),
    "fideo_crudo": ("fideo", "Fideos", "Abarrotes", "pasta"),
    "zanahoria": ("zanahoria", "Zanahoria", "Verduras y legumbres", "zanahoria"),
    "zanahoria_cocida": ("zanahoria", "Zanahoria", "Verduras y legumbres", "zanahoria"),
    "pollo": ("pollo", "Pollo", "Carnes y pescados", "pollo"),
    "cerdo": ("cerdo", "Cerdo", "Carnes y pescados", "cerdo"),
    "merluza": ("merluza", "Merluza (o pescado blanco similar)", "Carnes y pescados", None),
    "leche": ("leche", "Leche", "Lácteos y huevos", "leche_entera"),
    "mantequilla": ("mantequilla", "Mantequilla", "Lácteos y huevos", "mantequilla"),
    "cilantro": ("cilantro", "Cilantro", "Verduras y legumbres", None),
    "trigo_mote": ("trigo_mote", "Mote de trigo", "Abarrotes", None),
    "durazno_conserva": ("durazno_conserva", "Durazno en conserva", "Otros", None),
    "acelga_cocida_ing": ("acelga", "Acelga", "Verduras y legumbres", "acelga"),
}

# Productos industriales que técnicamente "usan" pocos ingredientes pero no
# son algo que el paciente prepare en casa a partir de ellos.
NO_ARMABLES = {"longaniza", "queso_chanco"}

CATEGORIA_ORDEN = ["Carnes y pescados", "Verduras y legumbres", "Lácteos y huevos", "Abarrotes", "Otros"]


def main():
    public_dir = Path(__file__).parent.parent / "public"
    nutrientes_ids = {f["id"] for f in json.loads((public_dir / "nutrientes.json").read_text())}
    for clave, (canon_id, _nombre, _categoria, nutrientes_id) in INGREDIENTES.items():
        if nutrientes_id is not None and nutrientes_id not in nutrientes_ids:
            raise ValueError(f"nutrientes_id inexistente en nutrientes.json: {nutrientes_id} (ingrediente {clave})")

    ingredientes_vistos = {}
    recetas_out = []

    for id_, (nombre, _categoria_receta, _alias, ingredientes) in RECETAS.items():
        claves_canonicas = []
        for clave in ingredientes:
            if clave in STAPLES:
                continue
            if clave not in INGREDIENTES:
                raise ValueError(f"Ingrediente sin mapear en generar_recetas_json.py: {clave} (receta {id_})")
            canon_id, canon_nombre, canon_categoria, canon_nutrientes_id = INGREDIENTES[clave]
            if canon_id not in claves_canonicas:
                claves_canonicas.append(canon_id)
            ingredientes_vistos[canon_id] = (canon_nombre, canon_categoria, canon_nutrientes_id)

        recetas_out.append({
            "id": id_,
            "nombre": nombre,
            "ingredientes": claves_canonicas,
            "armable": id_ not in NO_ARMABLES,
        })

    ingredientes_out = [
        {"id": id_, "nombre": nombre, "categoria": categoria, "nutrientes_id": nutrientes_id}
        for id_, (nombre, categoria, nutrientes_id) in ingredientes_vistos.items()
    ]
    ingredientes_out.sort(key=lambda x: (CATEGORIA_ORDEN.index(x["categoria"]), x["nombre"]))

    (public_dir / "recetas.json").write_text(
        json.dumps(recetas_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (public_dir / "ingredientes-refrigerador.json").write_text(
        json.dumps(ingredientes_out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"{len(recetas_out)} recetas, {len(ingredientes_out)} ingredientes -> public/recetas.json, public/ingredientes-refrigerador.json")


if __name__ == "__main__":
    main()
