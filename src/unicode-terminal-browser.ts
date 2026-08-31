#!/usr/bin/env bun

for (let i = 0; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--resolution" || arg === "-r") {
    throw new Error(
      "terminal:unicode uses the terminal's native geometry and does not accept --resolution. Use terminal:dense-unicode for explicit viewport resolutions.",
    );
  }
}

process.env.OPENAI_PILOT_RENDERER = "unicode";
await import("./terminal-browser.ts");
