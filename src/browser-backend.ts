export type BrowserBackend = "playwright" | "native";

const BACKEND_ENV = "KITTY_BROWSER_BACKEND";
const BACKENDS = new Set<BrowserBackend>(["playwright", "native"]);

export const browserBackend = (): BrowserBackend => {
  const raw = process.env[BACKEND_ENV]?.trim().toLowerCase();
  return raw === "native" ? "native" : "playwright";
};

export const consumeBrowserBackendArg = (argv = process.argv): BrowserBackend => {
  let backend = browserBackend();

  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i]!;
    let candidate: string | undefined;
    let remove = 0;

    if (value === "--backend") {
      candidate = argv[i + 1];
      if (!candidate) throw new Error("--backend requires one of: playwright, native");
      remove = 2;
    } else if (value.startsWith("--backend=")) {
      candidate = value.slice("--backend=".length);
      if (!candidate) throw new Error("--backend requires one of: playwright, native");
      remove = 1;
    }

    if (candidate === undefined) continue;
    const normalised = candidate.toLowerCase() as BrowserBackend;
    if (!BACKENDS.has(normalised)) {
      throw new Error(`unknown browser backend ${JSON.stringify(candidate)}; expected playwright or native`);
    }
    backend = normalised;
    argv.splice(i, remove);
    i -= 1;
  }

  process.env[BACKEND_ENV] = backend;
  return backend;
};
