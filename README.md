# Kitty Browser

A standalone terminal browser built on real Chromium.

Kitty Browser owns browser runtime behaviour independently of any agent or model integration: Chromium launch/session behaviour, terminal capability detection, Unicode Braille rendering, Kitty graphics rendering, terminal input/mouse handling, viewport mapping and graphical-display bootstrapping.

It is consumed by `kitty-crow/openAI-pilot-headed` as a pinned vendored submodule. Agent schemas, OpenAI Pilot bridges, agent overlays, planning and model-facing behaviour do not belong here.

## Renderers

- `terminal`: probes the terminal and selects Kitty graphics when available, otherwise the portable Braille renderer.
- `terminal:prototype`: full-colour Unicode Braille with literal DOM text projection.
- `terminal:kitty`: full Chromium PNG frames over the Kitty graphics protocol.
- `terminal:capabilities`: reports terminal capabilities used by the renderers.

## Setup

```bash
git submodule update --init --recursive
bun install
bunx playwright install chromium
```

On headless Linux hosts, the Kitty renderer uses real headed Chromium under Xvfb. Install `xvfb` when no graphical `DISPLAY` is available.

## Usage

```bash
bun run terminal -- https://example.com
bun run terminal:prototype -- https://example.com --resolution 720p --fps 4
bun run terminal:kitty -- https://example.com --resolution 720p --fps 24
```

Supported fixed resolutions are `800x600`, `1024x768`, `720p`, `1366x768`, `900p`, `1080p`, or an explicit `WIDTHxHEIGHT` between 800x600 and 1920x1080. `native` derives the Chromium viewport from the terminal.

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
