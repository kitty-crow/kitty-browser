#!/usr/bin/env bun
import { xvfbReexecCommand } from "./runtime-exec.ts";
import { consumeBrowserSessionArg } from "./terminal-session.ts";

const help = (): never => {
  console.log(`kitty-browser Unicode renderer

Usage:
  bun run terminal:unicode -- <url> [--fps <n>] [--session <id>] [--no-status]

The Unicode renderer always uses the terminal's native geometry and does not accept
--resolution. --session selects a persistent Chromium profile; the default session is
named "default". Use the SIXEL or Kitty renderers when an explicit viewport resolution
is required.`);
  process.exit(0);
};

const XVFB_REEXEC = "KITTY_BROWSER_UNICODE_XVFB_REEXEC";

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
      ...xvfbReexecCommand(import.meta.path, "unicode"),
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
  } catch (error) {
    throw new Error(
      `terminal:unicode needs Xvfb to run real headed Chromium without a graphical display. Install xvfb, or provide DISPLAY. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.exit(await child.exited);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) help();
consumeBrowserSessionArg();

for (const arg of process.argv) {
  if (arg === "--resolution" || arg === "-r") {
    throw new Error("terminal:unicode uses the terminal's native geometry and does not accept --resolution");
  }
}

if (process.argv.slice(2).length === 0) help();

await ensureVirtualDisplay();
process.env.OPENAI_PILOT_RENDERER = "unicode";
await import("./terminal-browser.ts");
