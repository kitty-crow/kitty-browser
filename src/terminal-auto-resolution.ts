const AUTO_RESOLUTION_ENV = "KITTY_BROWSER_AUTO_RESOLUTION";

let frozen = false;

export const autoResolutionEnabled = (): boolean =>
  process.env[AUTO_RESOLUTION_ENV] === "1";

export const setAutoResolutionEnabled = (enabled: boolean): void => {
  process.env[AUTO_RESOLUTION_ENV] = enabled ? "1" : "0";
};

export const freezeTerminalGeometry = (): void => {
  if (frozen) return;
  frozen = true;

  const columns = Math.max(8, process.stdout.columns ?? 120);
  const rows = Math.max(5, process.stdout.rows ?? 40);

  // Raster auto-resolution is a startup snapshot. Shadow the TTY's live
  // column/row getters with the values observed when the browser starts so
  // renderer resize callbacks keep seeing the original geometry for this run.
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
