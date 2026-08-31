#!/usr/bin/env bun

const help = (): never => {
  console.log(`kitty-browser Unicode renderer

Usage:
  bun run terminal:unicode -- <url> [--fps <n>] [--no-status]

The Unicode renderer always uses the terminal's native geometry and does not accept
--resolution. Use the SIXEL or Kitty renderers when an explicit viewport resolution is
required.`);
  process.exit(0);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) help();

for (const arg of process.argv) {
  if (arg === "--resolution" || arg === "-r") {
    throw new Error("terminal:unicode uses the terminal's native geometry and does not accept --resolution");
  }
}

if (process.argv.slice(2).length === 0) help();

process.env.OPENAI_PILOT_RENDERER = "unicode";
await import("./terminal-browser.ts");
