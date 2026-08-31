#!/usr/bin/env bun
import { chromium, type Page } from "playwright";
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
  readonly pointerWidth: number;
  readonly pointerHeight: number;
}

interface SwipeState {
  lastX: number;
  lastY: number;
  moved: boolean;
}

const POINTER_BLUE = { r: 0, g: 48, b: 96 } as const;
const POINTER_GREEN = { r: 0, g: 80, b: 48 } as const;
const NATIVE_CELL_WIDTH = 8;
const NATIVE_CELL_HEIGHT = 16;
const KITTY_IMAGE_ID = 0x4f410000 + (process.pid % 65_535);
const KITTY_PLACEMENT_ID = 1;
const KITTY_CHUNK = 4096;
const MIN_WHEEL_PIXELS = 48;
const WHEEL_CELL_MULTIPLIER = 3;

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
  if (width < 800 || height < 600 || width > 1920 || height > 1080) {
    throw new Error("custom --resolution must be between 800x600 and 1920x1080");
  }
  return { name: `${width}x${height}`, width, height };
};

const help = (code: number): never => {
  console.log(`OpenAI Pilot Headed kitty-graphics browser prototype

Usage:
  bun run terminal:kitty -- <url> [options]

Options:
  --fps <n>                  Capture rate, integer 1-60; default 1
  --resolution <mode>        native, 800x600, 1024x768, 720p, 1366x768,
                             900p, 1080p, or explicit WIDTHxHEIGHT
  --no-status                Hide the bottom status bar

Controls:
  Mouse move                 Move/hover the browser pointer
  Left click / tap           Activate the page position
  Left drag / touch swipe    Scroll naturally; release does not click after a swipe
  Wheel / two-finger swipe   Scroll vertically or horizontally
  Right / middle click       Forward the corresponding browser button
  Arrow keys                 Move the pointer one displayed terminal cell
                             At an edge, scroll Chromium by one displayed cell
  Enter                      Activate/click selected page position
  Tab / Shift+Tab            Follow Chromium's native focus order
  PgUp / PgDn                Scroll browser viewport
  Esc                        Leave text-entry mode
  Ctrl+C                     Quit

Chromium renders at the selected pixel resolution. The PNG frame is sent through the
kitty graphics protocol and scaled to the available terminal cell rectangle. The pointer
is rendered inside Chromium at the browser-pixel footprint of one displayed terminal cell.
Touch/trackpad behaviour depends on the client terminal translating gestures into SGR
mouse drag or wheel reports; both forms are handled.`);
  process.exit(code);
};

