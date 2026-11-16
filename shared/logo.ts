// The homie mark: a roof over four tiles laid out like the dashboard (wide main
// column, narrow side column), with one tile lit "up". Drawn on a 32x32 grid.
// The header renders it inline (src/main.ts); scripts/generate-icons.ts writes
// public/favicon.svg and the PWA icons from it, so change the look here.

type Stops = readonly [top: string, bottom: string];

/** Vertical gradient stops for each part of the mark. Any CSS color works, including var() and light-dark(). */
export type LogoPalette = { roof: Stops; tile: Stops; lit: Stops };

export const LOGO_LIGHT = {
  roof: ["#4a9cf5", "#1556b0"],
  tile: ["#6fb2ff", "#1f6fd6"],
  lit: ["#7be070", "#2f9e2a"],
} as const satisfies LogoPalette;

export const LOGO_DARK = {
  roof: ["#c4ebff", "#5aa8f0"],
  tile: ["#8cc6ff", "#3b86e0"],
  lit: ["#a6f59a", "#3cc54a"],
} as const satisfies LogoPalette;

const PARTS = ["roof", "tile", "lit"] as const;

const adapt = (light: Stops, dark: Stops) =>
  [`light-dark(${light[0]}, ${dark[0]})`, `light-dark(${light[1]}, ${dark[1]})`] as const;

/** Follows the color-scheme of the element it is rendered in (data-theme in the app). */
export const LOGO_ADAPTIVE = {
  roof: adapt(LOGO_LIGHT.roof, LOGO_DARK.roof),
  tile: adapt(LOGO_LIGHT.tile, LOGO_DARK.tile),
  lit: adapt(LOGO_LIGHT.lit, LOGO_DARK.lit),
} satisfies LogoPalette;

const TILES = [
  { x: 4.5, y: 16, w: 13, lit: false },
  { x: 19.5, y: 16, w: 8, lit: true },
  { x: 4.5, y: 23.5, w: 13, lit: false },
  { x: 19.5, y: 23.5, w: 8, lit: false },
];

/**
 * SVG markup for the mark. `id` prefixes the gradient ids, so it must be unique
 * per document; `attrs` is appended to the root <svg> (class, size, aria);
 * `css` becomes a <style> element. Colors go in style attributes so var() and
 * light-dark() resolve.
 */
export function logoSvg(palette: LogoPalette, { id = "homie-logo", attrs = "", css = "" } = {}) {
  const gradients = PARTS.map(
    (part) =>
      `<linearGradient id="${id}-${part}" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" style="stop-color:${palette[part][0]}"/>` +
      `<stop offset="1" style="stop-color:${palette[part][1]}"/></linearGradient>`,
  ).join("");
  const tiles = TILES.map(
    (t) =>
      `<rect x="${t.x}" y="${t.y}" width="${t.w}" height="5.5" rx="1.6" fill="url(#${id}-${t.lit ? "lit" : "tile"})"/>`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"${attrs}>` +
    `${css && `<style>${css}</style>`}<defs>${gradients}</defs>` +
    `<path d="M3.5 13 16 4l12.5 9" fill="none" stroke="url(#${id}-roof)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `${tiles}</svg>`
  );
}
