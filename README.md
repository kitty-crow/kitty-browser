# Kitty Browser

A standalone terminal browser built on real Chromium.

Kitty Browser owns browser runtime behaviour independently of any agent or model integration: Chromium launch/session behaviour, terminal capability detection, Unicode rendering, SIXEL rendering, Kitty graphics rendering, terminal input/mouse handling, viewport mapping and graphical-display bootstrapping.

It is consumed by `kitty-crow/openAI-pilot-headed` as a pinned vendored submodule. Agent schemas, OpenAI Pilot bridges, agent overlays, planning and model-facing behaviour do not belong here.

## Renderers

- `terminal`: probes the terminal and selects Kitty graphics, then SIXEL, then native Unicode as the portable fallback.
- `terminal:unicode`: terminal-native full-colour Braille with literal DOM text projection. It deliberately does not accept `--resolution`.
- `terminal:dense-unicode`: high-density full-colour Braille. Chromium renders at the requested viewport resolution, then the complete framebuffer is fitted into the physical terminal through Unicode Art Studio's ordinary Braille pipeline. Browser typography is therefore rasterised and squeezed with the page rather than emitted as full-size terminal characters.
- `terminal:sixel`: Chromium raster frames over SIXEL.
- `terminal:kitty`: Chromium PNG frames over the Kitty graphics protocol.
- `terminal:capabilities`: reports terminal capabilities used by the renderers.

`terminal:prototype` remains a compatibility alias for `terminal:unicode`.

## Setup

```bash
git submodule update --init --recursive
bun install
bunx playwright install chromium
```

On headless Linux hosts, graphical renderers that use real headed Chromium bootstrap through Xvfb when no graphical `DISPLAY` is available.

## Usage

```bash
bun run terminal -- https://example.com
bun run terminal:unicode -- https://example.com --fps 4
bun run terminal:dense-unicode -- https://example.com --resolution 960x540 --fps 4
bun run terminal:sixel -- https://example.com --resolution 720p --fps 4
bun run terminal:kitty -- https://example.com --resolution 720p --fps 24
```

`terminal:unicode` always derives its Chromium viewport from the terminal text grid and rejects `--resolution`.

`terminal:dense-unicode` defaults to `720p` and accepts `native`, convenience presets such as `cga`, `800x600`, `960x540`, `720p`, and `1080p`, or any positive integer `WIDTHxHEIGHT`. The requested resolution is the real Chromium viewport. Each captured frame is then aspect-fitted into the available terminal rows and columns using Unicode Art Studio's 2x4-dot-per-cell Braille conversion. There is no resolution-sized virtual canvas, no panning, and no literal DOM-text overlay.

The render loops are sequential and do not queue stale frames. Mouse, keyboard, scrolling, focus navigation and text entry are forwarded to the real Chromium page.

## Dependency boundary

```text
kitty-browser
  ├─ Playwright / Chromium
  └─ vendor/unicode-art-studio

openAI-pilot-headed
  ├─ vendor/kitty-browser (pinned)
  └─ vendor/openai-pilot (pinned)
```

Keep browser mechanics here. Keep agent/model concerns out.
