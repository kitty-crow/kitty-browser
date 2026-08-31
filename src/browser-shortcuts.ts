import type { Page } from "playwright";
import { browserHomeUrl } from "./navigation-policy.ts";

const CTRL_H = "\x08";
const BACKSPACE = "\x7f";

let urlEditing = false;
let shortcutsActive = false;
let activePage: Page | undefined;
let removeInputListener: (() => void) | undefined;
let shortcutQueue: Promise<void> = Promise.resolve();

export const setTerminalUrlEditing = (editing: boolean): void => {
  urlEditing = editing;
};

export const filterTerminalShortcutInput = (chunk: string): string => {
  if (!shortcutsActive) return chunk;
  let out = "";
  for (const ch of chunk) {
    if (ch === CTRL_H) continue;
    if (ch === BACKSPACE && !urlEditing) continue;
    out += ch;
  }
  return out;
};

const focusedElementIsEditable = async (page: Page): Promise<boolean> => {
  try {
    return await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
      if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
      return ["text", "password", "email", "search", "tel", "url", "number"].includes(el.type);
    });
  } catch {
    return false;
  }
};

const goBackOrEdit = async (page: Page): Promise<void> => {
  if (await focusedElementIsEditable(page)) {
    await page.keyboard.press("Backspace").catch(() => undefined);
    return;
  }
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
};

const goHome = async (page: Page): Promise<void> => {
  const home = browserHomeUrl();
  if (!home || home === "about:blank") return;
  await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
};

export const installBrowserShortcuts = (page: Page): (() => void) => {
  removeInputListener?.();
  activePage = page;
  shortcutsActive = true;

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const ch of text) {
      if (ch === CTRL_H) {
        shortcutQueue = shortcutQueue.then(async () => {
          if (activePage !== page || page.isClosed()) return;
          await goHome(page);
        });
        continue;
      }
      if (ch === BACKSPACE && !urlEditing) {
        shortcutQueue = shortcutQueue.then(async () => {
          if (activePage !== page || page.isClosed()) return;
          await goBackOrEdit(page);
        });
      }
    }
  };

  process.stdin.prependListener("data", onData);

  const cleanup = (): void => {
    process.stdin.off("data", onData);
    if (activePage === page) activePage = undefined;
    shortcutsActive = false;
    urlEditing = false;
  };
  removeInputListener = cleanup;
  return cleanup;
};
