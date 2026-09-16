import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

const CHROMIUM_ENV = "KITTY_BROWSER_CHROMIUM_EXECUTABLE";

const platformRelativeExecutable = (): string[] | undefined => {
  switch (process.platform) {
    case "linux":
      return process.arch === "arm64"
        ? ["chromium", "chrome-linux-arm64", "chrome"]
        : ["chromium", "chrome-linux64", "chrome"];
    case "darwin":
      return process.arch === "arm64"
        ? ["chromium", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]
        : ["chromium", "chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"];
    case "win32":
      // Playwright's Chrome for Testing distribution is win64 on Windows,
      // including Windows-on-ARM where x64 emulation is used.
      return ["chromium", "chrome-win64", "chrome.exe"];
    default:
      return undefined;
  }
};

const existingFile = async (path: string): Promise<string | undefined> => {
  try {
    await access(path, constants.F_OK);
    return path;
  } catch {
    return undefined;
  }
};

export const bundledChromiumExecutable = async (): Promise<string | undefined> => {
  const override = process.env[CHROMIUM_ENV]?.trim();
  if (override) return await existingFile(override);

  const relative = platformRelativeExecutable();
  if (!relative) return undefined;

  const executableDir = dirname(process.execPath);
  return await existingFile(join(executableDir, ...relative));
};
