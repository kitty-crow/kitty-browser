#!/usr/bin/env bun

const originalFetch = globalThis.fetch.bind(globalThis);
const UPDATE_INTERVAL_MS = 250;
const NON_TTY_INTERVAL_MS = 5_000;
const MIB = 1024 * 1024;

const formatBytes = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
};

const archiveLabel = (input: RequestInfo | URL): string => {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const pathname = new URL(raw).pathname;
    return pathname.split("/").filter(Boolean).at(-1) ?? "Chromium";
  } catch {
    return "Chromium";
  }
};

const isChromiumDownload = (input: RequestInfo | URL): boolean => {
  const raw = input instanceof Request ? input.url : String(input);
  return /\/builds\/chromium\/\d+\/chromium-[^/]+\.zip(?:\?|$)/u.test(raw);
};

const makeProgressBody = (
  body: ReadableStream<Uint8Array>,
  total: number | undefined,
  label: string,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  const started = performance.now();
  const tty = Boolean(process.stderr.isTTY);
  let downloaded = 0;
  let lastRendered = 0;
  let lastNonTtyRendered = 0;
  let finished = false;

  const render = (force = false): void => {
    const now = performance.now();
    const elapsedSeconds = Math.max((now - started) / 1000, 0.001);
    const speed = downloaded / elapsedSeconds;

    if (!force) {
      const interval = tty ? UPDATE_INTERVAL_MS : NON_TTY_INTERVAL_MS;
      const previous = tty ? lastRendered : lastNonTtyRendered;
      if (now - previous < interval) return;
      if (tty) lastRendered = now;
      else lastNonTtyRendered = now;
    }

    let status: string;
    if (total && total > 0) {
      const fraction = Math.min(1, downloaded / total);
      const percentage = fraction * 100;
      const terminalColumns = process.stderr.columns ?? 100;
      const barWidth = Math.max(10, Math.min(30, terminalColumns - 78));
      const filled = Math.min(barWidth, Math.round(fraction * barWidth));
      const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
      const eta = speed > 0 ? (total - downloaded) / speed : Number.NaN;
      status = `${label} [${bar}] ${percentage.toFixed(1).padStart(5)}%  ${formatBytes(downloaded)} / ${formatBytes(total)}  ${(speed / MIB).toFixed(1)} MiB/s  ETA ${formatDuration(eta)}`;
    } else {
      status = `${label} ${formatBytes(downloaded)}  ${(speed / MIB).toFixed(1)} MiB/s  elapsed ${formatDuration(elapsedSeconds)}`;
    }

    if (tty) {
      process.stderr.write(`\r\x1b[2K    ${status}${force ? "\n" : ""}`);
    } else {
      process.stderr.write(`    ${status}\n`);
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (!finished) {
            finished = true;
            render(true);
          }
          controller.close();
          return;
        }

        downloaded += value.byteLength;
        render(false);
        controller.enqueue(value);
      } catch (error) {
        if (tty) process.stderr.write("\r\x1b[2K");
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (tty) process.stderr.write("\r\x1b[2K");
      await reader.cancel(reason);
    },
  });
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await originalFetch(input, init);
  if (!response.ok || !response.body || !isChromiumDownload(input)) return response;

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
  const body = makeProgressBody(response.body, total, archiveLabel(input));

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}) as typeof fetch;

await import("./release.ts");
