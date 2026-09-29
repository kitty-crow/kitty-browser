import type { MouseButton, TerminalMouseEvent } from "./terminal-mouse.ts";

interface ActiveLeftPress {
  readonly startedAtMs: number;
  lastX: number;
  lastY: number;
  moved: boolean;
}

interface PendingClickTiming {
  readonly delayMs: number;
  readonly expiresAtMs: number;
}

const MAX_REPLAY_DELAY_MS = 2_000;
const PENDING_TTL_MS = 1_000;

let activeLeftPress: ActiveLeftPress | null = null;
let pendingClickTiming: PendingClickTiming | null = null;

const leftButton = (button: MouseButton | undefined): boolean =>
  button === undefined || button === "left";

export const noteTerminalPointerEvent = (
  event: TerminalMouseEvent,
  nowMs = performance.now(),
): void => {
  if (event.kind === "press" && leftButton(event.button)) {
    activeLeftPress = {
      startedAtMs: nowMs,
      lastX: event.x,
      lastY: event.y,
      moved: false,
    };
    pendingClickTiming = null;
    return;
  }

  const active = activeLeftPress;
  if (active === null) return;

  if (event.kind === "move") {
    if (event.x !== active.lastX || event.y !== active.lastY) active.moved = true;
    active.lastX = event.x;
    active.lastY = event.y;
    return;
  }

  if (event.kind === "wheel") {
    active.moved = true;
    return;
  }

  if (event.kind !== "release" || !leftButton(event.button)) return;

  activeLeftPress = null;
  if (active.moved) {
    pendingClickTiming = null;
    return;
  }

  const delayMs = Math.max(0, Math.min(MAX_REPLAY_DELAY_MS, Math.round(nowMs - active.startedAtMs)));
  pendingClickTiming = {
    delayMs,
    expiresAtMs: nowMs + PENDING_TTL_MS,
  };
};

export const consumeTerminalClickDelayMs = (nowMs = performance.now()): number | null => {
  const pending = pendingClickTiming;
  pendingClickTiming = null;
  if (pending === null || pending.expiresAtMs < nowMs) return null;
  return pending.delayMs;
};
