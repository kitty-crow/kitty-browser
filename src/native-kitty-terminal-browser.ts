#!/usr/bin/env bun
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { consumeAudioWebSocketArg } from "./audio-options.ts";
import { tryOpenChromiumAudioStream } from "./audio-stream.ts";
import { bundledChromiumExecutable } from "./bundled-chromium.ts";
import { mediaFrameMarker, midpointNs, monotonicNs } from "./media-sync.ts";
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  TerminalMouseDecoder,
  type MouseButton,
  type TerminalMouseEvent,
} from "./terminal-mouse.ts";
import { browserSessionId } from "./terminal-session.ts";

interface Resolution {
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
}

interface Args {
  readonly url: string;
  readonly fps: number;
  readonly status: boolean;
  readonly resolution: Resolution;
}

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface Geometry extends TerminalSize {
  readonly browserWidth: number;
  readonly browserHeight: number;
  readonly pointerWidth: number;
  readonly pointerHeight: number;
}

interface WindowGeometry {
  readonly width: number;
  readonly height: number;
}

interface LeftPress {
  lastX: number;
  lastY: number;
  dragging: boolean;
  buttonDown: boolean;
}

const PROFILE_ROOT = join(homedir(), ".local", "share", "kitty-browser", "sessions");
const NATIVE_CELL_WIDTH = 8;
const NATIVE_CELL_HEIGHT = 16;
const KITTY_IMAGE_ID = 0x4f410000 + (process.pid % 65_535);
const KITTY_PLACEMENT_ID = 1;
const KITTY_CHUNK = 4096;
const MIN_WINDOW_WIDTH = 320;
const MIN_WINDOW_HEIGHT = 240;
const WINDOW_WAIT_MS = 15_000;
const WINDOW_POLL_MS = 100;
const STRICT_ENV = "KITTY_BROWSER_STRICT";

const PRESETS = new Map<string, readonly [number, number]>([
  ["800x600", [800, 600]],
  ["1024x768", [1024, 768]],
  ["720p", [1280, 720]],
  ["1280x720", [1280, 720]],
  ["1366x768", [1366, 768]],
  ["900p", [1600, 900]],
  ["1600x900", [1600, 900]],
  ["1080p", [1920, 1080]],
  ["1920x1080", [1920, 1080]],
]);

const parseResolution = (raw: string): Resolution => {
  const value = raw.toLowerCase();
  if (value === "native") return { name: "native" };
  const preset = PRESETS.get(value);
  if (preset) return { name: value, width: preset[0], height: preset[1] };
  const match = value.match(/^(\d+)x(\d+)$/u);
  if (!match) throw new Error("--resolution must be native, a named preset, or WIDTHxHEIGHT");
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("custom --resolution WIDTH and HEIGHT must be positive integers");
  }
  return { name: `${width}x${height}`, width, height };
};

const parse = (argv: readonly string[]): Args => {
  let url = "";
  let fps = 12;
  let status = true;
  let resolution: Resolution = { name: "native" };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value === "--fps") {
      const raw = argv[++i];
      if (!raw) throw new Error("--fps requires an integer value");
      fps = Number.parseInt(raw, 10);
      continue;
    }
    if (value === "--resolution" || value === "-r") {
      const raw = argv[++i];
      if (!raw) throw new Error("--resolution requires a mode");
      resolution = parseResolution(raw);
      continue;
    }
    if (value === "--no-status") {
      status = false;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`Unexpected option in native backend: ${value}`);
    if (!url) url = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }

  if (!url) throw new Error("native backend requires a launch URL");
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error("--fps must be an integer from 1 to 120");
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(url)) url = `https://${url}`;
  return { url, fps, status, resolution };
};

const terminalSize = (showStatus: boolean): TerminalSize => ({
  columns: Math.max(8, process.stdout.columns ?? 120),
  rows: Math.max(4, (process.stdout.rows ?? 40) - (showStatus ? 1 : 0)),
});

