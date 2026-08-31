#!/usr/bin/env bun
import { consumeBrowserSessionArg } from "./terminal-session.ts";
import {
  autoResolutionEnabled,
  freezeTerminalGeometry,
} from "./terminal-auto-resolution.ts";

consumeBrowserSessionArg();

const forced = process.env.KITTY_BROWSER_FORCE_SIXEL === "1"
  || process.env.OPENAI_PILOT_FORCE_SIXEL === "1";
const term = process.env.TERM ?? "";
const termProgram = process.env.TERM_PROGRAM ?? "";
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const PROBE_TIMEOUT_MS = 750;
const XVFB_REEXEC = "KITTY_BROWSER_SIXEL_XVFB_REEXEC";

const ensureVirtualDisplay = async (): Promise<void> => {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env[XVFB_REEXEC] === "1") return;

  const env = { ...process.env, [XVFB_REEXEC]: "1" };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1920x1080x24 -nolisten tcp",
      process.execPath,
      import.meta.path,
      ...process.argv.slice(2),
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
  } catch (error) {
    throw new Error(
      `terminal:sixel needs Xvfb to run real headed Chromium without a graphical display. Install xvfb, or provide DISPLAY. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.exit(await child.exited);
};

await ensureVirtualDisplay();
if (autoResolutionEnabled()) freezeTerminalGeometry();

const probeSixel = async (): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const stdin = process.stdin;
  const chunks: string[] = [];
  const wasRaw = stdin.isRaw;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onData: ((chunk: Buffer | string) => void) | undefined;

  const restore = (): void => {
    if (timer) clearTimeout(timer);
    if (onData) stdin.off("data", onData);
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
  };

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      restore();
      resolve(supported);
    };

    onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      const received = chunks.join("");
      const da1Match = received.match(/\x1b\[\?([0-9;]*)c/u);
      if (!da1Match) return;
      const params = da1Match[1]?.split(";").filter(Boolean).map(Number) ?? [];
      finish(params.includes(4));
    };

    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stdout.write(DEVICE_ATTRIBUTES_QUERY);
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });
};

const sixelCapable = forced || await probeSixel();
if (!sixelCapable) {
  console.error([
    "terminal:sixel could not negotiate SIXEL graphics on this terminal path.",
    "",
    `Detected TERM=${term || "(unset)"}`,
    `Detected TERM_PROGRAM=${termProgram || "(unset)"}`,
    "",
    "SIXEL support is advertised through primary device attributes parameter 4.",
    "No SIXEL capability was observed on this path, so raster frames will not be sent.",
    "",
    "Use terminal:unicode for the portable Braille renderer.",
    "Set KITTY_BROWSER_FORCE_SIXEL=1 only when you know the terminal supports SIXEL",
    "but the SSH/PTY path strips or delays the capability response.",
  ].join("\n"));
  process.exit(2);
}

process.env.OPENAI_PILOT_RENDERER = "sixel";
await import("./sixel-terminal-browser.ts");
