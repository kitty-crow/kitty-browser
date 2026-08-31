export type RasterRenderer = "kitty" | "sixel";

const standaloneExecutable = (): boolean =>
  Boolean((Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable);

export const xvfbReexecCommand = (
  sourceEntrypoint: string,
  renderer: RasterRenderer,
): string[] => {
  if (standaloneExecutable()) {
    // A compiled Bun executable already owns its bundled entrypoint. Re-run the
    // executable itself and explicitly preserve the raster renderer selection.
    return [
      process.execPath,
      ...process.argv.slice(2),
      "--render",
      renderer,
    ];
  }

  // Development/source execution still needs Bun plus the guard entrypoint.
  return [
    process.execPath,
    sourceEntrypoint,
    ...process.argv.slice(2),
  ];
};