const geometryFor = (terminal: TerminalSize, resolution: Resolution): Geometry => {
  const fixed = resolution.width !== undefined && resolution.height !== undefined;
  const browserWidth = Math.max(MIN_WINDOW_WIDTH, fixed ? resolution.width! : terminal.columns * NATIVE_CELL_WIDTH);
  const browserHeight = Math.max(MIN_WINDOW_HEIGHT, fixed ? resolution.height! : terminal.rows * NATIVE_CELL_HEIGHT);
  return {
    ...terminal,
    browserWidth,
    browserHeight,
    pointerWidth: browserWidth / terminal.columns,
    pointerHeight: browserHeight / terminal.rows,
  };
};

const at = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`;
const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const streamBytes = async (stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<Uint8Array> => {
  if (stream === null || stream === undefined || typeof stream === "number") return new Uint8Array(0);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const streamText = async (stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> => {
  if (stream === null || stream === undefined || typeof stream === "number") return "";
  return await new Response(stream).text();
};

const runBytes = async (argv: readonly string[]): Promise<Uint8Array> => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = streamBytes(proc.stdout);
  const stderrPromise = streamText(proc.stderr);
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr.trim() || "unknown error"}`);
  return stdout;
};

const runBytesWithInput = async (argv: readonly string[], input: Uint8Array): Promise<Uint8Array> => {
  const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  proc.stdin.end();
  const stdoutPromise = streamBytes(proc.stdout);
  const stderrPromise = streamText(proc.stderr);
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr.trim() || "unknown error"}`);
  return stdout;
};

const runText = async (argv: readonly string[]): Promise<string> =>
  new TextDecoder().decode(await runBytes(argv)).trim();

const runQuiet = async (argv: readonly string[]): Promise<boolean> => {
  const proc = Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" });
  return await proc.exited === 0;
};

const nativeExecutable = async (): Promise<string> => {
  const override = process.env.KITTY_BROWSER_CHROMIUM_EXECUTABLE?.trim();
  const candidates = [
    override,
    Bun.which("google-chrome-stable"),
    Bun.which("google-chrome"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
    await bundledChromiumExecutable(),
    chromium.executablePath(),
  ];
  const executable = candidates.find((candidate): candidate is string => Boolean(candidate));
  if (!executable) {
    throw new Error("native backend could not find Chromium; install chromium/google-chrome or set KITTY_BROWSER_CHROMIUM_EXECUTABLE");
  }
  return executable;
};

const kittyDelete = (): string => `\x1b_Ga=d,d=I,i=${KITTY_IMAGE_ID},q=2;\x1b\\`;

const kittyFrame = (png: Uint8Array, geometry: Geometry): string => {
  const encoded = Buffer.from(png).toString("base64");
  let output = at(0, 0);
  for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK) {
    const chunk = encoded.slice(offset, offset + KITTY_CHUNK);
    const more = offset + KITTY_CHUNK < encoded.length ? 1 : 0;
    const control = offset === 0
      ? `a=T,f=100,i=${KITTY_IMAGE_ID},p=${KITTY_PLACEMENT_ID},c=${geometry.columns},r=${geometry.rows},z=0,C=1,q=2,N=1,m=${more}`
      : `q=2,m=${more}`;
    output += `\x1b_G${control};${chunk}\x1b\\`;
  }
  return output;
};

const stdout = async (value: string): Promise<void> => {
  if (process.stdout.write(value)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
};

const xdotool = Bun.which("xdotool");
const imageImport = Bun.which("import");
const imageConvert = Bun.which("magick") ?? Bun.which("convert");
if (process.platform !== "linux") throw new Error("--backend native currently requires Linux/X11");
if (!process.env.DISPLAY) throw new Error("--backend native requires DISPLAY; use the normal Kitty launcher so it can start Xvfb");
if (!xdotool || !imageImport || !imageConvert) {
  throw new Error("--backend native requires xdotool plus ImageMagick import/convert (Ubuntu: sudo apt-get install -y xdotool imagemagick)");
}
if (process.env[STRICT_ENV] === "1") {
  throw new Error("--strict is not yet available with --backend native because native mode deliberately has no page-inspection transport");
}

const audioWs = consumeAudioWebSocketArg();
const args = parse(process.argv.slice(2));
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("native Kitty backend requires an interactive TTY");

let geometry = geometryFor(terminalSize(args.status), args.resolution);
let actualWindow: WindowGeometry = { width: geometry.browserWidth, height: geometry.browserHeight };
let running = true;
let shuttingDown = false;
let cleanedUp = false;
let resizePending = false;
let frame = 0;
let cursorX = Math.floor(geometry.columns / 2);
let cursorY = Math.floor(geometry.rows / 2);
let lastStatus = "";
let leftPress: LeftPress | null = null;
let auxiliaryButton: MouseButton | null = null;
let inputQueue: Promise<void> = Promise.resolve();
let browser: ReturnType<typeof Bun.spawn> | null = null;
let windowId: string | null = null;

const audio = await tryOpenChromiumAudioStream(audioWs);
const profileDir = join(process.env.KITTY_BROWSER_PROFILE_ROOT?.trim() || PROFILE_ROOT, browserSessionId());
await mkdir(profileDir, { recursive: true });
const executable = await nativeExecutable();
const wmClass = `kitty-browser-native-${process.pid}`;

const browserEnv = Object.fromEntries(
  Object.entries({ ...process.env, ...(audio?.browserEnv ?? {}) })
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);

browser = Bun.spawn([
  executable,
  `--user-data-dir=${profileDir}`,
  `--class=${wmClass}`,
  "--window-position=0,0",
  `--window-size=${geometry.browserWidth},${geometry.browserHeight}`,
  "--no-first-run",
  "--no-default-browser-check",
  args.url,
], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
  env: browserEnv,
});

const parseWindowGeometry = (text: string): WindowGeometry | null => {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z]+)=(\d+)$/u);
    if (match) values.set(match[1]!, Number.parseInt(match[2]!, 10));
  }
  const width = values.get("WIDTH");
  const height = values.get("HEIGHT");
  return width && height ? { width, height } : null;
};

const windowGeometry = async (id: string): Promise<WindowGeometry | null> => {
  try {
    return parseWindowGeometry(await runText([xdotool, "getwindowgeometry", "--shell", id]));
  } catch {
    return null;
  }
};

const findBrowserWindow = async (): Promise<string> => {
  const deadline = Date.now() + WINDOW_WAIT_MS;
  while (Date.now() < deadline) {
    const ids = await runText([xdotool, "search", "--class", wmClass]).catch(() => "");
    const candidates = ids.split(/\s+/u).filter(Boolean);
    let best: { id: string; area: number; geometry: WindowGeometry } | null = null;
    for (const id of candidates) {
      const candidateGeometry = await windowGeometry(id);
      if (!candidateGeometry) continue;
      const area = candidateGeometry.width * candidateGeometry.height;
      if (!best || area > best.area) best = { id, area, geometry: candidateGeometry };
    }
    if (best) {
      actualWindow = best.geometry;
      return best.id;
    }
    await Bun.sleep(WINDOW_POLL_MS);
  }
  throw new Error(`native Chromium did not create an X11 window with class ${wmClass} within ${WINDOW_WAIT_MS}ms`);
};

try {
  windowId = await findBrowserWindow();
} catch (error) {
  try { browser.kill(); } catch { /* already gone */ }
  await audio?.close();
  throw error;
}

const nativeWindowId = (): string => {
  if (windowId === null) throw new Error("native Chromium window is unavailable");
  return windowId;
};

const focusWindow = async (): Promise<void> => {
  await runQuiet([xdotool, "windowfocus", "--sync", nativeWindowId()]);
};

const resizeWindow = async (): Promise<void> => {
  const id = nativeWindowId();
  await runQuiet([xdotool, "windowmove", id, "0", "0"]);
  await runQuiet([xdotool, "windowsize", id, String(geometry.browserWidth), String(geometry.browserHeight)]);
  actualWindow = await windowGeometry(id) ?? { width: geometry.browserWidth, height: geometry.browserHeight };
};

await resizeWindow();
await focusWindow();

const browserPoint = (x = cursorX, y = cursorY): { x: number; y: number } => ({
  x: Math.round((x + 0.5) * actualWindow.width / geometry.columns),
  y: Math.round((y + 0.5) * actualWindow.height / geometry.rows),
});

const movePointer = async (x = cursorX, y = cursorY): Promise<void> => {
  const point = browserPoint(x, y);
  await runQuiet([xdotool, "mousemove", "--window", nativeWindowId(), String(point.x), String(point.y)]);
};

const mouseDown = async (button: number): Promise<void> => {
  await runQuiet([xdotool, "mousedown", String(button)]);
};

const mouseUp = async (button: number): Promise<void> => {
  await runQuiet([xdotool, "mouseup", String(button)]);
};

const mouseClick = async (button: number, repeat = 1): Promise<void> => {
  await runQuiet([
    xdotool,
    "click",
    ...(repeat > 1 ? ["--repeat", String(repeat), "--delay", "0"] : []),
    String(button),
  ]);
};

const scroll = async (dx: number, dy: number): Promise<void> => {
  if (dy !== 0) await mouseClick(dy < 0 ? 4 : 5, Math.max(1, Math.abs(dy) * 2));
  if (dx !== 0) await mouseClick(dx < 0 ? 6 : 7, Math.max(1, Math.abs(dx) * 2));
};

const xKey = async (key: string): Promise<void> => {
  await focusWindow();
  await runQuiet([xdotool, "key", "--clearmodifiers", key]);
};

const xType = async (text: string): Promise<void> => {
  if (!text) return;
  await focusWindow();
  await runQuiet([xdotool, "type", "--clearmodifiers", "--delay", "0", "--", text]);
};

const navigate = async (url: string): Promise<void> => {
  await xKey("ctrl+l");
  await xType(url);
  await xKey("Return");
};

const normaliseUrl = (raw: string): string => {
  const value = raw.trim();
  if (!value) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  return `https://${value}`;
};

