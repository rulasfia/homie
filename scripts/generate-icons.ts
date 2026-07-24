import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const source = fileURLToPath(new URL("../public/homie-512.png", import.meta.url));
const outDir = fileURLToPath(new URL("../public/icons/", import.meta.url));

const sizes = [72, 96, 128, 144, 152, 180, 192, 384, 512];

async function generate(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const input = sharp(source);

  for (const size of sizes) {
    const output = join(outDir, `icon-${size}x${size}.png`);
    await input
      .clone()
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(output);
    console.log(`generated ${output}`);
  }

  // Apple touch icon uses a solid name so it is easy to reference.
  await input
    .clone()
    .resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(outDir, "apple-touch-icon.png"));
  console.log("generated apple-touch-icon.png");
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
