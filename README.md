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

## Browser sessions and persistence

Every renderer uses a real persistent Chromium user-data directory. With no explicit session, Kitty Browser uses the persistent session named `default`:

```bash
bun run terminal:unicode -- https://example.com
```

Use `--session <id>` to create or reopen an independent Chromium profile:

```bash
bun run terminal:unicode -- https://example.com --session personal
bun run terminal:kitty -- https://example.com --session work --resolution 960x540
bun run terminal:sixel -- https://example.com --session testing --resolution 800x600
```

The same session ID refers to the same Chromium profile across all three renderers. Different session IDs are isolated from one another. Session IDs are 1-64 characters, may use letters, numbers, `.`, `_` and `-`, and must start with a letter or number.

Profiles live under:

```text
~/.local/share/kitty-browser/sessions/<session-id>/
```

Set `KITTY_BROWSER_PROFILE_ROOT` to move the profile root elsewhere.

Kitty Browser does not reimplement web storage. Chromium itself owns cookies, localStorage, sessionStorage semantics, IndexedDB, cache, service-worker/site state and its profile history. Persistent stores such as cookies, localStorage and IndexedDB therefore survive later launches of the same named session according to normal Chromium rules. `sessionStorage` retains its normal browser/tab lifetime semantics rather than being artificially serialised by Kitty Browser.

## Navigation bar

When the bottom status bar is enabled it also acts as the browser navigation bar:

```text
 [<] [R] https://example.com/ ...
```

- Click `[<]` to go back.
- Click `[R]` to refresh the current page.
- Click the URL to edit it. Enter navigates, Esc cancels, Backspace/Delete and Left/Right/Home/End edit normally.
- URLs without an explicit scheme are opened as `https://...`.

`--no-status` hides the bar and therefore also hides these mouse navigation controls.

## Setup

```bash
git submodule update --init --recursive
bun install
bunx playwright install chromium
```

On headless Linux hosts, graphical renderers that use real headed Chromium bootstrap through Xvfb when no graphical `DISPLAY` is available.

## Usage

```bash
bun run terminal -- https://example.com --session default
bun run terminal:unicode -- https://example.com --fps 4 --session personal
bun run terminal:sixel -- https://example.com --resolution 720p --fps 4 --session testing
bun run terminal:kitty -- https://example.com --resolution 720p --fps 24 --session work
```

The Unicode renderer always derives its Chromium viewport from the terminal text grid. SIXEL and Kitty expose arbitrary positive integer `WIDTHxHEIGHT` viewport resolutions as well as named presets.

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