let displayUrl = args.url;
let navEditing = false;
let navValue = "";
let navCursor = 0;

const controls = " [<] [R] ";
const renderStatus = (): string => {
  if (!args.status) return "";
  const metadata = `  native  ${args.fps}fps  session:${browserSessionId()}  audio:${audio ? "on" : "off"} `;
  const available = Math.max(1, geometry.columns - controls.length - metadata.length);
  const source = navEditing ? navValue : displayUrl;
  let visible: string;
  if (navEditing) {
    const start = Math.max(0, Math.min(navCursor, Math.max(0, source.length - available + 1)));
    const relative = navCursor - start;
    visible = `${source.slice(start, start + relative)}▏${source.slice(start + relative)}`.slice(0, available);
  } else {
    visible = source.slice(0, available);
  }
  return `${controls}${visible.padEnd(available, " ")}${metadata}`.slice(0, geometry.columns).padEnd(geometry.columns, " ");
};

const paintStatus = (): void => {
  if (!args.status || shuttingDown) return;
  const value = renderStatus();
  if (value === lastStatus) return;
  process.stdout.write(`${at(0, geometry.rows)}\x1b[7m${value}\x1b[0m`);
  lastStatus = value;
};

const handleStatusMouse = async (event: TerminalMouseEvent): Promise<boolean> => {
  if (!args.status || event.y !== geometry.rows) return false;
  if (event.kind !== "press" || (event.button && event.button !== "left")) return true;
  if (event.x >= 1 && event.x < 4) {
    navEditing = false;
    await xKey("alt+Left");
  } else if (event.x >= 5 && event.x < 8) {
    navEditing = false;
    await xKey("ctrl+r");
  } else if (event.x >= controls.length) {
    navEditing = true;
    navValue = displayUrl;
    navCursor = navValue.length;
  }
  lastStatus = "";
  paintStatus();
  return true;
};

