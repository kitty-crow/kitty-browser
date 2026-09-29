import { chromium, type Browser, type BrowserContext, type Mouse, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { installBrowserShortcuts } from "./browser-shortcuts.ts";
import { bundledChromiumExecutable } from "./bundled-chromium.ts";
import { browserHomeUrl, installStrictNavigation } from "./navigation-policy.ts";
import { consumeTerminalClickDelayMs } from "./pointer-timing.ts";
import { browserSessionId } from "./terminal-session.ts";

const DEFAULT_PROFILE_ROOT = join(homedir(), ".local", "share", "kitty-browser", "sessions");
const HIDDEN_WINDOW_POSITION = "--window-position=-32000,-32000";
const VIRTUAL_WINDOW_POSITION = "--window-position=0,0";
const VIRTUAL_DISPLAY_ENV = "KITTY_BROWSER_VIRTUAL_DISPLAY";

type MouseClickOptions = Parameters<Mouse["click"]>[2];

const installPointerTiming = (page: Page): void => {
  const mouse = page.mouse;
  const originalClick = mouse.click.bind(mouse);

  Object.defineProperty(mouse, "click", {
    configurable: true,
    value: async (x: number, y: number, options?: MouseClickOptions): Promise<void> => {
      if (options?.delay !== undefined) {
        await originalClick(x, y, options);
        return;
      }

      const measuredDelayMs = consumeTerminalClickDelayMs();
      if (measuredDelayMs === null) {
        await originalClick(x, y, options);
        return;
      }

      await originalClick(x, y, { ...(options ?? {}), delay: measuredDelayMs });
    },
  });
};

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
  readonly env?: Readonly<Record<string, string>>;
}

export const launchPersistentBrowser = async (
  options: PersistentBrowserOptions,
): Promise<PersistentBrowser> => {
  const session = browserSessionId();
  const profileDir = profileDirectory(session);
  await mkdir(profileDir, { recursive: true });

  const executablePath = await bundledChromiumExecutable();
  const virtualDisplay = process.platform === "linux" && process.env[VIRTUAL_DISPLAY_ENV] === "1";
  const args = [virtualDisplay ? VIRTUAL_WINDOW_POSITION : HIDDEN_WINDOW_POSITION];

  // Kitty Browser intentionally uses real headed Chromium for raster renderers.
  // On displayless Linux the guards re-exec us under Xvfb and place the real
  // headed window inside that virtual framebuffer. Do not disable Chromium's
  // GPU/compositor process here: on GPU-less Xvfb Chromium can select its own
  // software path, while --disable-gpu can leave captured compositor frames black.
  //
  // Playwright normally adds --enable-automation and disables Chromium's sandbox.
  // Neither is required by Kitty Browser. Keep browser-visible behaviour close to
  // an ordinary interactive Chromium session while retaining Playwright solely as
  // the transport used for screenshots and user input. Do not spoof UA or browser
  // Web APIs here.

  const launchEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...(options.env ?? {}) })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args,
    env: launchEnv,
    ignoreDefaultArgs: ["--enable-automation"],
    chromiumSandbox: true,
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
      installPointerTiming(page);
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
