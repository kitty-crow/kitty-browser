const SESSION_ENV = "KITTY_BROWSER_SESSION";
const DEFAULT_SESSION = "default";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const browserSessionId = (): string => process.env[SESSION_ENV]?.trim() || DEFAULT_SESSION;

export const consumeBrowserSessionArg = (argv = process.argv): string => {
  let session = browserSessionId();

  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i]!;
    if (value === "--session") {
      const candidate = argv[i + 1];
      if (!candidate) throw new Error("--session requires an id");
      session = candidate;
      argv.splice(i, 2);
      i -= 1;
      continue;
    }
    if (value.startsWith("--session=")) {
      session = value.slice("--session=".length);
      argv.splice(i, 1);
      i -= 1;
    }
  }

  if (!SESSION_ID.test(session)) {
    throw new Error("--session id must be 1-64 characters using letters, numbers, '.', '_' or '-', and must start with a letter or number");
  }

  process.env[SESSION_ENV] = session;
  return session;
};
