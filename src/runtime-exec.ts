export type BrowserRenderer = "unicode" | "kitty" | "sixel";

const standaloneExecutable = (): boolean =>
  Boolean((Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable);

export const xvfbReexecCommand = (
  sourceEntrypoint: string,
  renderer: BrowserRenderer,
): string[] => {
  if (standaloneExecutable()) {
    return [
      process.execPath,
      ...process.argv.slice(2),
      "--render",
      renderer,
    ];
  }

  return [
    process.execPath,
    sourceEntrypoint,
    ...process.argv.slice(2),
  ];
};
