// Gráfico de línea a mano, sin librería — dos series fijas por paciente
// (potasio, fósforo), sin zoom/pan/tooltip, dataset chico (semanas de puntos
// diarios): no justifica sumar una dependencia nueva. Se llama una vez por
// nutriente, nunca combinados en el mismo gráfico — mismo criterio que ya
// usa la app del paciente para no mezclar escalas de nutrientes distintos.
const NIVEL_COLOR = { verde: "#16a34a", amarillo: "#b45309", rojo: "#dc2626" };

function nivelConsumo(valor, meta) {
  if (!meta) return "verde";
  if (valor > meta) return "rojo";
  if (valor >= meta * 0.8) return "amarillo";
  return "verde";
}

function renderLineChart(container, { puntos, metaValue, unidad, color }) {
  if (!puntos.length) {
    container.innerHTML = `<p class="lista-vacia">Sin datos de consumo todavía.</p>`;
    return;
  }

  const width = 600;
  const height = 220;
  const padding = { top: 16, right: 16, bottom: 28, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const valores = puntos.map((p) => p.valor);
  const yMax = Math.max(...valores, metaValue || 0) * 1.15 || 1;

  const x = (i) => padding.left + (puntos.length === 1 ? innerW / 2 : (i / (puntos.length - 1)) * innerW);
  const y = (v) => padding.top + innerH - (v / yMax) * innerH;

  const linePath = puntos
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`)
    .join(" ");

  const puntosSvg = puntos
    .map((p, i) => `
      <circle cx="${x(i).toFixed(1)}" cy="${y(p.valor).toFixed(1)}" r="3.5" fill="${NIVEL_COLOR[nivelConsumo(p.valor, metaValue)]}">
        <title>${p.fecha}: ${Math.round(p.valor)} ${unidad}</title>
      </circle>`)
    .join("");

  const metaLinea = metaValue
    ? `<line x1="${padding.left}" y1="${y(metaValue).toFixed(1)}" x2="${width - padding.right}" y2="${y(metaValue).toFixed(1)}"
         stroke="#5b7280" stroke-width="1.5" stroke-dasharray="5,4" />
       <text x="${width - padding.right}" y="${(y(metaValue) - 5).toFixed(1)}" font-size="11" fill="#5b7280" text-anchor="end">meta: ${metaValue} ${unidad}</text>`
    : "";

  const indicesEje = puntos.length > 1 ? [0, puntos.length - 1] : [0];
  const ejeX = indicesEje
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 8}" font-size="10" fill="#5b7280" text-anchor="middle">${puntos[i].fecha.slice(5)}</text>`)
    .join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Gráfico de ${unidad}">
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="#dfe7eb" />
      <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="#dfe7eb" />
      ${metaLinea}
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" />
      ${puntosSvg}
      ${ejeX}
    </svg>`;
}
