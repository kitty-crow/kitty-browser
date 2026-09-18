#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { launchPersistentBrowser } from "../src/browser-profile.ts";

if (process.platform === "linux" && !process.env.DISPLAY) {
  throw new Error("raster smoke test requires DISPLAY on Linux; run it under Xvfb");
}

const profileRoot = await mkdtemp(join(tmpdir(), "kitty-browser-raster-smoke-"));
process.env.KITTY_BROWSER_PROFILE_ROOT = profileRoot;
process.env.KITTY_BROWSER_VIRTUAL_DISPLAY = process.platform === "linux" ? "1" : "0";

const browser = await launchPersistentBrowser({ headless: false, channel: "chromium" });

try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("data:text/html,<body style=%22margin:0;background:rgb(17,34,51);overflow:hidden%22><div style=%22position:fixed;left:220px;top:140px;width:200px;height:200px;background:rgb(255,0,255)%22></div></body>", { waitUntil: "domcontentloaded" });

  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });

  const screenshot = await page.screenshot({ type: "png" });
  const png = PNG.sync.read(Buffer.from(screenshot));
  const x = Math.floor(png.width / 2);
  const y = Math.floor(png.height / 2);
  const offset = (y * png.width + x) * 4;
  const rgba = [
    png.data[offset] ?? 0,
    png.data[offset + 1] ?? 0,
    png.data[offset + 2] ?? 0,
    png.data[offset + 3] ?? 0,
  ] as const;

  if (rgba[0] < 240 || rgba[1] > 20 || rgba[2] < 240 || rgba[3] < 240) {
    throw new Error(
      `headed Chromium raster smoke test captured an unexpected centre pixel rgba(${rgba.join(",")})`,
    );
  }

  console.log(
    `raster smoke PASS: ${png.width}x${png.height}, centre rgba(${rgba.join(",")})`,
  );
} finally {
  await browser.close().catch(() => undefined);
  await rm(profileRoot, { recursive: true, force: true }).catch(() => undefined);
}
