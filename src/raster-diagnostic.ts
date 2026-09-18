import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

const DIAGNOSTIC_ENV = "KITTY_BROWSER_RASTER_DIAGNOSTIC";
let dumped = false;

const sampleAt = (
  png: PNG,
  x: number,
  y: number,
): readonly [number, number, number, number] => {
  const px = Math.max(0, Math.min(png.width - 1, Math.floor(x)));
  const py = Math.max(0, Math.min(png.height - 1, Math.floor(y)));
  const offset = (py * png.width + px) * 4;
  return [
    png.data[offset] ?? 0,
    png.data[offset + 1] ?? 0,
    png.data[offset + 2] ?? 0,
    png.data[offset + 3] ?? 0,
  ] as const;
};

export const dumpFirstRasterFrame = async (
  bytes: Uint8Array,
  renderer: "kitty" | "sixel",
  url: string,
): Promise<void> => {
  const base = process.env[DIAGNOSTIC_ENV]?.trim();
  if (!base || dumped) return;
  dumped = true;

  const pngPath = `${base}.png`;
  const jsonPath = `${base}.json`;
  await writeFile(pngPath, bytes);

  const png = PNG.sync.read(Buffer.from(bytes));
  let sampled = 0;
  let black = 0;
  let transparent = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  // Sample at most roughly 100k pixels so diagnostics stay cheap at 1080p.
  const stride = Math.max(1, Math.floor(Math.sqrt((png.width * png.height) / 100_000)));
  for (let y = 0; y < png.height; y += stride) {
    for (let x = 0; x < png.width; x += stride) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset] ?? 0;
      const g = png.data[offset + 1] ?? 0;
      const b = png.data[offset + 2] ?? 0;
      const a = png.data[offset + 3] ?? 0;
      sampled += 1;
      sumR += r;
      sumG += g;
      sumB += b;
      if (a < 8) transparent += 1;
      if (r <= 8 && g <= 8 && b <= 8) black += 1;
    }
  }

  const report = {
    renderer,
    url,
    width: png.width,
    height: png.height,
    sampledPixels: sampled,
    blackFraction: sampled === 0 ? 0 : black / sampled,
    transparentFraction: sampled === 0 ? 0 : transparent / sampled,
    averageRgb: sampled === 0
      ? [0, 0, 0]
      : [sumR / sampled, sumG / sampled, sumB / sampled],
    samples: {
      topLeft: sampleAt(png, 0, 0),
      centre: sampleAt(png, png.width / 2, png.height / 2),
      bottomRight: sampleAt(png, png.width - 1, png.height - 1),
    },
    pngPath,
  };

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
};
