const TRACKPAD_OSC = '\x1b]778;';
const TRACKPAD_END = '\x07';
const TRACKPAD_READY = '\x1b]778;ready\x07';
const MAX_MOVE_DELTA = 4096;
const MAX_SCROLL_STEPS = 64;

type TrackpadButton = 1 | 2 | 3;

type TrackpadEvent =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'scroll'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'click' | 'down' | 'up'; readonly button: TrackpadButton }
  | { readonly kind: 'reset' };

type DecodedInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'trackpad'; readonly event: TrackpadEvent };

type PointerState = {
  readonly windowId: string;
  readonly width: number;
  readonly height: number;
  x: number;
  y: number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const integer = (value: string, limit: number): number | null => {
  if (!/^-?\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  return clamp(parsed, -limit, limit);
};

const button = (value: string): TrackpadButton | null => {
  const parsed = Number.parseInt(value, 10);
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : null;
};

const parseTrackpadEvent = (payload: string): TrackpadEvent | null => {
  const parts = payload.split(';');
  const action = parts[0];

  if (action === 'reset' && parts.length === 1) return { kind: 'reset' };

  if ((action === 'move' || action === 'scroll') && parts.length === 3) {
    const dx = integer(parts[1]!, action === 'move' ? MAX_MOVE_DELTA : MAX_SCROLL_STEPS);
    const dy = integer(parts[2]!, action === 'move' ? MAX_MOVE_DELTA : MAX_SCROLL_STEPS);
    if (dx === null || dy === null) return null;
    return { kind: action, dx, dy };
  }

  if ((action === 'click' || action === 'down' || action === 'up') && parts.length === 2) {
    const parsedButton = button(parts[1]!);
    if (parsedButton === null) return null;
    return { kind: action, button: parsedButton };
  }

  return null;
};

class TrackpadDecoder {
  #pending = '';

  push(chunk: string): DecodedInput[] {
    this.#pending += chunk;
    const out: DecodedInput[] = [];

    while (this.#pending.length > 0) {
      const start = this.#pending.indexOf(TRACKPAD_OSC);
      if (start < 0) {
        let hold = 0;
        const max = Math.min(TRACKPAD_OSC.length - 1, this.#pending.length);
        for (let length = max; length > 0; length -= 1) {
          if (TRACKPAD_OSC.startsWith(this.#pending.slice(-length))) {
            hold = length;
            break;
          }
        }
        const emit = this.#pending.length - hold;
        if (emit > 0) out.push({ kind: 'text', text: this.#pending.slice(0, emit) });
        this.#pending = this.#pending.slice(emit);
        break;
      }

      if (start > 0) {
        out.push({ kind: 'text', text: this.#pending.slice(0, start) });
        this.#pending = this.#pending.slice(start);
        continue;
      }

      const end = this.#pending.indexOf(TRACKPAD_END, TRACKPAD_OSC.length);
      if (end < 0) {
        if (this.#pending.length <= 256) break;
        out.push({ kind: 'text', text: this.#pending[0]! });
        this.#pending = this.#pending.slice(1);
        continue;
      }

      const payload = this.#pending.slice(TRACKPAD_OSC.length, end);
      const event = parseTrackpadEvent(payload);
      if (event !== null) out.push({ kind: 'trackpad', event });
      this.#pending = this.#pending.slice(end + TRACKPAD_END.length);
    }

    return out;
  }
}

const streamText = async (stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> => {
  if (stream === null || stream === undefined || typeof stream === 'number') return '';
  return await new Response(stream).text();
};

const runText = async (argv: readonly string[]): Promise<string> => {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'ignore' });
  const output = await streamText(proc.stdout);
  return await proc.exited === 0 ? output.trim() : '';
};

const runQuiet = async (argv: readonly string[]): Promise<void> => {
  const proc = Bun.spawn([...argv], { stdout: 'ignore', stderr: 'ignore' });
  await proc.exited;
};

const parseShell = (text: string): Map<string, number> => {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z]+)=(-?\d+)$/u);
    if (match === null) continue;
    values.set(match[1]!, Number.parseInt(match[2]!, 10));
  }
  return values;
};

const xdotool = Bun.which('xdotool');
if (xdotool === null) throw new Error('native trackpad mode requires xdotool');

let pointer: PointerState | null = null;
let commandQueue: Promise<void> = Promise.resolve();

const initialisePointer = async (): Promise<PointerState | null> => {
  const windowId = await runText([xdotool, 'getactivewindow']);
  if (!/^\d+$/u.test(windowId)) return null;

  const geometry = parseShell(await runText([xdotool, 'getwindowgeometry', '--shell', windowId]));
  const mouse = parseShell(await runText([xdotool, 'getmouselocation', '--shell']));
  const windowX = geometry.get('X');
  const windowY = geometry.get('Y');
  const width = geometry.get('WIDTH');
  const height = geometry.get('HEIGHT');
  const mouseX = mouse.get('X');
  const mouseY = mouse.get('Y');
  if (windowX === undefined || windowY === undefined || width === undefined || height === undefined
    || mouseX === undefined || mouseY === undefined || width <= 0 || height <= 0) return null;

  pointer = {
    windowId,
    width,
    height,
    x: clamp(mouseX - windowX, 0, width - 1),
    y: clamp(mouseY - windowY, 0, height - 1),
  };
  return pointer;
};

const pointerState = async (): Promise<PointerState | null> => pointer ?? await initialisePointer();

const movePointer = async (dx: number, dy: number): Promise<void> => {
  if (dx === 0 && dy === 0) return;
  const state = await pointerState();
  if (state === null) return;
  state.x = clamp(state.x + dx, 0, state.width - 1);
  state.y = clamp(state.y + dy, 0, state.height - 1);
  await runQuiet([xdotool, 'mousemove', '--window', state.windowId, String(state.x), String(state.y)]);
};

const clickButton = async (mouseButton: TrackpadButton): Promise<void> => {
  await runQuiet([xdotool, 'click', String(mouseButton)]);
};

const changeButton = async (action: 'mousedown' | 'mouseup', mouseButton: TrackpadButton): Promise<void> => {
  await runQuiet([xdotool, action, String(mouseButton)]);
};

const scroll = async (dx: number, dy: number): Promise<void> => {
  if (dy !== 0) {
    await runQuiet([
      xdotool,
      'click',
      '--repeat', String(Math.abs(dy)),
      '--delay', '0',
      String(dy < 0 ? 4 : 5),
    ]);
  }
  if (dx !== 0) {
    await runQuiet([
      xdotool,
      'click',
      '--repeat', String(Math.abs(dx)),
      '--delay', '0',
      String(dx < 0 ? 6 : 7),
    ]);
  }
};

const handleTrackpad = async (event: TrackpadEvent): Promise<void> => {
  if (event.kind === 'reset') {
    pointer = null;
    return;
  }
  if (event.kind === 'move') {
    await movePointer(event.dx, event.dy);
    return;
  }
  if (event.kind === 'scroll') {
    await scroll(event.dx, event.dy);
    return;
  }
  if (event.kind === 'click') {
    await clickButton(event.button);
    return;
  }
  await changeButton(event.kind === 'down' ? 'mousedown' : 'mouseup', event.button);
};

const decoder = new TrackpadDecoder();
const stdin = process.stdin;
const originalOn = stdin.on;
let interceptedDataListener = false;

Object.defineProperty(stdin, 'on', {
  configurable: true,
  writable: true,
  value(eventName: string | symbol, listener: (...args: unknown[]) => void): NodeJS.ReadStream {
    if (eventName !== 'data' || interceptedDataListener) {
      return Reflect.apply(originalOn, this, [eventName, listener]) as NodeJS.ReadStream;
    }

    interceptedDataListener = true;
    Object.defineProperty(stdin, 'on', {
      configurable: true,
      writable: true,
      value: originalOn,
    });

    const dataListener = listener as unknown as (chunk: Buffer | string) => void;
    const wrapped = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const decoded of decoder.push(text)) {
        if (decoded.kind === 'text') {
          if (decoded.text.length > 0) dataListener(decoded.text);
          continue;
        }
        commandQueue = commandQueue.then(() => handleTrackpad(decoded.event)).catch(() => undefined);
      }
    };

    return Reflect.apply(originalOn, this, ['data', wrapped]) as NodeJS.ReadStream;
  },
});

process.on('SIGWINCH', () => { pointer = null; });
process.stdout.write(TRACKPAD_READY);

await import('./native-kitty-terminal-browser.ts');