const parse = (argv: readonly string[]): Args => {
  let url = "";
  let fps = 1;
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
    if (value === "--help" || value === "-h") help(0);
    if (!url) url = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }

  if (!url) help(2);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error("--fps must be an integer from 1 to 60");
  if (!/^https?:\/\//iu.test(url)) url = `https://${url}`;
  return { url, fps, status, resolution };
};

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const at = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`;

const terminalSize = (showStatus: boolean): TerminalSize => ({
  columns: Math.max(8, process.stdout.columns ?? 120),
  rows: Math.max(4, (process.stdout.rows ?? 40) - (showStatus ? 1 : 0)),
});

const geometryFor = (terminal: TerminalSize, resolution: Resolution): Geometry => {
  const fixed = resolution.width !== undefined && resolution.height !== undefined;
  const browserWidth = fixed ? resolution.width! : terminal.columns * NATIVE_CELL_WIDTH;
  const browserHeight = fixed ? resolution.height! : terminal.rows * NATIVE_CELL_HEIGHT;
  return {
    ...terminal,
    browserWidth,
    browserHeight,
    pointerWidth: browserWidth / terminal.columns,
    pointerHeight: browserHeight / terminal.rows,
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

const stdout = async (value: string): Promise<void> => {
  if (process.stdout.write(value)) return;
  await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
};

const kittyDelete = (): string => `\x1b_Ga=d,d=I,i=${KITTY_IMAGE_ID},q=2;\x1b\\`;

const kittyFrame = (png: Uint8Array, geometry: Geometry): string => {
  const encoded = Buffer.from(png).toString("base64");
  let output = at(0, 0);
  for (let offset = 0; offset < encoded.length; offset += KITTY_CHUNK) {
    const chunk = encoded.slice(offset, offset + KITTY_CHUNK);
    const more = offset + KITTY_CHUNK < encoded.length ? 1 : 0;
    const control = offset === 0
      ? `a=T,f=100,i=${KITTY_IMAGE_ID},p=${KITTY_PLACEMENT_ID},c=${geometry.columns},r=${geometry.rows},z=-1,C=1,q=2,N=1,m=${more}`
      : `q=2,m=${more}`;
    output += `\x1b_G${control};${chunk}\x1b\\`;
  }
  return output;
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

const activeRect = async (page: Page): Promise<{ x: number; y: number; width: number; height: number } | undefined> => {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return undefined;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return undefined;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  } catch (error) {
    if (navigationRace(error)) return undefined;
    throw error;
  }
};

const args = parse(process.argv.slice(2));
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("terminal:kitty requires an interactive TTY");

const browser = await chromium.launch({ headless: false, channel: "chromium" });
const page = await browser.newPage();
let geometry = geometryFor(terminalSize(args.status), args.resolution);
await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

let running = true;
let inputMode = false;
let cursorX = Math.floor(geometry.columns / 2);
let cursorY = Math.floor(geometry.rows / 2);
let frame = 0;
let resizePending = false;
let lastStatus = "";
let swipe: SwipeState | undefined;
let auxiliaryButton: MouseButton | undefined;
const mouseDecoder = new TerminalMouseDecoder();

const browserPoint = (x = cursorX, y = cursorY) => ({
  x: (x + 0.5) * geometry.pointerWidth,
  y: (y + 0.5) * geometry.pointerHeight,
});

const pointerHighlighted = (): boolean => Math.floor(frame / args.fps) % 2 === 0;

const status = (): string => {
  const mode = inputMode ? "INPUT" : "NAV";
  const resolution = args.resolution.name === "native"
    ? `native ${geometry.browserWidth}x${geometry.browserHeight}`
    : `${args.resolution.name} ${geometry.browserWidth}x${geometry.browserHeight}`;
  const raw = ` ${page.url()}  ${mode}  ${args.fps}fps  kitty  ${resolution}  pointer ${cursorX},${cursorY}  cell ${geometry.pointerWidth.toFixed(1)}x${geometry.pointerHeight.toFixed(1)}px `;
  return raw.length > geometry.columns ? raw.slice(0, geometry.columns) : raw.padEnd(geometry.columns, " ");
};

const paintStatus = (): void => {
  if (!args.status) return;
  const value = status();
  if (value === lastStatus) return;
  process.stdout.write(`${at(0, geometry.rows)}\x1b[7m${value}\x1b[0m`);
  lastStatus = value;
};

const ensurePointerOverlay = async (): Promise<void> => {
  const point = browserPoint();
  await page.evaluate(({ left, top, width, height, highlighted, blue, green }) => {
    const id = "__openai_pilot_terminal_pointer__";
    let pointer = document.getElementById(id) as HTMLDivElement | null;
    if (!pointer) {
      pointer = document.createElement("div");
      pointer.id = id;
      pointer.setAttribute("aria-hidden", "true");
      pointer.style.position = "fixed";
      pointer.style.pointerEvents = "none";
      pointer.style.zIndex = "2147483647";
      pointer.style.boxSizing = "border-box";
      pointer.style.display = "flex";
      pointer.style.alignItems = "center";
      pointer.style.justifyContent = "center";
      pointer.style.fontFamily = "monospace";
      pointer.style.fontWeight = "700";
      document.documentElement.append(pointer);
    }

    const x = left - width / 2;
    const y = top - height / 2;
    pointer.style.left = `${x}px`;
    pointer.style.top = `${y}px`;
    pointer.style.width = `${width}px`;
    pointer.style.height = `${height}px`;
    pointer.style.fontSize = `${Math.max(8, height * 0.55)}px`;

    if (!highlighted) {
      pointer.style.background = "transparent";
      pointer.style.border = "0";
      pointer.textContent = "";
      return;
    }

    const target = document.elementFromPoint(left, top);
    const colour = target instanceof Element ? getComputedStyle(target).backgroundColor : "";
    const values = colour.match(/[\d.]+/gu)?.map(Number) ?? [];
    const sameAsBlue = Math.round(values[0] ?? -1) === blue.r
      && Math.round(values[1] ?? -1) === blue.g
      && Math.round(values[2] ?? -1) === blue.b;
    const bg = sameAsBlue ? green : blue;
    pointer.style.background = `rgb(${bg.r} ${bg.g} ${bg.b})`;
    pointer.style.border = `${Math.max(1, Math.min(width, height) * 0.08)}px solid white`;
    pointer.style.color = "white";
    pointer.textContent = "·";
  }, {
    left: point.x,
    top: point.y,
    width: geometry.pointerWidth,
    height: geometry.pointerHeight,
    highlighted: pointerHighlighted(),
    blue: POINTER_BLUE,
    green: POINTER_GREEN,
  });
};

const hoverPointer = async (): Promise<void> => {
  const point = browserPoint();
  await page.mouse.move(point.x, point.y);
};

const movePointer = async (dx: number, dy: number): Promise<void> => {
  const nextX = cursorX + dx;
  const nextY = cursorY + dy;
  if (nextX < 0 || nextX >= geometry.columns || nextY < 0 || nextY >= geometry.rows) {
    await page.mouse.wheel(dx * geometry.pointerWidth, dy * geometry.pointerHeight);
    return;
  }
  cursorX = nextX;
  cursorY = nextY;
  await hoverPointer();
  paintStatus();
};

const followFocus = async (): Promise<void> => {
  const rect = await activeRect(page);
  if (!rect) return;
  cursorX = clamp(Math.floor((rect.x + rect.width / 2) / geometry.pointerWidth), 0, geometry.columns - 1);
  cursorY = clamp(Math.floor((rect.y + rect.height / 2) / geometry.pointerHeight), 0, geometry.rows - 1);
  await hoverPointer();
  paintStatus();
};

const activate = async (): Promise<void> => {
  const point = browserPoint();
  const editable = await editableAt(page, point.x, point.y);
  await page.mouse.click(point.x, point.y);
  inputMode = editable;
  lastStatus = "";
  paintStatus();
};

const pointFromMouse = async (x: number, y: number): Promise<boolean> => {
  if (x < 0 || x >= geometry.columns || y < 0 || y >= geometry.rows) return false;
  cursorX = x;
  cursorY = y;
  await hoverPointer();
  lastStatus = "";
  paintStatus();
  return true;
};

const handleMouse = async (event: TerminalMouseEvent): Promise<void> => {
  if (!(await pointFromMouse(event.x, event.y))) return;

  if (event.kind === "wheel") {
    swipe = undefined;
    const stepX = Math.max(MIN_WHEEL_PIXELS, geometry.pointerWidth * WHEEL_CELL_MULTIPLIER);
    const stepY = Math.max(MIN_WHEEL_PIXELS, geometry.pointerHeight * WHEEL_CELL_MULTIPLIER);
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
      await page.mouse.wheel(-dx * geometry.pointerWidth, -dy * geometry.pointerHeight);
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
  cursorX = clamp(cursorX, 0, geometry.columns - 1);
  cursorY = clamp(cursorY, 0, geometry.rows - 1);
  if (previous.browserWidth !== geometry.browserWidth || previous.browserHeight !== geometry.browserHeight) {
    await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
  }
  process.stdout.write(`${kittyDelete()}\x1b[2J`);
  lastStatus = "";
};

const capture = async (): Promise<void> => {
  try {
    await applyResize();
    await ensurePointerOverlay();
    const screenshot = await page.screenshot({ type: "png" });
    await stdout(kittyFrame(screenshot, geometry));
    paintStatus();
    frame += 1;
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
      lastStatus = "";
      paintStatus();
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

page.on("framenavigated", (frameHandle) => {
  if (frameHandle !== page.mainFrame()) return;
  inputMode = false;
  swipe = undefined;
  auxiliaryButton = undefined;
  cursorX = clamp(cursorX, 0, geometry.columns - 1);
  cursorY = clamp(cursorY, 0, geometry.rows - 1);
  lastStatus = "";
});

const cleanup = async (): Promise<void> => {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${MOUSE_DISABLE}${kittyDelete()}\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l`);
  await browser.close();
};

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
