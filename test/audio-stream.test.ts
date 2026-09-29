import { describe, expect, test } from "bun:test";
import { buildAudioPacket } from "../src/audio-stream.ts";
import { mediaFrameMarker } from "../src/media-sync.ts";

describe("audio packet format", () => {
  test("encodes the fixed 1/96-second PCM packet header", () => {
    const pcm = new Uint8Array(500 * 2 * 2);
    pcm[0] = 0x34;
    pcm[1] = 0x12;
    const startNs = 12_345_678_901n;
    const packet = buildAudioPacket(pcm, 0x1_0000_0001, startNs);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

    expect(packet.byteLength).toBe(32 + pcm.byteLength);
    expect(view.getUint32(0, true)).toBe(0x3141424b);
    expect(view.getUint8(4)).toBe(1);
    expect(view.getUint8(5)).toBe(2);
    expect(view.getUint8(6)).toBe(1);
    expect(view.getUint32(8, true)).toBe(48_000);
    expect(view.getUint32(12, true)).toBe(500);
    expect(view.getUint32(16, true)).toBe(1);
    expect(view.getBigUint64(20, true)).toBe(startNs);
    expect(packet[32]).toBe(0x34);
    expect(packet[33]).toBe(0x12);
  });

  test("rejects partial PCM packets", () => {
    expect(() => buildAudioPacket(new Uint8Array(1999), 0, 0n)).toThrow();
  });
});

describe("shared media clock marker", () => {
  test("carries frame, cadence and monotonic timestamp", () => {
    expect(mediaFrameMarker(7, 24, 9_876_543_210n))
      .toBe("\x1b]777;kitty-browser-frame;1;7;24;9876543210\x1b\\");
  });
});