const handleNavKey = async (text: string): Promise<boolean> => {
  if (!navEditing) return false;
  if (text === "\x1b") {
    navEditing = false;
  } else if (text === "\r") {
    displayUrl = normaliseUrl(navValue);
    navEditing = false;
    await navigate(displayUrl);
  } else if (text === "\x7f") {
    if (navCursor > 0) {
      navValue = `${navValue.slice(0, navCursor - 1)}${navValue.slice(navCursor)}`;
      navCursor -= 1;
    }
  } else if (text === "\x1b[D") {
    navCursor = Math.max(0, navCursor - 1);
  } else if (text === "\x1b[C") {
    navCursor = Math.min(navValue.length, navCursor + 1);
  } else if (!text.startsWith("\x1b") && !/[\x00-\x1f\x7f]/u.test(text)) {
    navValue = `${navValue.slice(0, navCursor)}${text}${navValue.slice(navCursor)}`;
    navCursor += [...text].length;
  }
  lastStatus = "";
  paintStatus();
  return true;
};

const pointFromMouse = async (x: number, y: number): Promise<boolean> => {
  if (x < 0 || x >= geometry.columns || y < 0 || y >= geometry.rows) return false;
  cursorX = x;
  cursorY = y;
  await movePointer();
  lastStatus = "";
  paintStatus();
  return true;
};

