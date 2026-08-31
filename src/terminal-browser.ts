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

interface Cell {
  readonly ch: string;
  readonly fg?: Rgb;
  readonly bg?: Rgb;
}

interface TextCell {
  readonly x: number;
  readonly y: number;
  readonly ch: string;
  readonly fg: Rgb;
}

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface Geometry extends TerminalSize {
  readonly logicalColumns: number;
  readonly logicalRows: number;
  readonly browserWidth: number;
  readonly browserHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
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
const MAX_TEXT_GLYPHS = 30_000;
const MIN_WHEEL_PIXELS = 48;
const WHEEL_CELL_MULTIPLIER = 3;
const INPUT_DRAIN_QUIET_MS = 30;
const INPUT_DRAIN_MAX_MS = 250;

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
  console.log(`OpenAI Pilot Headed terminal-browser prototype

Usage:
  bun run terminal:prototype -- <url> [options]

Options:
  --fps <n>                  Capture rate, integer 1-60; default 1
  --resolution <mode>        native, 800x600, 1024x768, 720p, 1366x768,
                             900p, 1080p, or explicit WIDTHxHEIGHT
  --no-status                Hide the bottom status bar

Controls:
  Mouse move                 Move/hover the logical pointer
  Left click / tap           Activate the page position
  Left drag / touch swipe    Scroll naturally; release does not click after a swipe
  Wheel / two-finger swipe   Scroll vertically or horizontally
  Right / middle click       Forward the corresponding browser button
  Arrow keys                 Move the logical pointer one Braille cell
                             At a terminal edge, pan the high-resolution canvas
                             At a logical canvas edge, scroll Chromium
  Enter                      Activate/click selected page position
  Tab / Shift+Tab            Follow Chromium's native focus order
  PgUp / PgDn                Scroll browser viewport
  Esc                        Leave text-entry mode
  Ctrl+C                     Quit

Fixed resolution modes keep Chromium at that actual pixel viewport and render it as a
logical Braille canvas (2x4 browser pixels per Braille cell). The physical terminal is
only a movable window into that canvas. Touch/trackpad behaviour depends on the client
terminal translating gestures into SGR mouse drag or wheel reports; both forms are handled.`);
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

const eqRgb = (a?: Rgb, b?: Rgb): boolean =>
  (!a && !b) || (!!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b);

const eqCell = (a?: Cell, b?: Cell): boolean =>
  !!a && !!b && a.ch === b.ch && eqRgb(a.fg, b.fg) && eqRgb(a.bg, b.bg);

const ansiFg = (rgb?: Rgb): string => rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m` : "\x1b[39m";
const ansiBg = (rgb?: Rgb): string => rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m` : "\x1b[49m";
const at = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`;
const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

const terminalSize = (showStatus: boolean): TerminalSize => ({
  columns: Math.max(8, process.stdout.columns ?? 120),
  rows: Math.max(4, (process.stdout.rows ?? 40) - (showStatus ? 1 : 0)),
});

const geometryFor = (terminal: TerminalSize, resolution: Resolution): Geometry => {
  const fixed = resolution.width !== undefined && resolution.height !== undefined;
  const browserWidth = fixed ? resolution.width! : terminal.columns * NATIVE_CELL_WIDTH;
  const browserHeight = fixed ? resolution.height! : terminal.rows * NATIVE_CELL_HEIGHT;
  const logicalColumns = fixed ? Math.max(8, Math.round(browserWidth / 2)) : terminal.columns;
  const logicalRows = fixed ? Math.max(4, Math.round(browserHeight / 4)) : terminal.rows;
  return {
    ...terminal,
    logicalColumns,
    logicalRows,
    browserWidth,
    browserHeight,
    cellWidth: browserWidth / logicalColumns,
    cellHeight: browserHeight / logicalRows,
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

const overlayText = (cells: Cell[], textCells: readonly TextCell[], columns: number, rows: number): void => {
  for (const text of textCells) {
    if (text.x < 0 || text.x >= columns || text.y < 0 || text.y >= rows) continue;
    const index = text.y * columns + text.x;
    const base = cells[index];
    if (!base) continue;
    cells[index] = {
      ch: text.ch,
      fg: text.fg,
      ...(base.bg ? { bg: base.bg } : {}),
    };
  }
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

const targetClosed = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Target page, context or browser has been closed")
    || message.includes("Browser has been closed")
    || message.includes("Target closed")
    || message.includes("Page closed");
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

const visibleTextCellsOnce = async (page: Page, geometry: Geometry): Promise<TextCell[]> =>
  page.evaluate(({ columns, rows, cellWidth, cellHeight, glyphLimit }) => {
    interface BrowserRgb { r: number; g: number; b: number }
    interface BrowserGlyph {
      ch: string;
      left: number;
      top: number;
      bottom: number;
      fg: BrowserRgb;
      order: number;
    }
    interface BrowserTextCell { x: number; y: number; ch: string; fg: BrowserRgb }

    const parseColour = (css: string): BrowserRgb => {
      const values = css.match(/[\d.]+/gu)?.map(Number) ?? [];
      return {
        r: Math.max(0, Math.min(255, Math.round(values[0] ?? 255))),
        g: Math.max(0, Math.min(255, Math.round(values[1] ?? 255))),
        b: Math.max(0, Math.min(255, Math.round(values[2] ?? 255))),
      };
    };

    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") <= 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };

    const displayText = (ch: string, transform: string): string => {
      const source = /\s/u.test(ch) ? " " : ch;
      const changed = transform === "uppercase"
        ? source.toLocaleUpperCase()
        : transform === "lowercase"
          ? source.toLocaleLowerCase()
          : source;
      return [...changed][0] ?? "";
    };

    const glyphs: BrowserGlyph[] = [];
    let order = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

    for (let node = walker.nextNode(); node && glyphs.length < glyphLimit; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      const owner = node.parentElement;
      if (!owner || !text || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"].includes(owner.tagName) || !visible(owner)) continue;
      const style = getComputedStyle(owner);
      const fg = parseColour(style.color);
      const segments = [...segmenter.segment(text)];

      for (let i = 0; i < segments.length && glyphs.length < glyphLimit; i += 1) {
        const segment = segments[i]!;
        const start = segment.index;
        const end = segments[i + 1]?.index ?? text.length;
        const ch = displayText(segment.segment, style.textTransform);
        if (!ch || ch === "\n" || ch === "\r" || ch === "\t") continue;
        range.setStart(node, start);
        range.setEnd(node, end);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
        glyphs.push({ ch, left: rect.left, top: rect.top, bottom: rect.bottom, fg, order: order++ });
      }
    }

    const lines = new Map<number, BrowserGlyph[]>();
    for (const glyph of glyphs) {
      const y = Math.floor(((glyph.top + glyph.bottom) / 2) / cellHeight);
      if (y < 0 || y >= rows) continue;
      const line = lines.get(y) ?? [];
      line.push(glyph);
      lines.set(y, line);
    }

    const out = new Map<string, BrowserTextCell>();
    const put = (x: number, y: number, ch: string, fg: BrowserRgb): void => {
      if (x < 0 || x >= columns || y < 0 || y >= rows) return;
      const key = `${x}:${y}`;
      const prior = out.get(key);
      if (prior && prior.ch.trim() && !ch.trim()) return;
      out.set(key, { x, y, ch, fg });
    };

    for (const [y, line] of lines) {
      line.sort((a, b) => a.left - b.left || a.order - b.order);
      let lastX = -1;
      let previousWasSpace = false;
      let lastFg: BrowserRgb | undefined;

      for (const glyph of line) {
        const desiredX = Math.floor(Math.max(0, glyph.left) / cellWidth);
        if (glyph.ch === " ") {
          previousWasSpace = true;
          lastFg = glyph.fg;
          continue;
        }

        let x: number;
        if (lastX < 0) x = desiredX;
        else if (previousWasSpace) {
          x = Math.max(desiredX, lastX + 2);
          const gapFg = lastFg ?? glyph.fg;
          for (let gap = lastX + 1; gap < x && gap < columns; gap += 1) put(gap, y, " ", gapFg);
        } else x = Math.max(desiredX, lastX + 1);

        if (x >= columns) break;
        put(x, y, glyph.ch, glyph.fg);
        lastX = x;
        previousWasSpace = false;
        lastFg = glyph.fg;
      }
    }

    return [...out.values()];
  }, {
    columns: geometry.logicalColumns,
    rows: geometry.logicalRows,
    cellWidth: geometry.cellWidth,
    cellHeight: geometry.cellHeight,
    glyphLimit: MAX_TEXT_GLYPHS,
  });

const visibleTextCells = async (page: Page, geometry: Geometry): Promise<TextCell[]> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await visibleTextCellsOnce(page, geometry);
    } catch (error) {
      if (!navigationRace(error)) throw error;
      if (attempt === 0) {
        await page.waitForLoadState("domcontentloaded", { timeout: 750 }).catch(() => undefined);
        continue;
      }
      return [];
    }
  }
  return [];
};

const args = parse(process.argv.slice(2));
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("terminal-browser requires an interactive TTY");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
let geometry = geometryFor(terminalSize(args.status), args.resolution);
await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

let running = true;
let shuttingDown = false;
let cleanedUp = false;
let inputMode = false;
let cursorX = Math.min(Math.floor(geometry.columns / 2), geometry.logicalColumns - 1);
let cursorY = Math.min(Math.floor(geometry.rows / 2), geometry.logicalRows - 1);
let viewX = 0;
let viewY = 0;
let frame = 0;
let baseCells: Cell[] = [];
let painted: Cell[] = [];
let forceFull = true;
let resizePending = false;
let lastStatus = "";
let swipe: SwipeState | undefined;
let auxiliaryButton: MouseButton | undefined;
let inputQueue: Promise<void> = Promise.resolve();
const mouseDecoder = new TerminalMouseDecoder();

const beginShutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  inputMode = false;
  swipe = undefined;
  auxiliaryButton = undefined;
  // Stop the terminal producing any new SGR mouse reports immediately. Cleanup
  // repeats this after leaving the alternate screen as a defensive reset.
  process.stdout.write(MOUSE_DISABLE);
};

const ensureCursorVisible = (): void => {
  if (cursorX < viewX) viewX = cursorX;
  else if (cursorX >= viewX + geometry.columns) viewX = cursorX - geometry.columns + 1;
  if (cursorY < viewY) viewY = cursorY;
  else if (cursorY >= viewY + geometry.rows) viewY = cursorY - geometry.rows + 1;
  viewX = clamp(viewX, 0, Math.max(0, geometry.logicalColumns - geometry.columns));
  viewY = clamp(viewY, 0, Math.max(0, geometry.logicalRows - geometry.rows));
};

page.on("framenavigated", (frameHandle) => {
  if (frameHandle !== page.mainFrame() || shuttingDown) return;
  inputMode = false;
  swipe = undefined;
  auxiliaryButton = undefined;
  viewX = 0;
  viewY = 0;
  cursorX = Math.min(Math.floor(geometry.columns / 2), geometry.logicalColumns - 1);
  cursorY = Math.min(Math.floor(geometry.rows / 2), geometry.logicalRows - 1);
  forceFull = true;
  painted = [];
  lastStatus = "";
});
page.on("close", beginShutdown);
browser.on("disconnected", beginShutdown);

const pointerHighlighted = (): boolean => Math.floor(Math.max(0, frame - 1) / args.fps) % 2 === 0;

const status = (): string => {
  const mode = inputMode ? "INPUT" : "NAV";
  const resolution = args.resolution.name === "native"
    ? `native ${geometry.browserWidth}x${geometry.browserHeight}`
    : `${args.resolution.name} ${geometry.browserWidth}x${geometry.browserHeight}`;
  const raw = ` ${page.url()}  ${mode}  ${args.fps}fps  ${resolution}  canvas ${geometry.logicalColumns}x${geometry.logicalRows}  view ${viewX},${viewY}  pointer ${cursorX},${cursorY} `;
  return raw.length > geometry.columns ? raw.slice(0, geometry.columns) : raw.padEnd(geometry.columns, " ");
};

const paintStatus = (full = false): void => {
  if (!args.status || shuttingDown) return;
  const value = status();
  if (!full && value === lastStatus) return;
  process.stdout.write(`${at(0, geometry.rows)}\x1b[7m${value}\x1b[0m`);
  lastStatus = value;
};

const displayCell = (terminalX: number, terminalY: number): Cell => {
  const logicalX = viewX + terminalX;
  const logicalY = viewY + terminalY;
  if (logicalX >= geometry.logicalColumns || logicalY >= geometry.logicalRows) return { ch: " " };
  const base = baseCells[logicalY * geometry.logicalColumns + logicalX] ?? { ch: "⠀" };
  return logicalX === cursorX && logicalY === cursorY ? cursorCell(base, pointerHighlighted()) : base;
};

const paint = (full = false): void => {
  if (!baseCells.length || shuttingDown) return;
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

const browserPoint = (logicalX: number, logicalY: number) => ({
  x: (logicalX + 0.5) * geometry.cellWidth,
  y: (logicalY + 0.5) * geometry.cellHeight,
});

const hoverPointer = async (): Promise<void> => {
  if (shuttingDown) return;
  const point = browserPoint(cursorX, cursorY);
  await page.mouse.move(point.x, point.y);
};

const movePointer = async (dx: number, dy: number): Promise<void> => {
  if (shuttingDown) return;
  const nextX = cursorX + dx;
  const nextY = cursorY + dy;

  if (nextX < 0 || nextX >= geometry.logicalColumns || nextY < 0 || nextY >= geometry.logicalRows) {
    await page.mouse.wheel(dx * geometry.cellWidth, dy * geometry.cellHeight);
    return;
  }

  cursorX = nextX;
  cursorY = nextY;
  ensureCursorVisible();
  await hoverPointer();
  paint(false);
};

const followFocus = async (): Promise<void> => {
  if (shuttingDown) return;
  const rect = await activeRect(page);
  if (!rect || shuttingDown) return;
  cursorX = clamp(Math.floor((rect.x + rect.width / 2) / geometry.cellWidth), 0, geometry.logicalColumns - 1);
  cursorY = clamp(Math.floor((rect.y + rect.height / 2) / geometry.cellHeight), 0, geometry.logicalRows - 1);
  ensureCursorVisible();
  await hoverPointer();
  paint(false);
};

const activate = async (): Promise<void> => {
  if (shuttingDown) return;
  const point = browserPoint(cursorX, cursorY);
  const editable = await editableAt(page, point.x, point.y);
  if (shuttingDown) return;
  await page.mouse.click(point.x, point.y);
  inputMode = editable;
  paintStatus(true);
};

const pointFromMouse = async (x: number, y: number): Promise<boolean> => {
  if (shuttingDown || x < 0 || x >= geometry.columns || y < 0 || y >= geometry.rows) return false;
  cursorX = clamp(viewX + x, 0, geometry.logicalColumns - 1);
  cursorY = clamp(viewY + y, 0, geometry.logicalRows - 1);
  await hoverPointer();
  paint(false);
  return true;
};

const handleMouse = async (event: TerminalMouseEvent): Promise<void> => {
  if (shuttingDown || !(await pointFromMouse(event.x, event.y))) return;

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
  if (!resizePending || shuttingDown) return;
  resizePending = false;
  const previous = geometry;
  geometry = geometryFor(terminalSize(args.status), args.resolution);
  const browserChanged = previous.browserWidth !== geometry.browserWidth || previous.browserHeight !== geometry.browserHeight;

  if (args.resolution.name === "native") {
    cursorX = clamp(cursorX, 0, geometry.logicalColumns - 1);
    cursorY = clamp(cursorY, 0, geometry.logicalRows - 1);
  }
  ensureCursorVisible();
  if (browserChanged) await page.setViewportSize({ width: geometry.browserWidth, height: geometry.browserHeight });
  process.stdout.write("\x1b[2J");
  painted = [];
  lastStatus = "";
  forceFull = true;
};

const capture = async (): Promise<void> => {
  if (shuttingDown) return;
  try {
    await applyResize();
    if (shuttingDown) return;
    const screenshot = await page.screenshot({ type: "png" });
    const textCells = await visibleTextCells(page, geometry);
    if (shuttingDown) return;
    const png = PNG.sync.read(screenshot);
    const art = makeArt(
      { width: png.width, height: png.height, data: png.data },
      {
        columns: geometry.logicalColumns,
        dither: "atkinson",
        contrast: 0.9,
        detail: 0.5,
        bias: 0.02,
        invert: false,
        colour: true,
        colourBackground: true,
        fullColour: true,
      },
    );

    baseCells = cellsFromArt(art.text, art.cellColours, geometry.logicalColumns, geometry.logicalRows);
    overlayText(baseCells, textCells, geometry.logicalColumns, geometry.logicalRows);
    frame += 1;
    paint(forceFull);
    forceFull = false;
  } catch (error) {
    if (targetClosed(error)) {
      beginShutdown();
      return;
    }
    if (navigationRace(error)) {
      if (!shuttingDown) await page.waitForLoadState("domcontentloaded", { timeout: 750 }).catch(() => undefined);
      return;
    }
    throw error;
  }
};

const key = async (text: string): Promise<void> => {
  if (text === "\x03") {
    beginShutdown();
    return;
  }
  if (shuttingDown) return;

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

const onStdinData = (chunk: string): void => {
  if (shuttingDown) return;
  for (const input of mouseDecoder.push(chunk)) {
    inputQueue = inputQueue
      .then(async () => {
        if (shuttingDown) return;
        if (input.kind === "mouse") await handleMouse(input.event);
        else await key(input.text);
      })
      .catch((error) => {
        if (shuttingDown || targetClosed(error)) {
          beginShutdown();
          return;
        }
        inputMode = false;
        swipe = undefined;
        auxiliaryButton = undefined;
        lastStatus = "";
        process.stderr.write(`\ninput error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
  }
};

const drainPendingInput = async (): Promise<void> => {
  process.stdin.off("data", onStdinData);
  let lastData = performance.now();
  const discard = (): void => { lastData = performance.now(); };
  process.stdin.on("data", discard);
  process.stdin.resume();
  const started = performance.now();
  while (performance.now() - started < INPUT_DRAIN_MAX_MS) {
    if (performance.now() - lastData >= INPUT_DRAIN_QUIET_MS) break;
    await Bun.sleep(10);
  }
  process.stdin.pause();
  process.stdin.off("data", discard);
};

const cleanup = async (): Promise<void> => {
  if (cleanedUp) return;
  cleanedUp = true;
  beginShutdown();

  // Let any operation that was already in flight finish while the browser still
  // exists. Everything queued behind shutdown becomes a no-op.
  await inputQueue.catch(() => undefined);

  // Mouse reports can already be travelling through the PTY/SSH stream when
  // tracking is disabled. Consume them here so they cannot become shell input.
  await drainPendingInput();

  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  if (browser.isConnected()) await browser.close().catch(() => undefined);

  // Disable tracking on both sides of the alternate-screen transition. Some
  // terminals restore private modes with the primary screen; this guarantees
  // the shell always receives an ordinary TTY.
  process.stdout.write(`${MOUSE_DISABLE}\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l${MOUSE_DISABLE}\x1b[0m\x1b[?7h\x1b[?25h`);
};

process.stdout.write(`\x1b[?1049h\x1b[?25l\x1b[?7l${MOUSE_ENABLE}\x1b[2J`);
process.stdin.setEncoding("utf8");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", onStdinData);
process.stdout.on("resize", () => { if (!shuttingDown) resizePending = true; });

try {
  const interval = 1000 / args.fps;
  while (running) {
    const started = performance.now();
    await capture();
    if (!running) break;
    const remaining = interval - (performance.now() - started);
    if (remaining > 0) await Bun.sleep(remaining);
  }
} finally {
  await cleanup();
}
