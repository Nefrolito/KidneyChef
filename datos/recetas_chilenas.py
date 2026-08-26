# Recetas de platos chilenos: gramos de ingrediente por 100 g de plato terminado.
# Proporciones de preparación casera estándar, validadas por Camilo (2026-07-22).
# "sal" se expresa en gramos e incluye la sal de cocción habitual.

RECETAS = {
 "marraqueta": ("Marraqueta / pan batido", "Cereal",
    ["marraqueta","pan batido","pan frances"],
    {"harina": 62, "sal": 1.2}),
 "hallulla": ("Hallulla", "Cereal", ["hallulla"],
    {"harina": 58, "manteca": 8, "sal": 1.1, "polvo_hornear": 1.5}),
 "sopaipilla": ("Sopaipilla", "Cereal", ["sopaipillas"],
    {"harina": 45, "zapallo": 20, "manteca": 14, "sal": 1.0}),
 "empanada_pino": ("Empanada de pino", "Procesado", ["empanada","empanada de horno"],
    {"harina": 34, "vacuno": 20, "cebolla": 22, "huevo": 6, "manteca": 7, "sal": 1.2, "aji_color": 0.3}),
 "empanada_queso": ("Empanada de queso", "Procesado", ["empanada frita"],
    {"harina": 38, "queso_gauda": 26, "aceite": 12, "sal": 1.0}),
 "completo": ("Completo", "Procesado", ["hot dog","completo italiano"],
    {"pan_blanco": 35, "vienesa": 25, "palta": 18, "tomate": 15, "sal": 0.6}),
 "churrasco": ("Churrasco / sándwich de carne", "Procesado", ["sandwich de carne","barros luco"],
    {"pan_blanco": 40, "vacuno": 35, "queso_gauda": 10, "sal": 0.8}),
 "cazuela_vacuno": ("Cazuela de vacuno", "Plato preparado", ["cazuela"],
    {"vacuno": 14, "papa_cocida": 22, "zapallo_cocido": 14, "choclo_cocido": 8, "cebolla": 5, "arroz_crudo": 2, "sal": 0.7}),
 "cazuela_ave": ("Cazuela de ave", "Plato preparado", ["cazuela de pollo"],
    {"pollo": 14, "papa_cocida": 22, "zapallo_cocido": 14, "choclo_cocido": 8, "cebolla": 5, "arroz_crudo": 2, "sal": 0.7}),
 "charquican": ("Charquicán", "Plato preparado", ["charquican"],
    {"papa_cocida": 34, "zapallo_cocido": 22, "vacuno": 12, "choclo_cocido": 8, "cebolla": 6, "aceite": 3, "sal": 0.8}),
 "porotos_granados": ("Porotos granados", "Legumbre", ["porotos con mazamorra"],
    {"porotos_negros": 34, "zapallo_cocido": 22, "choclo_cocido": 16, "cebolla": 6, "aceite": 3, "sal": 0.8}),
 "pastel_choclo": ("Pastel de choclo", "Plato preparado", ["pastel de maiz"],
    {"choclo_cocido": 48, "vacuno": 16, "cebolla": 10, "leche": 8, "huevo": 5, "azucar": 3, "sal": 0.9}),
 "humita": ("Humita", "Plato preparado", ["humitas"],
    {"choclo_cocido": 68, "cebolla": 8, "leche": 6, "manteca": 5, "sal": 0.9}),
 "carbonada": ("Carbonada", "Plato preparado", ["carbonada"],
    {"vacuno": 12, "papa_cocida": 20, "zapallo_cocido": 12, "zanahoria_cocida": 8, "choclo_cocido": 7, "fideo_crudo": 3, "cebolla": 5, "sal": 0.7}),
 "lentejas_guisadas": ("Lentejas guisadas", "Legumbre", ["lentejas"],
    {"lenteja_cocida": 62, "cebolla": 8, "zanahoria": 6, "aceite": 3, "sal": 0.8}),
 "arroz_pollo": ("Arroz con pollo", "Plato preparado", ["arroz con pollo"],
    {"arroz_crudo": 26, "pollo": 18, "cebolla": 6, "zanahoria": 5, "aceite": 3, "sal": 0.8}),
 "tallarines_salsa": ("Tallarines con salsa de tomate", "Plato preparado", ["tallarines","pasta con salsa"],
    {"fideo_crudo": 30, "tomate": 30, "cebolla": 6, "aceite": 3, "sal": 0.8}),
 "pure_papas": ("Puré de papas", "Verdura", ["pure"],
    {"papa_cocida": 72, "leche": 14, "mantequilla": 5, "sal": 0.7}),
 "ensalada_chilena": ("Ensalada chilena", "Verdura", ["ensalada de tomate y cebolla"],
    {"tomate": 62, "cebolla": 28, "aceite": 5, "sal": 0.6}),
 "pebre": ("Pebre", "Condimento", ["pebre chileno"],
    {"tomate": 45, "cebolla": 30, "cilantro": 10, "aceite": 8, "sal": 1.2}),
 "papas_cocidas": ("Papas cocidas", "Verdura", ["papa cocida","papas hervidas"],
    {"papa_cocida": 98, "sal": 0.4}),
 "papas_duquesa": ("Papas doradas al horno", "Verdura", ["papas al horno"],
    {"papa": 85, "aceite": 8, "sal": 0.7}),
 "pollo_asado": ("Pollo asado", "Carne", ["pollo al horno"],
    {"pollo": 92, "aceite": 3, "sal": 1.0}),
 "costillar_cerdo": ("Costillar de cerdo", "Carne", ["costillar"],
    {"cerdo": 92, "aceite": 3, "sal": 1.1}),
 "merluza_frita": ("Merluza frita", "Pescado", ["pescado frito","merluza"],
    {"merluza": 74, "harina": 8, "aceite": 12, "sal": 0.9}),
 "merluza_vapor": ("Merluza al vapor", "Pescado", ["pescado al vapor"],
    {"merluza": 97, "sal": 0.5}),
 "chorrillana": ("Chorrillana", "Plato preparado", ["chorrillana"],
    {"papa": 42, "vacuno": 22, "cebolla": 14, "huevo": 10, "aceite": 9, "sal": 1.0}),
 "arroz_leche": ("Arroz con leche", "Postre", ["arroz con leche"],
    {"arroz_crudo": 14, "leche": 62, "azucar": 10}),
 "leche_asada": ("Leche asada", "Postre", ["leche asada","flan"],
    {"leche": 66, "huevo": 18, "azucar": 14}),
 "mote_huesillo": ("Mote con huesillo", "Postre", ["mote con huesillo"],
    {"trigo_mote": 12, "durazno_conserva": 16, "azucar": 10}),
 "acelga_cocida": ("Acelga cocida", "Verdura", ["acelgas"],
    {"acelga_cocida_ing": 96, "aceite": 2, "sal": 0.5}),
 "longaniza": ("Longaniza", "Procesado", ["longaniza chilena"],
    {"cerdo": 78, "manteca": 12, "sal": 2.2, "aji_color": 0.5}),
 "queso_chanco": ("Queso chanco", "Lácteo", ["queso chanco","queso mantecoso"],
    {"queso_gauda": 100}),
 "palta_molida": ("Palta molida", "Fruta", ["palta molida","guacamole"],
    {"palta": 92, "sal": 0.6}),
 "te_con_leche": ("Té con leche", "Bebida", ["te con leche"],
    {"leche": 25, "azucar": 5}),
}


