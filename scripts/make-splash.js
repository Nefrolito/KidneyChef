const sharp = require("sharp");
const path = require("path");

async function main() {
  const size = 2732;
  const logoSize = Math.round(size * 0.28);
  const bg = { r: 0xf4, g: 0xf8, b: 0xfa, alpha: 1 };

  const logo = await sharp(path.join(__dirname, "../resources/icon.png"))
    .resize(logoSize, logoSize)
    .png()
    .toBuffer();

  await sharp({
    create: { width: size, height: size, channels: 4, background: bg },
  })
    .composite([{ input: logo, gravity: "center" }])
    .png()
    .toFile(path.join(__dirname, "../resources/splash.png"));

  console.log("splash.png generado");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
