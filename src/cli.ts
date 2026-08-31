#!/usr/bin/env bun
import { consumeBrowserSessionArg } from "./terminal-session.ts";

type Renderer = "auto" | "unicode" | "sixel" | "kitty";

const RENDERERS = new Set<Renderer>(["auto", "unicode", "sixel", "kitty"]);

const help = (code = 0): never => {
  console.log(`Kitty Browser

Usage:
  bun . <url> [options]
  bun run terminal -- <url> [options]   compatibility alias

Options:
  --render <mode>            auto, unicode, sixel, or kitty; default auto
  --session <id>             Persistent Chromium session/profile; default "default"
  --fps <n>                  Capture rate, integer 1-60; default 1
  --resolution <mode>        SIXEL/Kitty only: named preset or WIDTHxHEIGHT
  --no-status                Hide the bottom navigation/status bar
  -h, --help                 Show this help

Examples:
  bun . https://kittycrow.dev
  bun . https://kittycrow.dev --render unicode --fps 4
  bun . https://kittycrow.dev --render sixel --resolution 960x540
  bun . https://kittycrow.dev --render kitty --resolution 720p --fps 12
  bun . https://kittycrow.dev --render kitty --session personal --no-status

The default renderer is auto: Kitty graphics when available, otherwise SIXEL, otherwise
Unicode. Unicode is terminal-native and deliberately does not accept --resolution.`);
  process.exit(code);
};

const consumeRendererArg = (argv = process.argv): Renderer => {
  let renderer: Renderer = "auto";

  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i]!;
    let candidate: string | undefined;

    if (value === "--render") {
      candidate = argv[i + 1];
      if (!candidate) throw new Error("--render requires one of: auto, unicode, sixel, kitty");
      argv.splice(i, 2);
      i -= 1;
    } else if (value.startsWith("--render=")) {
      candidate = value.slice("--render=".length);
      argv.splice(i, 1);
      i -= 1;
    }

    if (candidate !== undefined) {
      const normalised = candidate.toLowerCase() as Renderer;
      if (!RENDERERS.has(normalised)) {
        throw new Error(`unknown renderer ${JSON.stringify(candidate)}; expected auto, unicode, sixel, or kitty`);
      }
      renderer = normalised;
    }
  }

  return renderer;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) help(0);

const renderer = consumeRendererArg();
consumeBrowserSessionArg();

if (process.argv.slice(2).length === 0) help(2);

switch (renderer) {
  case "auto":
    process.env.OPENAI_PILOT_RENDERER = "auto";
    await import("./terminal-auto.ts");
    break;
  case "unicode":
    process.env.OPENAI_PILOT_RENDERER = "unicode";
    await import("./unicode-terminal-browser.ts");
    break;
  case "sixel":
    process.env.OPENAI_PILOT_RENDERER = "sixel";
    await import("./sixel-terminal-browser-guard.ts");
    break;
  case "kitty":
    process.env.OPENAI_PILOT_RENDERER = "kitty";
    await import("./kitty-terminal-browser-guard.ts");
    break;
}
