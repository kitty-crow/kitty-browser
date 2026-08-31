import type { Page } from "playwright";
import { safeGoBack, setTerminalUrlEditing } from "./browser-shortcuts.ts";

const CONTROLS = " [<] [R] ";
const BACK_START = 1;
const BACK_END = 4;
const REFRESH_START = 5;
const REFRESH_END = 8;
const MIN_URL_WIDTH = 12;

interface Layout {
  readonly text: string;
  readonly urlStart: number;
  readonly urlEnd: number;
  readonly urlViewStart: number;
}

const normaliseUrl = (raw: string): string => {
  const value = raw.trim();
  if (!value) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return value;
  return `https://${value}`;
};

const printable = (text: string): boolean =>
  !text.startsWith("\x1b") && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text);

export class TerminalNavigationBar {
  readonly #page: Page;
  #editing = false;
  #value = "";
  #cursor = 0;
  #viewStart = 0;

  constructor(page: Page) {
    this.#page = page;
  }

  get editing(): boolean {
    return this.#editing;
  }

  cancel(): void {
    this.#editing = false;
    this.#value = "";
    this.#cursor = 0;
    this.#viewStart = 0;
    setTerminalUrlEditing(false);
  }

  #layout(columns: number, metadata: string): Layout {
    const safeColumns = Math.max(CONTROLS.length + 1, columns);
    const rawSuffix = metadata ? `  ${metadata} ` : "";
    const maxSuffix = Math.max(0, safeColumns - CONTROLS.length - MIN_URL_WIDTH);
    const suffix = rawSuffix.slice(0, maxSuffix);
    const urlWidth = Math.max(1, safeColumns - CONTROLS.length - suffix.length);
    const source = this.#editing ? this.#value : this.#page.url();

    if (this.#editing) {
      if (this.#cursor < this.#viewStart) this.#viewStart = this.#cursor;
      if (this.#cursor >= this.#viewStart + urlWidth) this.#viewStart = this.#cursor - urlWidth + 1;
      this.#viewStart = Math.max(0, Math.min(this.#viewStart, Math.max(0, source.length - urlWidth + 1)));
    } else {
      this.#viewStart = 0;
    }

    let visible: string;
    if (this.#editing) {
      const relativeCursor = this.#cursor - this.#viewStart;
      const beforeWidth = Math.max(0, Math.min(urlWidth - 1, relativeCursor));
      const before = source.slice(this.#viewStart, this.#viewStart + beforeWidth);
      const afterStart = this.#viewStart + beforeWidth;
      const after = source.slice(afterStart, afterStart + Math.max(0, urlWidth - before.length - 1));
      visible = `${before}▏${after}`;
    } else {
      visible = source.slice(0, urlWidth);
    }

    visible = visible.padEnd(urlWidth, " ");
    const text = `${CONTROLS}${visible}${suffix}`.slice(0, safeColumns).padEnd(safeColumns, " ");
    return {
      text,
      urlStart: CONTROLS.length,
      urlEnd: CONTROLS.length + urlWidth,
      urlViewStart: this.#viewStart,
    };
  }

  render(columns: number, metadata = ""): string {
    return this.#layout(columns, metadata).text;
  }

  async click(x: number, columns: number, metadata = ""): Promise<boolean> {
    const layout = this.#layout(columns, metadata);

    if (x >= BACK_START && x < BACK_END) {
      this.cancel();
      await safeGoBack(this.#page);
      return true;
    }

    if (x >= REFRESH_START && x < REFRESH_END) {
      this.cancel();
      await this.#page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      return true;
    }

    if (x >= layout.urlStart && x < layout.urlEnd) {
      if (!this.#editing) {
        this.#editing = true;
        this.#value = this.#page.url();
        this.#viewStart = 0;
        setTerminalUrlEditing(true);
      }
      const relative = x - layout.urlStart;
      this.#cursor = Math.min(this.#value.length, layout.urlViewStart + relative);
      return true;
    }

    return false;
  }

  async handleKey(text: string): Promise<boolean> {
    if (!this.#editing) return false;

    if (text === "\x1b") {
      this.cancel();
      return true;
    }

    if (text === "\r") {
      const target = normaliseUrl(this.#value);
      this.cancel();
      await this.#page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
      return true;
    }

    if (text === "\x7f") {
      if (this.#cursor > 0) {
        this.#value = `${this.#value.slice(0, this.#cursor - 1)}${this.#value.slice(this.#cursor)}`;
        this.#cursor -= 1;
      }
      return true;
    }

    if (text === "\x1b[3~") {
      if (this.#cursor < this.#value.length) {
        this.#value = `${this.#value.slice(0, this.#cursor)}${this.#value.slice(this.#cursor + 1)}`;
      }
      return true;
    }

    if (text === "\x1b[D") {
      this.#cursor = Math.max(0, this.#cursor - 1);
      return true;
    }

    if (text === "\x1b[C") {
      this.#cursor = Math.min(this.#value.length, this.#cursor + 1);
      return true;
    }

    if (text === "\x1b[H" || text === "\x1b[1~") {
      this.#cursor = 0;
      return true;
    }

    if (text === "\x1b[F" || text === "\x1b[4~") {
      this.#cursor = this.#value.length;
      return true;
    }

    if (text === "\x15") {
      this.#value = "";
      this.#cursor = 0;
      this.#viewStart = 0;
      return true;
    }

    if (printable(text)) {
      this.#value = `${this.#value.slice(0, this.#cursor)}${text}${this.#value.slice(this.#cursor)}`;
      this.#cursor += [...text].length;
      return true;
    }

    return true;
  }
}
