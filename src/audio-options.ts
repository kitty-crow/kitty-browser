const AUDIO_WS_ENV = "KITTY_BROWSER_AUDIO_WS";

const validateAudioUrl = (raw: string): string => {
  const value = raw.trim();
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("--audio-ws must use ws:// or wss://");
  }
  return url.toString();
};

export const consumeAudioWebSocketArg = (argv = process.argv): string | undefined => {
  let value = process.env[AUDIO_WS_ENV]?.trim() || undefined;
  let disabled = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-audio") {
      disabled = true;
      argv.splice(i, 1);
      i -= 1;
      continue;
    }

    let candidate: string | undefined;
    let remove = 0;
    if (arg === "--audio-ws") {
      candidate = argv[i + 1];
      if (!candidate) throw new Error("--audio-ws requires a ws:// or wss:// URL");
      remove = 2;
    } else if (arg.startsWith("--audio-ws=")) {
      candidate = arg.slice("--audio-ws=".length);
      if (!candidate) throw new Error("--audio-ws requires a ws:// or wss:// URL");
      remove = 1;
    }

    if (candidate !== undefined) {
      value = validateAudioUrl(candidate);
      disabled = false;
      argv.splice(i, remove);
      i -= 1;
    }
  }

  if (disabled) {
    delete process.env[AUDIO_WS_ENV];
    return undefined;
  }

  if (!value) return undefined;
  value = validateAudioUrl(value);
  process.env[AUDIO_WS_ENV] = value;
  return value;
};
