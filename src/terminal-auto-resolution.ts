const AUTO_RESOLUTION_ENV = "KITTY_BROWSER_AUTO_RESOLUTION";
const AUTO_COLUMNS_ENV = "KITTY_BROWSER_AUTO_COLUMNS";
const AUTO_ROWS_ENV = "KITTY_BROWSER_AUTO_ROWS";

let frozen = false;

export const autoResolutionEnabled = (): boolean =>
  process.env[AUTO_RESOLUTION_ENV] === "1";

export const setAutoResolutionEnabled = (enabled: boolean): void => {
  process.env[AUTO_RESOLUTION_ENV] = enabled ? "1" : "0";
};

export const captureTerminalGeometry = (): void => {
  if (!autoResolutionEnabled()) return;
  if (process.env[AUTO_COLUMNS_ENV] && process.env[AUTO_ROWS_ENV]) return;

  const columns = Math.max(8, process.stdout.columns ?? 120);
  const rows = Math.max(5, process.stdout.rows ?? 40);
  process.env[AUTO_COLUMNS_ENV] = String(columns);
  process.env[AUTO_ROWS_ENV] = String(rows);
};

const capturedDimension = (
  name: typeof AUTO_COLUMNS_ENV | typeof AUTO_ROWS_ENV,
  fallback: number,
): number => {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const freezeTerminalGeometry = (): void => {
  if (!autoResolutionEnabled() || frozen) return;
  captureTerminalGeometry();
  frozen = true;

  const columns = Math.max(8, capturedDimension(AUTO_COLUMNS_ENV, process.stdout.columns ?? 120));
  const rows = Math.max(5, capturedDimension(AUTO_ROWS_ENV, process.stdout.rows ?? 40));

  // Raster auto-resolution is a startup snapshot. Shadow the TTY's live
  // column/row getters with the original launch dimensions so renderer resize
  // callbacks keep seeing the same geometry for the whole run. The snapshot
  // is carried in the environment across the Xvfb guard re-exec.
  Object.defineProperties(process.stdout, {
    columns: {
      configurable: true,
      enumerable: true,
      get: () => columns,
    },
    rows: {
      configurable: true,
      enumerable: true,
      get: () => rows,
    },
  });
};