# Pasos de preparación de cada receta, en orden.
#
# ACTUALMENTE SIN USO. La app dejó de ofrecerle estas recetas al paciente
# (2026-08-24): casi todas se pasan del sodio o del fósforo que puede
# permitirse — un completo gasta el 92% de su meta diaria de sodio— así que
# proponerlas como "recetas que puedes preparar" no correspondía. Ahora las
# recetas se generan con IA ajustadas a su presupuesto, usando estos nombres
# solo como referencia de qué le resulta familiar. Los pasos se conservan por
# si el recetario vuelve en otra forma; generar_recetas_json.py ya no los lee.
#
# Las proporciones de arriba las validó Camilo clínicamente; estos pasos son
# contenido culinario escrito después (2026-08-24) y no cambian ninguna cifra:
# el semáforo se sigue calculando desde las proporciones y nutrientes.json.
# Igual conviene que Camilo los lea antes de publicarlos.
#
# Criterio renal: donde la receta lleva papa, zapallo, zanahoria o legumbres,
# el paso dice explícitamente que se cuezan en agua abundante y se bote esa
# agua. Es la doble cocción que se le enseña al paciente renal para lixiviar
# potasio, y es justo el momento en que se aplica.
#
# Dos entradas no llevan preparación a propósito (NO_ARMABLES en
# generar_recetas_json.py): la longaniza y el queso chanco son productos que se
# compran hechos, no algo que el paciente prepare en casa.

