import { chromium, type Browser, type BrowserContext, type BrowserTypeLaunchOptions, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROFILE_DIR = join(homedir(), ".local", "share", "kitty-browser", "chromium-profile");

export const profileDirectory = (): string =>
  process.env.KITTY_BROWSER_PROFILE_DIR?.trim() || DEFAULT_PROFILE_DIR;

export interface PersistentBrowser {
  readonly context: BrowserContext;
  readonly profileDir: string;
  newPage(): Promise<Page>;
  close(): Promise<void>;
  isConnected(): boolean;
  on(event: "disconnected", listener: () => void): void;
}

export interface PersistentBrowserOptions {
  readonly headless: boolean;
  readonly channel?: BrowserTypeLaunchOptions["channel"];
}

export const launchPersistentBrowser = async (
  options: PersistentBrowserOptions,
): Promise<PersistentBrowser> => {
  const profileDir = profileDirectory();
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    ...(options.channel ? { channel: options.channel } : {}),
  });

  const underlying = context.browser();
  let claimedInitialPage = false;

  const currentBrowser = (): Browser | null => context.browser() ?? underlying;

  return {
    context,
    profileDir,
    async newPage(): Promise<Page> {
      if (!claimedInitialPage) {
        claimedInitialPage = true;
        const existing = context.pages()[0];
        if (existing) return existing;
      }
      return await context.newPage();
    },
    async close(): Promise<void> {
      await context.close();
    },
    isConnected(): boolean {
      return currentBrowser()?.isConnected() ?? false;
    },
    on(event: "disconnected", listener: () => void): void {
      currentBrowser()?.on(event, listener);
    },
  };
};
