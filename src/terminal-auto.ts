#!/usr/bin/env bun

interface ProbeResult {
  readonly kitty: boolean;
  readonly sixel: boolean;
  readonly da1?: string;
}

const KITTY_QUERY_ID = 31;
const KITTY_QUERY = `\x1b_Gi=${KITTY_QUERY_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`;
const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const PROBE_TIMEOUT_MS = 750;

const probeTerminal = async (): Promise<ProbeResult> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return { kitty: false, sixel: false };

  const stdin = process.stdin;
  const chunks: string[] = [];
  const wasRaw = stdin.isRaw;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attached = false;
  let onData: ((chunk: Buffer | string) => void) | undefined;

  const restore = (): void => {
    if (timer) clearTimeout(timer);
    if (attached && onData) stdin.off("data", onData);
    if (!wasRaw) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\r\x1b[2K");
  };

  return await new Promise<ProbeResult>((resolve) => {
    let settled = false;

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      restore();
      resolve(result);
    };

    const inspect = (): void => {
      const received = chunks.join("");
      const kitty = new RegExp(`\\x1b_Gi=${KITTY_QUERY_ID};(?:OK)?`, "u").test(received);
      const da1Match = received.match(/\x1b\[\?([0-9;]*)c/u);
      const da1 = da1Match?.[0];
      const params = da1Match?.[1]?.split(";").filter(Boolean).map(Number) ?? [];
      const sixel = params.includes(4);

      if (kitty) {
        finish({ kitty: true, sixel, ...(da1 ? { da1 } : {}) });
        return;
      }

      if (da1Match) finish({ kitty: false, sixel, ...(da1 ? { da1 } : {}) });
    };

    onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      inspect();
    };

    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    attached = true;

    process.stdout.write(`${KITTY_QUERY}${DEVICE_ATTRIBUTES_QUERY}`);
    timer = setTimeout(() => finish({ kitty: false, sixel: false }), PROBE_TIMEOUT_MS);
  });
};

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("terminal:auto requires an interactive TTY");
}

const probe = await probeTerminal();

if (probe.kitty) {
  process.env.OPENAI_PILOT_RENDERER = "kitty";
  process.env.OPENAI_PILOT_FORCE_KITTY = "1";
  await import("./kitty-terminal-browser-guard.ts");
} else if (probe.sixel) {
  process.env.OPENAI_PILOT_RENDERER = "sixel";
  process.env.KITTY_BROWSER_FORCE_SIXEL = "1";
  await import("./sixel-terminal-browser-guard.ts");
} else {
  process.env.OPENAI_PILOT_RENDERER = "braille";
  await import("./terminal-browser.ts");
}
