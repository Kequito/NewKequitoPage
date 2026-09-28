/* Configuración global de Chart.js compartida por todas las gráficas. */

/* ── Chart.js — configuración compartida por todas las gráficas reales del sitio ── */
// Registrado globalmente pero apagado por defecto — solo el gráfico de Reportes lo enciende,
// así el resto de gráficas no se ven afectadas.
Chart.register(ChartDataLabels);
Chart.defaults.set('plugins.datalabels', { display: false });
// Duración corta a propósito: muchas gráficas se recrean seguido (togglear un chip,
// subir un Excel nuevo) — una animación de entrada larga ahí se siente lento, no elegante.
Chart.defaults.animation.duration = 400;

const CHART_GRID  = 'rgba(255,255,255,0.08)';
const CHART_TICK  = '#9aa0a5';
const chartDefaults = {
  font: { family: "'Lexend', sans-serif", size: 12, color: CHART_TICK },
};
