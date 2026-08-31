#!/usr/bin/env bun

interface ProbeResult {
  readonly raw: string;
  readonly sixel: boolean | undefined;
  readonly da1?: string;
  readonly cellPixels?: { width: number; height: number };
  readonly windowPixels?: { width: number; height: number };
  readonly textCells?: { columns: number; rows: number };
}

const TIMEOUT_MS = 900;
const stdin = process.stdin;

if (!stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("terminal:capabilities requires an interactive TTY");
}

const chunks: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let onData: ((chunk: Buffer | string) => void) | undefined;

const restore = (): void => {
  if (timer) clearTimeout(timer);
  if (onData) stdin.off("data", onData);
  stdin.setRawMode(false);
  stdin.pause();
};

const parse = (raw: string): ProbeResult => {
  const da = raw.match(/\x1b\[\?([0-9;]+)c/u);
  const daParams = da?.[1]?.split(";").map((value) => Number.parseInt(value, 10)) ?? [];
  const sixel = da ? daParams.includes(4) : undefined;

  const cell = raw.match(/\x1b\[6;(\d+);(\d+)t/u);
  const win = raw.match(/\x1b\[4;(\d+);(\d+)t/u);
  const text = raw.match(/\x1b\[8;(\d+);(\d+)t/u);

  return {
    raw,
    sixel,
    ...(da ? { da1: da[0] } : {}),
    ...(cell ? { cellPixels: { height: Number(cell[1]), width: Number(cell[2]) } } : {}),
    ...(win ? { windowPixels: { height: Number(win[1]), width: Number(win[2]) } } : {}),
    ...(text ? { textCells: { rows: Number(text[1]), columns: Number(text[2]) } } : {}),
  };
};

const result = await new Promise<ProbeResult>((resolve) => {
  let settled = false;

  const finish = (): void => {
    if (settled) return;
    settled = true;
    const parsed = parse(chunks.join(""));
    restore();
    resolve(parsed);
  };

  onData = (chunk: Buffer | string): void => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const raw = chunks.join("");
    const hasDa = /\x1b\[\?[0-9;]+c/u.test(raw);
    const hasCell = /\x1b\[6;\d+;\d+t/u.test(raw);
    const hasWin = /\x1b\[4;\d+;\d+t/u.test(raw);
    const hasText = /\x1b\[8;\d+;\d+t/u.test(raw);
    if (hasDa && hasCell && hasWin && hasText) finish();
  };

  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);

  // DA1: standard terminal capabilities. A parameter 4 advertises Sixel.
  // CSI 16/14/18 t: cell pixel size, window pixel size, and text-grid size.
  process.stdout.write("\x1b[c\x1b[16t\x1b[14t\x1b[18t");
  timer = setTimeout(finish, TIMEOUT_MS);
});

const esc = (value: string | undefined): string => value
  ? value.replaceAll("\x1b", "<ESC>")
  : "(no response)";

console.log(`TERM=${process.env.TERM ?? "(unset)"}`);
console.log(`DA1=${esc(result.da1)}`);
console.log(`Sixel=${result.sixel === true ? "yes" : result.sixel === false ? "no" : "unknown"}`);
console.log(`Cell pixels=${result.cellPixels ? `${result.cellPixels.width}x${result.cellPixels.height}` : "unknown"}`);
console.log(`Window pixels=${result.windowPixels ? `${result.windowPixels.width}x${result.windowPixels.height}` : "unknown"}`);
console.log(`Text grid=${result.textCells ? `${result.textCells.columns}x${result.textCells.rows}` : `${process.stdout.columns ?? "?"}x${process.stdout.rows ?? "?"} (local TTY report)`}`);
