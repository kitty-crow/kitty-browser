export type MouseButton = "left" | "middle" | "right";

export interface MouseModifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
}

export interface MousePointEvent extends MouseModifiers {
  readonly kind: "press" | "release" | "move";
  readonly x: number;
  readonly y: number;
  readonly button?: MouseButton;
}

export interface MouseWheelEvent extends MouseModifiers {
  readonly kind: "wheel";
  readonly x: number;
  readonly y: number;
  readonly dx: -1 | 0 | 1;
  readonly dy: -1 | 0 | 1;
}

export type TerminalMouseEvent = MousePointEvent | MouseWheelEvent;

export type TerminalInputEvent =
  | { readonly kind: "mouse"; readonly event: TerminalMouseEvent }
  | { readonly kind: "text"; readonly text: string };

export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

const MOUSE_PREFIX = "\x1b[<";
const MOUSE_SEQUENCE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/u;
const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];

const decodeMouse = (rawButton: number, rawX: number, rawY: number, suffix: string): TerminalMouseEvent => {
  const shift = (rawButton & 4) !== 0;
  const alt = (rawButton & 8) !== 0;
  const ctrl = (rawButton & 16) !== 0;
  const motion = (rawButton & 32) !== 0;
  const wheel = (rawButton & 64) !== 0;
  const buttonCode = rawButton & 3;
  const x = Math.max(0, rawX - 1);
  const y = Math.max(0, rawY - 1);

  if (wheel) {
    return {
      kind: "wheel",
      x,
      y,
      dx: buttonCode === 2 ? -1 : buttonCode === 3 ? 1 : 0,
      dy: buttonCode === 0 ? -1 : buttonCode === 1 ? 1 : 0,
      shift,
      alt,
      ctrl,
    };
  }

  const button = BUTTONS[buttonCode];
  if (motion) return { kind: "move", x, y, ...(button ? { button } : {}), shift, alt, ctrl };
  if (suffix === "m" || buttonCode === 3) {
    return { kind: "release", x, y, ...(button ? { button } : {}), shift, alt, ctrl };
  }
  return { kind: "press", x, y, ...(button ? { button } : {}), shift, alt, ctrl };
};

export class TerminalMouseDecoder {
  #pending = "";

  push(chunk: string): TerminalInputEvent[] {
    this.#pending += chunk;
    const out: TerminalInputEvent[] = [];

    while (this.#pending) {
      const start = this.#pending.indexOf(MOUSE_PREFIX);
      if (start < 0) {
        out.push({ kind: "text", text: this.#pending });
        this.#pending = "";
        break;
      }

      if (start > 0) {
        out.push({ kind: "text", text: this.#pending.slice(0, start) });
        this.#pending = this.#pending.slice(start);
        continue;
      }

      const match = MOUSE_SEQUENCE.exec(this.#pending);
      if (!match) {
        // Mouse reports normally arrive as one terminal write. Retain only a
        // plausible split SGR mouse sequence; malformed input falls back to
        // the ordinary keyboard path rather than trapping Esc forever.
        if (/^\x1b\[<[0-9;]*$/u.test(this.#pending)) break;
        out.push({ kind: "text", text: this.#pending[0]! });
        this.#pending = this.#pending.slice(1);
        continue;
      }

      const [sequence, button, x, y, suffix] = match;
      out.push({
        kind: "mouse",
        event: decodeMouse(
          Number.parseInt(button!, 10),
          Number.parseInt(x!, 10),
          Number.parseInt(y!, 10),
          suffix!,
        ),
      });
      this.#pending = this.#pending.slice(sequence.length);
    }

    return out;
  }
}
