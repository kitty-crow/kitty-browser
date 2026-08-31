# Kitty Browser

A standalone terminal browser built on real Chromium.

Kitty Browser owns browser runtime behaviour independently of any agent or model integration: Chromium launch/session behaviour, terminal capability detection, Unicode rendering, SIXEL rendering, Kitty graphics rendering, terminal input/mouse handling, viewport mapping and graphical-display bootstrapping.

It is consumed by `kitty-crow/openAI-pilot-headed` as a pinned vendored submodule. Agent schemas, OpenAI Pilot bridges, agent overlays, planning and model-facing behaviour do not belong here.

## Renderers

Kitty Browser has three renderers:

- `terminal:unicode`: terminal-native full-colour Unicode Braille with literal DOM text projection. It deliberately does not accept `--resolution`.
- `terminal:sixel`: Chromium raster frames over SIXEL.
- `terminal:kitty`: Chromium PNG frames over the Kitty graphics protocol.

`terminal` probes the terminal and automatically selects Kitty graphics, then SIXEL, then Unicode as the portable fallback. `terminal:capabilities` reports the terminal capabilities used by that selection logic.

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
bun run terminal:sixel -- https://example.com --resolution 720p --fps 4
bun run terminal:kitty -- https://example.com --resolution 720p --fps 24
```

The Unicode renderer always derives its Chromium viewport from the terminal text grid. SIXEL and Kitty expose explicit viewport-resolution controls.

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
