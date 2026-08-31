#!/usr/bin/env bun
import { consumeBrowserSessionArg } from "./terminal-session.ts";

type Renderer = "auto" | "unicode" | "sixel" | "kitty";

const RENDERERS = new Set<Renderer>(["auto", "unicode", "sixel", "kitty"]);
const STRICT_ENV = "KITTY_BROWSER_STRICT";
const HOME_ENV = "KITTY_BROWSER_HOME_URL";
const MIN_FPS = 1;
const MAX_FPS = 24;
const DEFAULT_FPS = 12;

const help = (code = 0): never => {
  console.log(`Kitty Browser

Usage:
  bun . <url> [options]
  bun run terminal -- <url> [options]   compatibility alias

Options:
  --render <mode>            auto, unicode, sixel, or kitty; default auto
  --session <id>             Persistent Chromium session/profile; default "default"
  --strict                   Restrict top-level navigation to the launch URL's registrable domain
  --fps <n>                  Capture rate, integer 1-24; default 12
  --resolution <mode>        SIXEL/Kitty only: named preset or WIDTHxHEIGHT
  --no-status                Hide the bottom navigation/status bar
  -h, --help                 Show this help

Browser shortcuts:
  Backspace                  Go back only when the focused webpage element is not editable
  Ctrl+H                     Return to the original URL supplied on launch

Examples:
  bun . https://kittycrow.dev
  bun . https://kittycrow.dev --render unicode
  bun . https://kittycrow.dev --render sixel --resolution 960x540
  bun . https://kittycrow.dev --render kitty --resolution 720p
  bun . https://kittycrow.dev --render kitty --session personal --no-status
  bun . https://app.example.co.uk --strict

The default renderer is auto: Kitty graphics when available, otherwise SIXEL, otherwise
Unicode. Unicode is terminal-native and deliberately does not accept --resolution.

Strict mode allows navigation between subdomains of the same registrable domain, but
blocks top-level navigation to a different registrable domain. Third-party page resources
are still allowed so ordinary websites continue to load.`);
  process.exit(code);
};

const normaliseUrl = (raw: string): string => {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  return `https://${value}`;
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

const consumeStrictArg = (argv = process.argv): boolean => {
  let strict = false;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] !== "--strict") continue;
    strict = true;
    argv.splice(i, 1);
    i -= 1;
  }
  process.env[STRICT_ENV] = strict ? "1" : "0";
  return strict;
};

const validateAndDefaultFpsArg = (argv = process.argv): void => {
  let found = false;

  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] !== "--fps") continue;
    found = true;
    const raw = argv[i + 1];
    if (!raw) throw new Error("--fps requires an integer value");
    if (!/^\d+$/u.test(raw)) throw new Error(`--fps must be an integer from ${MIN_FPS} to ${MAX_FPS}`);
    const fps = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(fps) || fps < MIN_FPS || fps > MAX_FPS) {
      throw new Error(`--fps must be an integer from ${MIN_FPS} to ${MAX_FPS}`);
    }
    i += 1;
  }

  if (!found) argv.push("--fps", String(DEFAULT_FPS));
};

const findLaunchUrl = (argv = process.argv): string | undefined => {
  const takesValue = new Set(["--fps", "--resolution", "-r"]);
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (takesValue.has(value)) {
      i += 1;
      continue;
    }
    if (value.startsWith("--fps=") || value.startsWith("--resolution=")) continue;
    if (value === "--no-status") continue;
    if (value.startsWith("-")) continue;
    return normaliseUrl(value);
  }
  return undefined;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) help(0);

const renderer = consumeRendererArg();
consumeBrowserSessionArg();
consumeStrictArg();
validateAndDefaultFpsArg();

const homeUrl = findLaunchUrl();
if (!homeUrl) help(2);
process.env[HOME_ENV] = homeUrl;

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
