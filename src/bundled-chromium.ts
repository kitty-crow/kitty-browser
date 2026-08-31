import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

const CHROMIUM_ENV = "KITTY_BROWSER_CHROMIUM_EXECUTABLE";

const platformRelativeExecutable = (): string[] | undefined => {
  switch (process.platform) {
    case "linux":
      return ["chromium", "chrome-linux", "chrome"];
    case "darwin":
      return ["chromium", "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"];
    case "win32":
      return ["chromium", "chrome-win", "chrome.exe"];
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
