// Gráfico de línea a mano, sin librería — dos series fijas por paciente
// (potasio, fósforo), sin zoom/pan/tooltip, dataset chico (semanas de puntos
// diarios): no justifica sumar una dependencia nueva. Se llama una vez por
// nutriente, nunca combinados en el mismo gráfico — mismo criterio que ya
// usa la app del paciente para no mezclar escalas de nutrientes distintos.
//
// Los colores salen de las variables CSS del portal (no literales) para que
// el gráfico siga al tema claro/oscuro como el resto de la página: en un SVG
// en línea, var(--x) funciona igual en los atributos de presentación.
const NIVEL_COLOR = { verde: "var(--verde)", amarillo: "var(--amarillo)", rojo: "var(--rojo)" };

function nivelConsumo(valor, meta) {
  if (!meta) return "verde";
  if (valor > meta) return "rojo";
  if (valor >= meta * 0.8) return "amarillo";
  return "verde";
}

function renderLineChart(container, { puntos, metaValue, unidad }) {
  if (!puntos.length) {
    container.innerHTML = `<p class="lista-vacia">Sin datos de consumo todavía.</p>`;
    return;
  }

  const width = 640;
  const height = 230;
  const padding = { top: 18, right: 18, bottom: 28, left: 52 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const valores = puntos.map((p) => p.valor);
  const yMax = Math.max(...valores, metaValue || 0) * 1.15 || 1;

  const x = (i) => padding.left + (puntos.length === 1 ? innerW / 2 : (i / (puntos.length - 1)) * innerW);
  const y = (v) => padding.top + innerH - (v / yMax) * innerH;

  const linePath = puntos
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`)
    .join(" ");

  // Relleno bajo la línea: ayuda a leer el volumen de un vistazo sin agregar
  // otra serie ni otro color.
  const areaPath = `${linePath} L${x(puntos.length - 1).toFixed(1)},${(padding.top + innerH).toFixed(1)} `
    + `L${x(0).toFixed(1)},${(padding.top + innerH).toFixed(1)} Z`;

  const puntosSvg = puntos
    .map((p, i) => `
      <circle cx="${x(i).toFixed(1)}" cy="${y(p.valor).toFixed(1)}" r="3.5" fill="${NIVEL_COLOR[nivelConsumo(p.valor, metaValue)]}">
        <title>${p.fecha}: ${Math.round(p.valor)} ${unidad}</title>
      </circle>`)
    .join("");

  // Tres marcas en el eje vertical: 0, la mitad y el techo de la escala.
  const marcasY = [0, yMax / 2, yMax].map((v) => `
    <line x1="${padding.left}" y1="${y(v).toFixed(1)}" x2="${width - padding.right}" y2="${y(v).toFixed(1)}"
          stroke="var(--border)" stroke-width="1" />
    <text x="${padding.left - 8}" y="${(y(v) + 3.5).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end">${Math.round(v)}</text>`
  ).join("");

  const metaLinea = metaValue
    ? `<line x1="${padding.left}" y1="${y(metaValue).toFixed(1)}" x2="${width - padding.right}" y2="${y(metaValue).toFixed(1)}"
         stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5,4" />
       <text x="${width - padding.right}" y="${(y(metaValue) - 6).toFixed(1)}" font-size="11" font-weight="600" fill="var(--muted)" text-anchor="end">meta: ${metaValue} ${unidad}</text>`
    : "";

  const indicesEje = puntos.length > 1 ? [0, puntos.length - 1] : [0];
  const ejeX = indicesEje
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 8}" font-size="10" fill="var(--muted)" text-anchor="middle">${puntos[i].fecha.slice(5)}</text>`)
    .join("");

  const etiqueta = metaValue
    ? `Consumo diario en ${unidad}, con la meta de ${metaValue} ${unidad} marcada`
    : `Consumo diario en ${unidad}`;

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${etiqueta}">
      ${marcasY}
      <path d="${areaPath}" fill="var(--brand)" opacity="0.08" />
      ${metaLinea}
      <path d="${linePath}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${puntosSvg}
      ${ejeX}
    </svg>`;
}
