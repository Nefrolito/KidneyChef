// Regenera los 7 íconos de la PWA (public/icons/icon-*.webp) desde
// assets/icon.png, que es la identidad vigente (la misma del ícono nativo).
//
// No es un resize directo, y esa es la parte que importa: el manifest los
// declara "any maskable", así que el lanzador recorta a un círculo. El dibujo
// llega casi hasta el borde del lienzo, de modo que un resize directo deja el
// círculo del logo cortado. Acá se reencuadra al 58% sobre fondo blanco a
// sangre — blanco porque es el fondo del propio dibujo y el del ícono nativo,
// así la PWA y la app se ven iguales.
//
// Estos íconos arrancan en 48 px, tamaño en el que la línea del dibujo todavía
// se lee. El favicon del <head> de public/index.html es otra cosa: a 16 px esa
// línea mide 0,36 px, así que ahí va una silueta simplificada.
//
// Se corre a mano cuando cambie la identidad:  node scripts/make-icons.js
// Depende de sharp, que entra como dependencia transitiva de
// @capacitor/assets (igual que make-splash.js).
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SIZES = [48, 72, 96, 128, 192, 256, 512];
const SRC = path.join(__dirname, "../assets/icon.png");
const OUT = path.join(__dirname, "../public/icons");
const ZONA_SEGURA = 0.58;

async function main() {
  for (const s of SIZES) {
    const interior = Math.round(s * ZONA_SEGURA);
    const logo = await sharp(SRC).resize(interior, interior).png().toBuffer();
    const file = path.join(OUT, `icon-${s}.webp`);
    await sharp({
      create: { width: s, height: s, channels: 4, background: "#ffffff" },
    })
      .composite([{ input: logo, gravity: "center" }])
      .webp({ quality: 92 })
      .toFile(file);
    console.log(`icon-${s}.webp  ${fs.statSync(file).size} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