const handleMouse = async (event: TerminalMouseEvent): Promise<void> => {
  if (shuttingDown || await handleStatusMouse(event)) return;
  if (!(await pointFromMouse(event.x, event.y))) return;

  if (event.kind === "wheel") {
    if (leftPress?.buttonDown) await mouseUp(1);
    leftPress = null;
    await scroll(event.dx, event.dy);
    return;
  }

  if (event.kind === "press") {
    if (!event.button || event.button === "left") {
      leftPress = { lastX: event.x, lastY: event.y, dragging: false, buttonDown: true };
      await mouseDown(1);
      return;
    }
    auxiliaryButton = event.button;
    await mouseDown(event.button === "middle" ? 2 : 3);
    return;
  }

  if (event.kind === "move") {
    const press = leftPress;
    if (!press) return;
    const dx = event.x - press.lastX;
    const dy = event.y - press.lastY;
    if (!dx && !dy) return;

    press.lastX = event.x;
    press.lastY = event.y;
    if (!press.dragging) {
      press.dragging = true;
      if (press.buttonDown) {
        // Move before releasing so a touch swipe does not become a click at the
        // original location. Subsequent motion is translated to wheel scrolling,
        // preserving Kitty Browser's existing phone interaction model.
        await movePointer();
        await mouseUp(1);
        press.buttonDown = false;
      }
    }
    await scroll(-dx, -dy);
    return;
  }

  if (leftPress) {
    if (leftPress.buttonDown) await mouseUp(1);
    leftPress = null;
    return;
  }

  if (auxiliaryButton) {
    await mouseUp(auxiliaryButton === "middle" ? 2 : 3);
    auxiliaryButton = null;
  }
};

const moveCursor = async (dx: number, dy: number): Promise<void> => {
  const nextX = cursorX + dx;
  const nextY = cursorY + dy;
  if (nextX < 0 || nextX >= geometry.columns || nextY < 0 || nextY >= geometry.rows) {
    await scroll(dx, dy);
    return;
  }
  cursorX = nextX;
  cursorY = nextY;
  await movePointer();
  paintStatus();
};

const activate = async (): Promise<void> => {
  await movePointer();
  await mouseClick(1);
};

const handleKey = async (text: string): Promise<void> => {
  if (text === "\x03") {
    running = false;
    return;
  }
  if (await handleNavKey(text)) return;
  if (text === "\x1b[A") return void await moveCursor(0, -1);
  if (text === "\x1b[B") return void await moveCursor(0, 1);
  if (text === "\x1b[C") return void await moveCursor(1, 0);
  if (text === "\x1b[D") return void await moveCursor(-1, 0);
  if (text === "\r") return void await activate();
  if (text === "\t") return void await xKey("Tab");
  if (text === "\x1b[Z") return void await xKey("shift+Tab");
  if (text === "\x1b[5~") return void await xKey("Prior");
  if (text === "\x1b[6~") return void await xKey("Next");
  if (text === "\x7f") return void await xKey("BackSpace");
  if (text === "\x1b") return void await xKey("Escape");
  if (!text.startsWith("\x1b") && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) await xType(text);
};

