/**
 * Chart.js draws on a canvas, which cannot resolve CSS variables, so the mono
 * stack from globals.css is repeated here. Naming a face the page never loads
 * makes the canvas fall back to a serif.
 */
export const CHART_FONT = '"Geist Mono", ui-monospace, "SF Mono", Menlo, monospace';