PREPARACIONES = {
 "marraqueta": [
    "Disuelve la levadura en agua tibia con una pizca de azúcar y deja espumar 10 minutos.",
    "Agrega la harina y la sal, y amasa hasta obtener una masa lisa y elástica.",
    "Deja leudar tapada hasta que doble su volumen, más o menos 1 hora.",
    "Forma los panes, marca el corte al medio y deja leudar otros 30 minutos.",
    "Hornea a 220 °C entre 18 y 22 minutos, hasta que suenen huecos al golpearlos.",
 ],
 "hallulla": [
    "Mezcla la harina con el polvo de hornear y la sal.",
    "Agrega la manteca en trozos y ténsala con los dedos hasta formar una arenilla.",
    "Incorpora agua tibia de a poco y amasa hasta que la masa quede suave.",
    "Uslerea a 1 cm de grosor, corta discos y pínchalos con un tenedor.",
    "Hornea a 200 °C entre 15 y 18 minutos, hasta que estén doradas.",
 ],
 "sopaipilla": [
    "Cuece el zapallo en agua abundante hasta que esté blando y bota el agua de cocción.",
    "Muele el zapallo y mézclalo tibio con la harina, la manteca derretida y la sal.",
    "Amasa hasta que quede suave, uslerea y corta los discos.",
    "Fríe en aceite caliente hasta que estén doradas por ambos lados.",
    "Escúrrelas sobre papel absorbente antes de servir.",
 ],
 "empanada_pino": [
    "Sofríe la cebolla picada fina hasta que esté transparente y agrega el ají de color.",
    "Suma la carne molida y cocínala hasta que no queden partes rosadas. Deja enfriar el pino.",
    "Cuece los huevos, pélalos y córtalos en gajos.",
    "Prepara la masa con harina, manteca, sal y agua tibia, y uslerea los discos.",
    "Rellena con el pino frío y el huevo, cierra sellando bien los bordes.",
    "Hornea a 200 °C entre 25 y 30 minutos, hasta que estén doradas.",
 ],
 "empanada_queso": [
    "Prepara la masa con harina, sal, aceite y agua tibia, y uslerea discos delgados.",
    "Pon el queso en el centro de cada disco, sin llegar a los bordes.",
    "Cierra sellando con agua y presionando bien, para que no se escape el queso al freír.",
    "Fríe en aceite caliente, dando vuelta una vez, hasta que estén doradas.",
    "Escúrrelas sobre papel absorbente y sírvelas calientes.",
 ],
 "completo": [
    "Cuece las vienesas en agua caliente sin dejar que hiervan fuerte.",
    "Calienta el pan unos minutos.",
    "Muele la palta con un poco de sal y pica el tomate en cubos chicos.",
    "Arma el completo con la vienesa, el tomate y la palta encima.",
 ],
 "churrasco": [
    "Aliña la carne y ásala en una plancha bien caliente hasta que esté cocida por dentro.",
    "Calienta el pan y ábrelo por la mitad.",
    "Pon la carne caliente y el queso encima, para que alcance a derretirse.",
    "Cierra el sándwich y sírvelo de inmediato.",
 ],
 "cazuela_vacuno": [
    "Pon la carne en una olla con agua fría y deja hervir, retirando la espuma que suba.",
    "Pela y corta la papa y el zapallo en trozos grandes. Cuécelos aparte en agua abundante y bota esa agua antes de sumarlos a la olla.",
    "Agrega la cebolla, el choclo y el arroz a la olla de la carne.",
    "Suma la papa y el zapallo ya precocidos y cocina hasta que todo esté blando.",
    "Ajusta la sal al final, cuando el caldo ya redujo.",
 ],
 "cazuela_ave": [
    "Pon las presas de pollo en una olla con agua fría y deja hervir, retirando la espuma.",
    "Pela y corta la papa y el zapallo. Cuécelos aparte en agua abundante y bota esa agua antes de sumarlos.",
    "Agrega la cebolla, el choclo y el arroz a la olla del pollo.",
    "Suma la papa y el zapallo precocidos y cocina hasta que el pollo esté bien cocido por dentro.",
    "Ajusta la sal al final.",
 ],
 "charquican": [
    "Cuece la papa y el zapallo en trozos, en agua abundante, y bota esa agua de cocción.",
    "Sofríe la cebolla picada en el aceite hasta que esté transparente.",
    "Agrega la carne y cocínala hasta que no queden partes rosadas.",
    "Suma la papa y el zapallo, y muélelos junto con la carne hasta formar una pasta gruesa.",
    "Incorpora el choclo, ajusta la sal y deja tomar sabor unos minutos.",
 ],
 "porotos_granados": [
    "Remoja los porotos varias horas o toda la noche, y bota esa agua de remojo.",
    "Cuécelos en agua nueva abundante hasta que estén blandos, y bota también esa agua.",
    "Sofríe la cebolla en el aceite hasta que esté transparente.",
    "Agrega el zapallo en cubos y el choclo, y cocina hasta que el zapallo se deshaga.",
    "Junta todo con los porotos, ajusta la sal y deja espesar a fuego suave.",
 ],
 "pastel_choclo": [
    "Sofríe la cebolla picada fina y agrega la carne, cocinándola hasta que no quede rosada. Deja enfriar el pino.",
    "Cuece los huevos y córtalos en gajos.",
    "Muele el choclo y cocínalo con la leche a fuego suave, revolviendo, hasta que espese.",
    "Arma en una fuente: primero el pino, encima el huevo, y cubre con la pasta de choclo.",
    "Espolvorea el azúcar y gratina en el horno hasta que la superficie quede dorada.",
 ],
 "humita": [
    "Muele el choclo junto con la cebolla sofrita.",
    "Cocina la mezcla con la leche y la manteca a fuego suave, revolviendo, hasta que espese.",
    "Ajusta la sal y deja entibiar.",
    "Arma las humitas en las hojas de choclo y amárralas.",
    "Cuécelas en agua hirviendo entre 30 y 40 minutos.",
 ],
 "carbonada": [
    "Corta la carne en cubos chicos y dórala en la olla.",
    "Cuece aparte la papa, el zapallo y la zanahoria en agua abundante, y bota esa agua.",
    "Sofríe la cebolla en la misma olla de la carne y agrega agua caliente.",
    "Suma las verduras precocidas, el choclo y los fideos.",
    "Cocina hasta que los fideos estén listos y ajusta la sal al final.",
 ],
 "lentejas_guisadas": [
    "Remoja las lentejas al menos 2 horas y bota esa agua de remojo.",
    "Cuécelas en agua nueva abundante hasta que estén blandas, y bota también esa agua.",
    "Sofríe la cebolla y la zanahoria picadas en el aceite.",
    "Junta las lentejas con el sofrito y agrega un poco de agua caliente.",
    "Cocina a fuego suave hasta que espese y ajusta la sal al final.",
 ],
 "arroz_pollo": [
    "Corta el pollo en trozos y dóralo en el aceite.",
    "Agrega la cebolla y la zanahoria picadas, y sofríe hasta que estén blandas.",
    "Suma el arroz y revuelve para que tome el sabor del sofrito.",
    "Agrega el doble de agua caliente que de arroz, tapa y cocina a fuego suave.",
    "Cocina hasta que el arroz esté listo y el pollo bien cocido por dentro.",
 ],
 "tallarines_salsa": [
    "Sofríe la cebolla picada fina en el aceite.",
    "Agrega el tomate pelado y picado, y cocina a fuego suave hasta que se deshaga.",
    "Cuece los tallarines en agua hirviendo hasta que estén al dente.",
    "Escúrrelos y mézclalos con la salsa, ajustando la sal al final.",
 ],
 "pure_papas": [
    "Pela y corta las papas en trozos, y cuécelas en agua abundante. Bota esa agua de cocción.",
    "Muélelas en caliente hasta que no queden grumos.",
    "Incorpora la leche tibia y la mantequilla, revolviendo hasta que quede cremoso.",
    "Ajusta la sal al final.",
 ],
 "ensalada_chilena": [
    "Corta el tomate en gajos y la cebolla en pluma delgada.",
    "Deja la cebolla en agua fría unos minutos para quitarle el picor, y escúrrela.",
    "Mezcla el tomate con la cebolla, alíñalos con el aceite y ajusta la sal.",
 ],
 "pebre": [
    "Pica muy fino el tomate, la cebolla y el cilantro.",
    "Mézclalos con el aceite.",
    "Ajusta la sal al final y deja reposar 15 minutos antes de servir.",
 ],
 "papas_cocidas": [
    "Pela las papas y córtalas en trozos parejos.",
    "Cuécelas en agua abundante hasta que estén blandas, y bota el agua de cocción.",
    "Ajusta la sal al servir, no durante la cocción.",
 ],
 "papas_duquesa": [
    "Pela y corta las papas en gajos.",
    "Cuécelas en agua abundante hasta que estén a medio cocer, y bota esa agua.",
    "Revuélvelas con el aceite en una fuente para horno.",
    "Hornea a 200 °C entre 25 y 35 minutos, dándolas vuelta a la mitad, hasta que estén doradas.",
    "Ajusta la sal recién al sacarlas del horno.",
 ],
 "pollo_asado": [
    "Seca bien el pollo y úntalo con el aceite y la sal.",
    "Ponlo en una fuente con la pechuga hacia arriba.",
    "Hornea a 190 °C, calculando unos 45 minutos por kilo.",
    "Comprueba que el jugo salga transparente antes de sacarlo: el pollo debe quedar bien cocido por dentro.",
    "Déjalo reposar 10 minutos antes de trozarlo.",
 ],
 "costillar_cerdo": [
    "Unta el costillar con el aceite y la sal.",
    "Hornea tapado a 160 °C durante unas 2 horas, para que la carne se ablande.",
    "Destapa y sube a 200 °C los últimos 20 minutos, hasta que quede dorado.",
    "Asegúrate de que la carne quede bien cocida por dentro antes de servir.",
 ],
 "merluza_frita": [
    "Seca bien los filetes con papel absorbente.",
    "Pásalos por harina, sacudiendo el exceso.",
    "Fríelos en aceite caliente unos 3 minutos por lado, hasta que estén dorados y cocidos por dentro.",
    "Escúrrelos sobre papel absorbente y ajusta la sal al servir.",
 ],
 "merluza_vapor": [
    "Pon los filetes en la vaporera, sin encimarlos.",
    "Cocina al vapor entre 10 y 12 minutos, hasta que la carne se separe en láminas.",
    "Ajusta la sal al servir; un poco de limón reemplaza bien a la sal.",
 ],
 "chorrillana": [
    "Pela y corta las papas en bastones. Cuécelas a medio cocer en agua abundante y bota esa agua.",
    "Termina de dorarlas en el aceite caliente.",
    "Aparte, saltea la cebolla en pluma hasta que esté transparente.",
    "Cocina la carne en tiras hasta que esté bien cocida y súmala a la cebolla.",
    "Fríe los huevos, monta todo sobre las papas y ajusta la sal al final.",
 ],
 "arroz_leche": [
    "Cuece el arroz en agua hasta que esté a medio cocer y escúrrelo.",
    "Agrégale la leche y cocina a fuego suave, revolviendo seguido.",
    "Incorpora el azúcar cuando el arroz ya esté blando.",
    "Cocina hasta que espese y déjalo entibiar antes de servir.",
 ],
 "leche_asada": [
    "Prepara un caramelo con parte del azúcar y cubre el fondo del molde.",
    "Bate los huevos con el resto del azúcar y agrega la leche tibia.",
    "Vierte la mezcla en el molde acaramelado.",
    "Hornea a baño maría a 180 °C entre 45 y 60 minutos, hasta que cuaje.",
    "Déjala enfriar por completo antes de desmoldar.",
 ],
 "mote_huesillo": [
    "Cuece el mote en agua abundante hasta que esté blando, y bota el agua de cocción.",
    "Aparte, calienta el durazno con su almíbar y el azúcar.",
    "Junta el mote escurrido con el durazno y su jugo.",
    "Sírvelo bien frío, con el mote en el fondo del vaso.",
 ],
 "acelga_cocida": [
    "Lava bien las hojas y córtalas en tiras.",
    "Cuécelas en agua abundante unos minutos y bota esa agua de cocción.",
    "Escúrrelas apretando para sacarles el exceso de agua.",
    "Saltéalas brevemente en el aceite y ajusta la sal al final.",
 ],
 "palta_molida": [
    "Corta la palta, sácale el cuesco y retira la pulpa con una cuchara.",
    "Muélela con un tenedor hasta la textura que prefieras.",
    "Ajusta la sal; unas gotas de limón la mantienen verde por más rato.",
 ],
 "te_con_leche": [
    "Calienta el agua y deja reposar el té unos minutos.",
    "Agrega la leche caliente.",
    "Endulza al gusto.",
 ],
}
