import type { BrowserContext } from "playwright";
import { getDomain } from "tldts";

const STRICT_ENV = "KITTY_BROWSER_STRICT";
const HOME_ENV = "KITTY_BROWSER_HOME_URL";

export const strictNavigationEnabled = (): boolean => process.env[STRICT_ENV] === "1";
export const browserHomeUrl = (): string => process.env[HOME_ENV]?.trim() || "about:blank";

const httpUrl = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return url;
    if (url.protocol === "blob:") {
      const inner = new URL(url.pathname);
      if (inner.protocol === "http:" || inner.protocol === "https:") return inner;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const registrableDomain = (raw: string): string | undefined => {
  const url = httpUrl(raw);
  if (!url) return undefined;
  const hostname = url.hostname.toLowerCase();
  return getDomain(hostname, { allowPrivateDomains: true })?.toLowerCase() || hostname;
};

export const strictNavigationAllows = (
  targetUrl: string,
  homeUrl = browserHomeUrl(),
): boolean => {
  if (!strictNavigationEnabled()) return true;
  const homeDomain = registrableDomain(homeUrl);
  const targetDomain = registrableDomain(targetUrl);
  return !!homeDomain && !!targetDomain && homeDomain === targetDomain;
};

export const installStrictNavigation = async (
  context: BrowserContext,
  homeUrl = browserHomeUrl(),
): Promise<void> => {
  if (!strictNavigationEnabled()) return;

  const homeDomain = registrableDomain(homeUrl);
  if (!homeDomain) {
    throw new Error(`--strict requires an http(s) launch URL with a domain or host; got ${JSON.stringify(homeUrl)}`);
  }

  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }

    let topLevel = false;
    try {
      topLevel = request.frame().parentFrame() === null;
    } catch {
      await route.continue();
      return;
    }

    if (!topLevel || strictNavigationAllows(request.url(), homeUrl)) {
      await route.continue();
      return;
    }

    await route.abort("blockedbyclient");
  });
};
