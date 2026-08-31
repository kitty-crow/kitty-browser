#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { makeArt } from "../vendor/unicode-art-studio/src/core/art.ts";
import type { CellColour, Rgb } from "../vendor/unicode-art-studio/src/types.ts";
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  TerminalMouseDecoder,
  type MouseButton,
  type TerminalMouseEvent,
} from "./terminal-mouse.ts";

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
  readonly renderColumns: number;
  readonly renderRows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}

interface Cell {
  readonly ch: string;
  readonly fg?: Rgb;
  readonly bg?: Rgb;
}

interface SwipeState {
  lastX: number;
  lastY: number;
  moved: boolean;
}

const POINTER_BLUE: Rgb = { r: 0, g: 48, b: 96 };
const POINTER_GREEN: Rgb = { r: 0, g: 80, b: 48 };
const POINTER_FG: Rgb = { r: 255, g: 255, b: 255 };
const NATIVE_CELL_WIDTH = 8;
const NATIVE_CELL_HEIGHT = 16;
const MIN_WHEEL_PIXELS = 48;
const WHEEL_CELL_MULTIPLIER = 3;
const XVFB_REEXEC = "KITTY_BROWSER_DENSE_UNICODE_V2_XVFB_REEXEC";

const PRESETS = new Map<string, readonly [number, number]>([
  ["cga", [320, 200]],
  ["320x200", [320, 200]],
  ["800x600", [800, 600]],
  ["960x540", [960, 540]],
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

const help = (code: number): never => {
  console.log(`kitty-browser dense Unicode browser

Usage:
  bun run terminal:dense-unicode -- <url> [options]

Options:
  --fps <n>                  Capture rate, integer 1-60; default 1
  --resolution <mode>        native, cga, 800x600, 960x540, 720p, 1080p,
                             or any positive WIDTHxHEIGHT; default 720p
  --no-status                Hide the bottom status bar

Dense Unicode keeps the terminal as a fixed Braille-dot display. Increasing Chromium's
viewport resolution therefore compresses more browser pixels into the same terminal
cells, making text and page detail genuinely smaller/denser instead of creating a larger
virtual canvas.

Controls:
  Mouse move                 Move/hover the browser pointer
  Left click / tap           Activate the page position
  Left drag / touch swipe    Scroll naturally; release does not click after a swipe
  Wheel / two-finger swipe   Scroll vertically or horizontally
  Right / middle click       Forward the corresponding browser button
  Arrow keys                 Move one displayed Braille cell; at an edge, scroll
  Enter                      Activate/click selected page position
  Tab / Shift+Tab            Follow Chromium's native focus order
  PgUp / PgDn                Scroll browser viewport
  Esc                        Leave text-entry mode
  Ctrl+C                     Quit`);
  process.exit(code);
};

const parse = (argv: readonly string[]): Args => {
  let url = "";
  let fps = 1;
  let status = true;
  let resolution: Resolution = { name: "720p", width: 1280, height: 720 };

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
    if (value === "--help" || value === "-h") help(0);
    if (!url) url = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }

  if (!url) help(2);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("--fps must be an integer from 1 to 60");
  if (!/^https?:\/\//iu.test(url)) url = `https://${url}`;
  return { url, fps, status, resolution };
};

const ensureVirtualDisplay = async (): Promise<void> => {
  if (process.platform !== "linux" || process.env.DISPLAY || process.env[XVFB_REEXEC] === "1") return;

  const child = Bun.spawn([
    "xvfb-run",
    "-a",
    "-s",
    "-screen 0 4096x2160x24 -nolisten tcp",
    process.execPath,
    import.meta.path,
    ...process.argv.slice(2),
  ], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, [XVFB_REEXEC]: "1" },
  });

  process.exit(await child.exited);
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const eqRgb = (a?: Rgb, b?: Rgb): boolean =>
  (!a && !b) || (!!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b);
const eqCell = (a?: Cell, b?: Cell): boolean =>
  !!a && !!b && a.ch === b.ch && eqRgb(a.fg, b.fg) && eqRgb(a.bg, b.bg);
const ansiFg = (rgb?: Rgb): string => rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : "\x1b[39m";
const ansiBg = (rgb?: Rgb): string => rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : "\x1b[49m";
const at = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`;

const terminalSize = (showStatus: boolean): TerminalSize => ({
  columns: Math.max(8, process.stdout.columns ?? 120),
  rows: Math.max(4, (process.stdout.rows ?? 40) - (showStatus ? 1 : 0)),
});

const brailleRowsFor = (browserWidth: number, browserHeight: number, columns: number): number => {
  const dotsWidth = Math.max(16, columns * 2);
  const rawHeight = Math.max(4, Math.round(dotsWidth * browserHeight / browserWidth));
  const dotsHeight = Math.max(4, Math.round(rawHeight / 4) * 4);
  return Math.max(1, dotsHeight / 4);
};

const geometryFor = (terminal: TerminalSize, resolution: Resolution): Geometry => {
  const fixed = resolution.width !== undefined && resolution.height !== undefined;
  const browserWidth = fixed ? resolution.width! : terminal.columns * NATIVE_CELL_WIDTH;
  const browserHeight = fixed ? resolution.height! : terminal.rows * NATIVE_CELL_HEIGHT;

  // Dense mode is intentionally the inverse of the old virtual-canvas mode:
  // Chromium can become arbitrarily large, but the output Braille grid never
  // grows beyond the physical terminal. Higher resolution therefore means
  // more browser pixels per terminal cell and genuinely smaller typography.
  let renderColumns = Math.max(8, Math.min(terminal.columns, Math.max(8, Math.floor(browserWidth / 2))));
  let renderRows = brailleRowsFor(browserWidth, browserHeight, renderColumns);

  if (renderRows > terminal.rows) {
    const byHeight = Math.floor((terminal.rows * 2 * browserWidth) / browserHeight);
    renderColumns = Math.max(8, Math.min(renderColumns, byHeight));
    renderRows = brailleRowsFor(browserWidth, browserHeight, renderColumns);
  }

  renderRows = Math.min(renderRows, terminal.rows);

  return {
    ...terminal,
    browserWidth,
    browserHeight,
    renderColumns,
    renderRows,
    cellWidth: browserWidth / renderColumns,
    cellHeight: browserHeight / renderRows,
  };
};

const cellsFromArt = (
  text: string,
  colours: readonly CellColour[] | undefined,
  columns: number,
  rows: number,
): Cell[] => {
  const lines = text.split("\n");
  const out: Cell[] = new Array(columns * rows);
  for (let y = 0; y < rows; y += 1) {
    const chars = [...(lines[y] ?? "")];
    for (let x = 0; x < columns; x += 1) {
      const colour = colours?.[y * columns + x];
      out[y * columns + x] = {
        ch: chars[x] ?? "⠀",
        ...(colour?.fg ? { fg: colour.fg } : {}),
        ...(colour?.bg ? { bg: colour.bg } : {}),
      };
    }
  }
  return out;
};

const cursorCell = (base: Cell, highlighted: boolean): Cell => {
  if (!highlighted) return base;
  return {
    ch: base.ch,
    fg: POINTER_FG,
    bg: eqRgb(base.bg, POINTER_BLUE) ? POINTER_GREEN : POINTER_BLUE,
  };
};

const navigationRace = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed")
    || message.includes("most likely because of a navigation")
    || message.includes("Cannot find context with specified id")
    || message.includes("Inspected target navigated or closed")
    || message.includes("Frame was detached");
};

const activeRect = async (page: Page): Promise<{ x: number; y: number; width: number; height: number } | undefined> => {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return undefined;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return undefined;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  } catch (error) {
    if (navigationRace(error)) return undefined;
    throw error;
  }
};

const editableAt = async (page: Page, x: number, y: number): Promise<boolean> => {
  try {
    return await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
      if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
      return ["text", "password", "email", "search", "tel", "url", "number"].includes(el.type);
    }, { x, y });
  } catch (error) {
    if (navigationRace(error)) return false;
    throw error;
  }
};

const args = parse(process.argv.slice(2));
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("terminal:dense-unicode requires an interactive TTY");
await ensureVirtualDisplay();

const browser = await chromium.launch({ headless: false, channel: "chromium" });
const page = await browser.newPage();
let geometry = geometryFor(terminalSize(args.status), args.resolution);
await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

let running = true;
let inputMode = false;
let cursorX = Math.floor(geometry.renderColumns / 2);
let cursorY = Math.floor(geometry.renderRows / 2);
let frame = 0;
let baseCells: Cell[] = [];
let painted: Cell[] = [];
let forceFull = true;
let resizePending = false;
let lastStatus = "";
let swipe: SwipeState | undefined;
let auxiliaryButton: MouseButton | undefined;
const mouseDecoder = new TerminalMouseDecoder();

page.on("framenavigated", (frameHandle) => {
  if (frameHandle !== page.mainFrame()) return;
  inputMode = false;
  swipe = undefined;
  auxiliaryButton = undefined;
  cursorX = Math.floor(geometry.renderColumns / 2);
  cursorY = Math.floor(geometry.renderRows / 2);
  forceFull = true;
  painted = [];
  lastStatus = "";
});

const pointerHighlighted = (): boolean => Math.floor(Math.max(0, frame - 1) / args.fps) % 2 === 0;

const status = (): string => {
  const mode = inputMode ? "INPUT" : "NAV";
  const resolution = args.resolution.name === "native"
    ? `native ${geometry.browserWidth}x${geometry.browserHeight}`
    : `${args.resolution.name} ${geometry.browserWidth}x${geometry.browserHeight}`;
  const raw = ` ${page.url()}  ${mode}  ${args.fps}fps  dense-unicode  ${resolution} -> ${geometry.renderColumns}x${geometry.renderRows} cells (${geometry.renderColumns * 2}x${geometry.renderRows * 4} dots)  pointer ${cursorX},${cursorY} `;
  return raw.length > geometry.columns ? raw.slice(0, geometry.columns) : raw.padEnd(geometry.columns, " ");
};

const paintStatus = (full = false): void => {
  if (!args.status) return;
  const value = status();
  if (!full && value === lastStatus) return;
  process.stdout.write(`${at(0, geometry.rows)}\x1b[7m${value}\x1b[0m`);
  lastStatus = value;
};

const displayCell = (x: number, y: number): Cell => {
  if (x >= geometry.renderColumns || y >= geometry.renderRows) return { ch: " " };
  const base = baseCells[y * geometry.renderColumns + x] ?? { ch: "⠀" };
  return x === cursorX && y === cursorY ? cursorCell(base, pointerHighlighted()) : base;
};

const paint = (full = false): void => {
  if (!baseCells.length) return;
  const next: Cell[] = new Array(geometry.columns * geometry.rows);
  let output = "";

  for (let y = 0; y < geometry.rows; y += 1) {
    for (let x = 0; x < geometry.columns; x += 1) {
      const index = y * geometry.columns + x;
      const cell = displayCell(x, y);
      next[index] = cell;
      if (!full && eqCell(cell, painted[index])) continue;
      output += `${at(x, y)}${ansiFg(cell.fg)}${ansiBg(cell.bg)}${cell.ch}`;
    }
  }

  if (output) process.stdout.write(`${output}\x1b[0m`);
  painted = next;
  paintStatus(full);
};

const browserPoint = (x: number, y: number) => ({
  x: (x + 0.5) * geometry.cellWidth,
  y: (y + 0.5) * geometry.cellHeight,
});

const hoverPointer = async (): Promise<void> => {
  const point = browserPoint(cursorX, cursorY);
  await page.mouse.move(point.x, point.y);
};

const movePointer = async (dx: number, dy: number): Promise<void> => {
  const nextX = cursorX + dx;
  const nextY = cursorY + dy;
  if (nextX < 0 || nextX >= geometry.renderColumns || nextY < 0 || nextY >= geometry.renderRows) {
    await page.mouse.wheel(dx * geometry.cellWidth, dy * geometry.cellHeight);
    return;
  }
  cursorX = nextX;
  cursorY = nextY;
  await hoverPointer();
  paint(false);
};

const followFocus = async (): Promise<void> => {
  const rect = await activeRect(page);
  if (!rect) return;
  cursorX = clamp(Math.floor((rect.x + rect.width / 2) / geometry.cellWidth), 0, geometry.renderColumns - 1);
  cursorY = clamp(Math.floor((rect.y + rect.height / 2) / geometry.cellHeight), 0, geometry.renderRows - 1);
  await hoverPointer();
  paint(false);
};

const activate = async (): Promise<void> => {
  const point = browserPoint(cursorX, cursorY);
  const editable = await editableAt(page, point.x, point.y);
  await page.mouse.click(point.x, point.y);
  inputMode = editable;
  paintStatus(true);
};

const pointFromMouse = async (x: number, y: number): Promise<boolean> => {
  if (x < 0 || x >= geometry.renderColumns || y < 0 || y >= geometry.renderRows) return false;
  cursorX = x;
  cursorY = y;
  await hoverPointer();
  paint(false);
  return true;
};

const handleMouse = async (event: TerminalMouseEvent): Promise<void> => {
  if (!(await pointFromMouse(event.x, event.y))) return;

  if (event.kind === "wheel") {
    swipe = undefined;
    const stepX = Math.max(MIN_WHEEL_PIXELS, geometry.cellWidth * WHEEL_CELL_MULTIPLIER);
    const stepY = Math.max(MIN_WHEEL_PIXELS, geometry.cellHeight * WHEEL_CELL_MULTIPLIER);
    await page.mouse.wheel(event.dx * stepX, event.dy * stepY);
    return;
  }

  if (event.kind === "press") {
    if (!event.button || event.button === "left") {
      swipe = { lastX: event.x, lastY: event.y, moved: false };
      return;
    }
    auxiliaryButton = event.button;
    await page.mouse.down({ button: event.button });
    return;
  }

  if (event.kind === "move") {
    if (!swipe) return;
    const dx = event.x - swipe.lastX;
    const dy = event.y - swipe.lastY;
    if (dx || dy) {
      swipe.moved = true;
      swipe.lastX = event.x;
      swipe.lastY = event.y;
      await page.mouse.wheel(-dx * geometry.cellWidth, -dy * geometry.cellHeight);
    }
    return;
  }

  if (swipe) {
    const wasSwipe = swipe.moved;
    swipe = undefined;
    if (!wasSwipe) await activate();
    return;
  }

  if (auxiliaryButton) {
    await page.mouse.up({ button: auxiliaryButton });
    auxiliaryButton = undefined;
  }
};

const applyResize = async (): Promise<void> => {
  if (!resizePending) return;
  resizePending = false;
  const previous = geometry;
  geometry = geometryFor(terminalSize(args.status), args.resolution);
  const browserChanged = previous.browserWidth !== geometry.browserWidth || previous.browserHeight !== geometry.browserHeight;
  cursorX = clamp(cursorX, 0, geometry.renderColumns - 1);
  cursorY = clamp(cursorY, 0, geometry.renderRows - 1);
  if (browserChanged) await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
  process.stdout.write("\x1b[2J");
  painted = [];
  lastStatus = "";
  forceFull = true;
};

const capture = async (): Promise<void> => {
  try {
    await applyResize();
    const screenshot = await page.screenshot({ type: "png" });
    const png = PNG.sync.read(screenshot);
    const art = makeArt(
      { width: png.width, height: png.height, data: png.data },
      {
        columns: geometry.renderColumns,
        dither: "atkinson",
        contrast: 1,
        detail: 0.8,
        bias: 0,
        invert: false,
        colour: true,
        colourBackground: true,
        fullColour: true,
      },
    );

    baseCells = cellsFromArt(art.text, art.cellColours, geometry.renderColumns, geometry.renderRows);
    frame += 1;
    paint(forceFull);
    forceFull = false;
  } catch (error) {
    if (navigationRace(error)) {
      await page.waitForLoadState("domcontentloaded", { timeout: 750 }).catch(() => undefined);
      return;
    }
    throw error;
  }
};

const key = async (text: string): Promise<void> => {
  if (text === "\x03") {
    running = false;
    return;
  }

  if (inputMode) {
    if (text === "\x1b") {
      inputMode = false;
      paintStatus(true);
      return;
    }
    if (text === "\x7f") return void await page.keyboard.press("Backspace");
    if (text === "\r") return void await page.keyboard.press("Enter");
    if (text === "\t") return void await page.keyboard.press("Tab");
    if (text === "\x1b[A") return void await page.keyboard.press("ArrowUp");
    if (text === "\x1b[B") return void await page.keyboard.press("ArrowDown");
    if (text === "\x1b[C") return void await page.keyboard.press("ArrowRight");
    if (text === "\x1b[D") return void await page.keyboard.press("ArrowLeft");
    if (!text.startsWith("\x1b") && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)) await page.keyboard.insertText(text);
    return;
  }

  if (text === "\x1b[A") return void await movePointer(0, -1);
  if (text === "\x1b[B") return void await movePointer(0, 1);
  if (text === "\x1b[C") return void await movePointer(1, 0);
  if (text === "\x1b[D") return void await movePointer(-1, 0);
  if (text === "\r") return void await activate();
  if (text === "\t") {
    await page.keyboard.press("Tab");
    return void await followFocus();
  }
  if (text === "\x1b[Z") {
    await page.keyboard.press("Shift+Tab");
    return void await followFocus();
  }
  if (text === "\x1b[5~") {
    await page.mouse.wheel(0, -Math.round(geometry.browserHeight * 0.8));
    return;
  }
  if (text === "\x1b[6~") await page.mouse.wheel(0, Math.round(geometry.browserHeight * 0.8));
};

const cleanup = async (): Promise<void> => {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${MOUSE_DISABLE}\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l`);
  await browser.close();
};

process.env.OPENAI_PILOT_RENDERER = "dense-unicode";
process.stdout.write(`\x1b[?1049h\x1b[?25l\x1b[?7l${MOUSE_ENABLE}\x1b[2J`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode(true);
process.stdin.resume();
let inputQueue = Promise.resolve();
process.stdin.on("data", (chunk: string) => {
  for (const input of mouseDecoder.push(chunk)) {
    inputQueue = inputQueue
      .then(() => input.kind === "mouse" ? handleMouse(input.event) : key(input.text))
      .catch((error) => {
        inputMode = false;
        swipe = undefined;
        auxiliaryButton = undefined;
        lastStatus = "";
        process.stderr.write(`\ninput error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }
});
process.stdout.on("resize", () => { resizePending = true; });

try {
  const interval = 1000 / args.fps;
  while (running) {
    const started = performance.now();
    await capture();
    const remaining = interval - (performance.now() - started);
    if (remaining > 0) await Bun.sleep(remaining);
  }
} finally {
  await cleanup();
}
