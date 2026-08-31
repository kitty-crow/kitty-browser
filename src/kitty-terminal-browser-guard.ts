#!/usr/bin/env bun
import { xvfbReexecCommand } from "./runtime-exec.ts";
import { consumeBrowserSessionArg } from "./terminal-session.ts";
import {
  autoResolutionEnabled,
  freezeTerminalGeometry,
} from "./terminal-auto-resolution.ts";

consumeBrowserSessionArg();

const forced = process.env.OPENAI_PILOT_FORCE_KITTY === "1";
const term = process.env.TERM ?? "";
const termProgram = process.env.TERM_PROGRAM ?? "";
const kittyWindowId = process.env.KITTY_WINDOW_ID ?? "";

const KITTY_QUERY_ID = 31;
const KITTY_QUERY = `\x1b_Gi=${KITTY_QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`;
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const PROBE_TIMEOUT_MS = 750;
const XVFB_REEXEC = "OPENAI_PILOT_XVFB_REEXEC";

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
      ...xvfbReexecCommand(import.meta.path, "kitty"),
    ], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
  } catch (error) {
    throw new Error(
      `terminal:kitty needs Xvfb to run real headed Chromium without a graphical display. Install xvfb, or provide DISPLAY. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.exit(await child.exited);
};

await ensureVirtualDisplay();
if (autoResolutionEnabled()) freezeTerminalGeometry();

const environmentSaysKitty = (): boolean =>
  /kitty/iu.test(term)
  || /kitty/iu.test(termProgram)
  || kittyWindowId.length > 0;

const probeKittyGraphics = async (): Promise<boolean> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const stdin = process.stdin;
  const chunks: string[] = [];
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onData: ((chunk: Buffer | string) => void) | undefined;

  const restore = (): void => {
    if (timer) clearTimeout(timer);
    if (onData) stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
  };

  const result = await new Promise<boolean>((resolve) => {
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      restore();
      resolve(supported);
    };

    const inspect = (): void => {
      const received = chunks.join("");
      const kittyReply = new RegExp(`\\x1b_Gi=${KITTY_QUERY_ID};`, "u");
      if (kittyReply.test(received)) {
        finish(true);
        return;
      }

      if (/\x1b\[\??[0-9;]*c/u.test(received)) finish(false);
    };

    onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      inspect();
    };

    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);

    process.stdout.write(`${KITTY_QUERY}${DEVICE_ATTRIBUTES_QUERY}`);
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });

  return result;
};

let kittyCapable = forced || environmentSaysKitty();
if (!kittyCapable) kittyCapable = await probeKittyGraphics();

if (!kittyCapable) {
  console.error([
    "terminal:kitty could not negotiate the kitty graphics protocol on this terminal path.",
    "",
    `Detected TERM=${term || "(unset)"}`,
    `Detected TERM_PROGRAM=${termProgram || "(unset)"}`,
    `Detected KITTY_WINDOW_ID=${kittyWindowId || "(unset)"}`,
    "",
    "The probe used kitty's graphics query followed by a standard device-attributes query.",
    "No kitty graphics response was received, so full PNG frames will not be sent.",
    "",
    "Use terminal:unicode for the portable Braille renderer.",
    "Set OPENAI_PILOT_FORCE_KITTY=1 only when you know the terminal path supports",
    "kitty graphics but strips or delays capability-query responses.",
  ].join("\n"));
  process.exit(2);
}

await import("./kitty-terminal-browser.ts");
