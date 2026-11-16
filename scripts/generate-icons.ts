// Writes public/favicon.svg and the PWA icons in public/icons/ from the mark in
// shared/logo.ts. Run with `pnpm generate-icons` after changing the logo.
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { LOGO_DARK, LOGO_LIGHT, logoSvg, type LogoPalette } from "../shared/logo.ts";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const outDir = join(publicDir, "icons");

const sizes = [72, 96, 128, 144, 152, 180, 192, 384, 512];
// Matches background_color in manifest.json.
const BACKDROP = "#0c1219";

// A favicon cannot see the page's data-theme, so it follows the browser's color
// scheme through CSS variables, with the light colors as the fallback.
const cssVars = (palette: LogoPalette) =>
  Object.entries(palette)
    .map(([part, [top, bottom]]) => `--${part}-0:${top};--${part}-1:${bottom}`)
    .join(";");
const VAR_PALETTE = {
  roof: [`var(--roof-0,${LOGO_LIGHT.roof[0]})`, `var(--roof-1,${LOGO_LIGHT.roof[1]})`],
  tile: [`var(--tile-0,${LOGO_LIGHT.tile[0]})`, `var(--tile-1,${LOGO_LIGHT.tile[1]})`],
  lit: [`var(--lit-0,${LOGO_LIGHT.lit[0]})`, `var(--lit-1,${LOGO_LIGHT.lit[1]})`],
} satisfies LogoPalette;

const favicon = logoSvg(VAR_PALETTE, {
  css: `@media (prefers-color-scheme:dark){:root{${cssVars(LOGO_DARK)}}}`,
});

// The mark alone on a transparent canvas, drawn at the target size so it stays sharp.
const plain = (size: number) => logoSvg(LOGO_LIGHT, { attrs: ` width="${size}" height="${size}"` });

// The mark on an opaque backdrop, shrunk by `scale` and centered. Maskable icons
// keep only the centered 80% circle; iOS fills transparent touch icons with black.
const onBackdrop = (size: number, scale: number) => {
  const inner = 32 * scale;
  const offset = (32 - inner) / 2;
  const mark = logoSvg(LOGO_DARK, {
    attrs: ` x="${offset}" y="${offset}" width="${inner}" height="${inner}"`,
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><rect width="32" height="32" fill="${BACKDROP}"/>${mark}</svg>`;
};

const png = (svg: string, file: string) =>
  sharp(Buffer.from(svg))
    .png()
    .toFile(file)
    .then(() => console.log(`generated ${file}`));

async function generate() {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(publicDir, "favicon.svg"), `${favicon}\n`);
  console.log(`generated ${join(publicDir, "favicon.svg")}`);

  for (const size of sizes) await png(plain(size), join(outDir, `icon-${size}x${size}.png`));
  for (const size of [192, 512]) {
    await png(onBackdrop(size, 0.7), join(outDir, `icon-maskable-${size}x${size}.png`));
  }
  await png(onBackdrop(180, 0.78), join(outDir, "apple-touch-icon.png"));
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
