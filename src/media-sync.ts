export const monotonicNs = (): bigint => process.hrtime.bigint();

export const mediaFrameMarker = (
  frame: number,
  fps: number,
  timestampNs: bigint,
): string => `\x1b]777;kitty-browser-frame;1;${frame};${fps};${timestampNs}\x1b\\`;

export const midpointNs = (start: bigint, end: bigint): bigint => start + (end - start) / 2n;
