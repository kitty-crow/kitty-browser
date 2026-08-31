import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installBrowserShortcuts } from "./browser-shortcuts.ts";
import { bundledChromiumExecutable } from "./bundled-chromium.ts";
import { browserHomeUrl, installStrictNavigation } from "./navigation-policy.ts";
import { browserSessionId } from "./terminal-session.ts";

const DEFAULT_PROFILE_ROOT = join(homedir(), ".local", "share", "kitty-browser", "sessions");

export const profileRoot = (): string =>
  process.env.KITTY_BROWSER_PROFILE_ROOT?.trim() || DEFAULT_PROFILE_ROOT;

export const profileDirectory = (session = browserSessionId()): string =>
  join(profileRoot(), session);

export interface PersistentBrowser {
  readonly context: BrowserContext;
  readonly profileDir: string;
  readonly session: string;
  newPage(): Promise<Page>;
  close(): Promise<void>;
  isConnected(): boolean;
  on(event: "disconnected", listener: () => void): void;
}

export interface PersistentBrowserOptions {
  readonly headless: boolean;
  readonly channel?: string;
}

export const launchPersistentBrowser = async (
  options: PersistentBrowserOptions,
): Promise<PersistentBrowser> => {
  const session = browserSessionId();
  const profileDir = profileDirectory(session);
  await mkdir(profileDir, { recursive: true });

  const executablePath = await bundledChromiumExecutable();
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    ...(executablePath
      ? { executablePath }
      : options.channel
        ? { channel: options.channel }
        : {}),
  });

  await installStrictNavigation(context, browserHomeUrl());

  const underlying = context.browser();
  let claimedInitialPage = false;
  let removeShortcuts: (() => void) | undefined;

  const currentBrowser = (): Browser | null => context.browser() ?? underlying;

  return {
    context,
    profileDir,
    session,
    async newPage(): Promise<Page> {
      let page: Page;
      if (!claimedInitialPage) {
        claimedInitialPage = true;
        page = context.pages()[0] ?? await context.newPage();
      } else {
        page = await context.newPage();
      }
      removeShortcuts?.();
      removeShortcuts = installBrowserShortcuts(page);
      return page;
    },
    async close(): Promise<void> {
      removeShortcuts?.();
      removeShortcuts = undefined;
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
