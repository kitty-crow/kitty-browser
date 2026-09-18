const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

// One packet is exactly 1/96 second. That means:
//   12 fps = 8 packets/frame
//   24 fps = 4 packets/frame
//   48 fps = 2 packets/frame
//   96 fps = 1 packet/frame
// This is the media clock used by the Admin audio path.
const FRAMES_PER_PACKET = 500;
const PACKET_PCM_BYTES = FRAMES_PER_PACKET * CHANNELS * BYTES_PER_SAMPLE;
const HEADER_BYTES = 32;
const MAGIC = 0x3141424b; // "KBA1" little-endian
const FORMAT_PCM16LE = 1;
const CAPTURE_LATENCY_NS = 10_416_667n;

const monotonicNs = (): bigint => process.hrtime.bigint();

const readText = async (stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> => {
  if (stream === null || stream === undefined || typeof stream === "number") return "";
  return await new Response(stream).text();
};

const commandText = async (argv: readonly string[]): Promise<string> => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = readText(proc.stdout);
  const stderrPromise = readText(proc.stderr);
  const code = await proc.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (code !== 0) {
    throw new Error(`${argv[0]} exited ${code}: ${stderr.trim() || stdout.trim() || "unknown error"}`);
  }
  return stdout.trim();
};

const buildPacket = (pcm: Uint8Array, sequence: number, startNs: bigint): Uint8Array => {
  const packet = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint8(4, 1);
  view.setUint8(5, CHANNELS);
  view.setUint8(6, FORMAT_PCM16LE);
  view.setUint8(7, 0);
  view.setUint32(8, SAMPLE_RATE, true);
  view.setUint32(12, FRAMES_PER_PACKET, true);
  view.setUint32(16, sequence >>> 0, true);
  view.setBigUint64(20, startNs, true);
  view.setUint32(28, 0, true);
  packet.set(pcm, HEADER_BYTES);
  return packet;
};

const connect = async (url: string): Promise<WebSocket> => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("audio WebSocket connection timed out")), 5_000);
    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      fn();
    };
    const onOpen = (): void => finish(resolve);
    const onError = (): void => finish(() => reject(new Error("audio WebSocket connection failed")));
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
  return ws;
};

export interface ChromiumAudioStream {
  readonly browserEnv: Readonly<Record<string, string>>;
  readonly packetRate: 96;
  close(): Promise<void>;
}

export const openChromiumAudioStream = async (url: string): Promise<ChromiumAudioStream> => {
  const pactl = Bun.which("pactl");
  const parec = Bun.which("parec");
  if (!pactl || !parec) {
    throw new Error("Chromium audio streaming needs pactl and parec (Debian/Ubuntu package: pulseaudio-utils)");
  }

  // Headless servers often have PulseAudio utilities installed without a
  // running user daemon. Start one on demand when the server binary exists.
  await commandText([pactl, "info"]).catch(async () => {
    const pulseaudio = Bun.which("pulseaudio");
    if (!pulseaudio) {
      throw new Error("PulseAudio is not running; install/start pulseaudio (plus pulseaudio-utils)");
    }
    await commandText([pulseaudio, "--start", "--exit-idle-time=60"]);
    await Bun.sleep(150);
    await commandText([pactl, "info"]);
  });

  const sink = `kitty_browser_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const moduleId = await commandText([
    pactl,
    "load-module",
    "module-null-sink",
    `sink_name=${sink}`,
    `rate=${SAMPLE_RATE}`,
    `channels=${CHANNELS}`,
  ]);
  if (!/^\d+$/u.test(moduleId)) {
    throw new Error(`pactl did not return a module id: ${JSON.stringify(moduleId)}`);
  }

  let ws: WebSocket | null = null;
  let recorder: ReturnType<typeof Bun.spawn> | null = null;
  let pump: Promise<void> | null = null;
  let closed = false;

  try {
    ws = await connect(url);
    recorder = Bun.spawn([
      parec,
      `--device=${sink}.monitor`,
      "--format=s16le",
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      "--latency-msec=10",
    ], {
      stdout: "pipe",
      stderr: "inherit",
    });

    const activeWs = ws;
    const activeRecorder = recorder;
    pump = (async (): Promise<void> => {
      if (typeof activeRecorder.stdout === "number" || activeRecorder.stdout === null) return;
      const reader = activeRecorder.stdout.getReader();
      let pending = new Uint8Array(0);
      let sequence = 0;
      let epochNs: bigint | null = null;

      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          const combined = new Uint8Array(pending.byteLength + value.byteLength);
          combined.set(pending, 0);
          combined.set(value, pending.byteLength);

          let offset = 0;
          while (combined.byteLength - offset >= PACKET_PCM_BYTES) {
            if (epochNs === null) epochNs = monotonicNs() - CAPTURE_LATENCY_NS;
            const pcm = combined.slice(offset, offset + PACKET_PCM_BYTES);
            const startNs = epochNs
              + (BigInt(sequence) * BigInt(FRAMES_PER_PACKET) * 1_000_000_000n) / BigInt(SAMPLE_RATE);
            if (activeWs.readyState === WebSocket.OPEN) {
              activeWs.send(buildPacket(pcm, sequence, startNs));
            }
            sequence = (sequence + 1) >>> 0;
            offset += PACKET_PCM_BYTES;
          }
          pending = combined.slice(offset);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    })();

    return {
      browserEnv: { PULSE_SINK: sink },
      packetRate: 96,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try { ws?.close(1000, "kitty browser audio stopped"); } catch { /* already closed */ }
        try { recorder?.kill(); } catch { /* already exited */ }
        await pump?.catch(() => undefined);
        await commandText([pactl, "unload-module", moduleId]).catch(() => undefined);
      },
    };
  } catch (error) {
    closed = true;
    try { ws?.close(); } catch { /* ignore */ }
    try { recorder?.kill(); } catch { /* ignore */ }
    await commandText([pactl, "unload-module", moduleId]).catch(() => undefined);
    throw error;
  }
};

export const tryOpenChromiumAudioStream = async (url: string | undefined): Promise<ChromiumAudioStream | null> => {
  if (!url) return null;
  try {
    return await openChromiumAudioStream(url);
  } catch (error) {
    process.stderr.write(`\naudio disabled: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
};
