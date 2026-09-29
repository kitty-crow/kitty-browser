import { afterEach, describe, expect, test } from "bun:test";
import { browserBackend, consumeBrowserBackendArg } from "../src/browser-backend.ts";

const BACKEND_ENV = "KITTY_BROWSER_BACKEND";
const original = process.env[BACKEND_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[BACKEND_ENV];
  else process.env[BACKEND_ENV] = original;
});

describe("browser backend options", () => {
  test("defaults to Playwright", () => {
    delete process.env[BACKEND_ENV];
    expect(browserBackend()).toBe("playwright");
  });

  test("consumes native backend argument and persists it for Xvfb re-exec", () => {
    delete process.env[BACKEND_ENV];
    const argv = ["bun", "src/cli.ts", "https://example.com", "--backend", "native", "--fps", "24"];
    expect(consumeBrowserBackendArg(argv)).toBe("native");
    expect(argv).toEqual(["bun", "src/cli.ts", "https://example.com", "--fps", "24"]);
    expect(browserBackend()).toBe("native");
  });

  test("accepts equals form", () => {
    delete process.env[BACKEND_ENV];
    const argv = ["bun", "src/cli.ts", "--backend=playwright", "https://example.com"];
    expect(consumeBrowserBackendArg(argv)).toBe("playwright");
    expect(argv).toEqual(["bun", "src/cli.ts", "https://example.com"]);
  });

  test("rejects unknown backends", () => {
    const argv = ["bun", "src/cli.ts", "--backend", "stealth", "https://example.com"];
    expect(() => consumeBrowserBackendArg(argv)).toThrow("expected playwright or native");
  });
});