const pointerDrawArgs = (): string[] => {
  const highlighted = Math.floor(frame / Math.max(1, args.fps)) % 2 === 0;
  if (!highlighted) return [];
  const point = browserPoint();
  const halfWidth = Math.max(3, Math.round(actualWindow.width / geometry.columns / 2));
  const halfHeight = Math.max(3, Math.round(actualWindow.height / geometry.rows / 2));
  const x1 = clamp(point.x - halfWidth, 0, actualWindow.width - 1);
  const y1 = clamp(point.y - halfHeight, 0, actualWindow.height - 1);
  const x2 = clamp(point.x + halfWidth, 0, actualWindow.width - 1);
  const y2 = clamp(point.y + halfHeight, 0, actualWindow.height - 1);
  return [
    "-fill", "#003060",
    "-stroke", "white",
    "-strokewidth", "2",
    "-draw", `rectangle ${x1},${y1} ${x2},${y2}`,
  ];
};

const captureWindow = async (): Promise<Uint8Array> => {
  // Reading Chromium's own drawable with ImageMagick import is unreliable on
  // Chromium's accelerated/composited X11 window and can fail with
  // "Resource temporarily unavailable" even while the window is mapped.
  // Native mode owns this Xvfb display and pins Chromium to (0, 0), so capture
  // the stable root framebuffer and crop exactly to the browser window instead.
  const root = await runBytes([imageImport, "-silent", "-window", "root", "png:-"]);
  const draw = pointerDrawArgs();
  return await runBytesWithInput([
    imageConvert,
    "png:-",
    "-crop", `${actualWindow.width}x${actualWindow.height}+0+0`,
    "+repage",
    ...draw,
    "png:-",
  ], root);
};

const applyResize = async (): Promise<void> => {
  if (!resizePending || shuttingDown) return;
  resizePending = false;
  const next = geometryFor(terminalSize(args.status), args.resolution);
  const changed = next.browserWidth !== geometry.browserWidth || next.browserHeight !== geometry.browserHeight;
  geometry = next;
  cursorX = clamp(cursorX, 0, geometry.columns - 1);
  cursorY = clamp(cursorY, 0, geometry.rows - 1);
  if (changed) await resizeWindow();
  process.stdout.write(`${kittyDelete()}\x1b[2J`);
  lastStatus = "";
};

const beginShutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
};

const cleanup = async (): Promise<void> => {
  if (cleanedUp) return;
  cleanedUp = true;
  process.stdout.write(`${MOUSE_DISABLE}${kittyDelete()}\x1b[?25h\x1b[0m\n`);
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* tty already gone */ }
  process.stdin.pause();
  if (leftPress?.buttonDown) await mouseUp(1).catch(() => undefined);
  if (auxiliaryButton) await mouseUp(auxiliaryButton === "middle" ? 2 : 3).catch(() => undefined);
  try { browser?.kill(); } catch { /* already exited */ }
  await audio?.close();
};

process.once("SIGINT", beginShutdown);
process.once("SIGTERM", beginShutdown);
process.on("SIGWINCH", () => { resizePending = true; });
void browser.exited.then(() => beginShutdown());

const mouseDecoder = new TerminalMouseDecoder();
process.stdin.setEncoding("utf8");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write(`${MOUSE_ENABLE}\x1b[?25l\x1b[2J`);

process.stdin.on("data", (chunk: string) => {
  for (const input of mouseDecoder.push(chunk)) {
    inputQueue = inputQueue.then(async () => {
      if (input.kind === "mouse") await handleMouse(input.event);
      else await handleKey(input.text);
    }).catch((error: unknown) => {
      beginShutdown();
      process.stderr.write(`\nnative input error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
});

try {
  const frameDelayMs = 1_000 / args.fps;
  while (running) {
    const started = performance.now();
    await applyResize();
    if (!running) break;
    const captureStartedNs = monotonicNs();
    const png = await captureWindow();
    const captureTimestampNs = midpointNs(captureStartedNs, monotonicNs());
    await stdout(`${mediaFrameMarker(frame, args.fps, captureTimestampNs)}${kittyFrame(png, geometry)}`);
    paintStatus();
    frame += 1;
    const remaining = frameDelayMs - (performance.now() - started);
    if (remaining > 0) await Bun.sleep(remaining);
  }
} finally {
  await inputQueue.catch(() => undefined);
  await cleanup();
}