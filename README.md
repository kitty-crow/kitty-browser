# Kitty Browser

A standalone terminal browser built on real Chromium.

Kitty Browser owns browser runtime behaviour independently of any agent or model integration: Chromium launch/session behaviour, terminal capability detection, Unicode rendering, SIXEL rendering, Kitty graphics rendering, terminal input/mouse handling, viewport mapping and graphical-display bootstrapping.

It is consumed by `kitty-crow/openAI-pilot-headed` as a pinned vendored submodule. Agent schemas, OpenAI Pilot bridges, agent overlays, planning and model-facing behaviour do not belong here.

## Renderers

Kitty Browser has three renderers:

- `unicode`: terminal-native full-colour Unicode Braille with literal DOM text projection. It deliberately does not accept `--resolution`.
- `sixel`: Chromium raster frames over SIXEL.
- `kitty`: Chromium PNG frames over the Kitty graphics protocol.

`--render auto` is the default and probes the terminal, selecting Kitty graphics, then SIXEL, then Unicode as the portable fallback. `terminal:capabilities` reports the terminal capabilities used by that selection logic.

## Unified CLI

Use the package entry point directly:

```bash
bun . https://example.com
```

Renderer selection is an argument rather than a separate package script:

```bash
bun . https://example.com --render auto
bun . https://example.com --render unicode
bun . https://example.com --render sixel
bun . https://example.com --render kitty
```

`--render auto` is the default. `bun run terminal -- ...` remains as a compatibility alias.

The capture rate defaults to 12 FPS. `--fps` accepts integer values from 1 through 24 inclusive; values outside that range are rejected.

## Raster resolution

SIXEL and Kitty use `auto` resolution by default. Auto resolution captures the terminal columns and rows once when Kitty Browser starts and keeps that exact geometry for the lifetime of the process. The renderer uses its terminal-native raster density (8 browser pixels per terminal column and 16 browser pixels per terminal row), excluding the navigation/status row when it is shown.

This prevents the default raster path from unnecessarily rendering a fixed 720p or 1080p framebuffer when the terminal has a much smaller display grid. If the terminal is resized after launch, auto resolution deliberately does not change. Close and reopen Kitty Browser to capture the new terminal geometry.

```bash
bun . https://example.com --render kitty
bun . https://example.com --render sixel
bun . https://example.com --render kitty --resolution auto
```

`--resolution native` remains available as the explicit live-terminal mode. It follows terminal geometry changes during the run. Named presets and arbitrary positive `WIDTHxHEIGHT` values remain fixed Chromium viewport overrides:

```bash
bun . https://example.com --render kitty --resolution native
bun . https://example.com --render kitty --resolution 720p
bun . https://example.com --render sixel --resolution 960x540
```

The startup auto-resolution snapshot is carried across the Linux Xvfb re-exec, so headed Chromium still receives the geometry from the original terminal launch.

## Browser sessions and persistence

Every renderer uses a real persistent Chromium user-data directory. With no explicit session, Kitty Browser uses the persistent session named `default`:

```bash
bun . https://example.com
```

Use `--session <id>` to create or reopen an independent Chromium profile:

```bash
bun . https://example.com --render unicode --session personal
bun . https://example.com --render kitty --session work --resolution 960x540
bun . https://example.com --render sixel --session testing --resolution 800x600
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

Two global keyboard navigation shortcuts are available even when the status bar is hidden:

- `Backspace` goes to the previous page only when Chromium's currently focused webpage element is not an editable input, textarea or contenteditable element. If an editable webpage element is focused, Backspace is sent to Chromium instead.
- `Ctrl+H` returns directly to the original URL supplied when Kitty Browser was launched.

The launch/home page is the Back-history floor. Pressing Backspace or clicking `[<]` there is a no-op and never exposes Chromium's bootstrap `about:blank` page.

## Strict navigation

Use `--strict` to confine top-level browsing to the launch URL's registrable domain:

```bash
bun . https://app.example.co.uk --strict
```

Subdomains of the same registrable domain remain available, so `app.example.co.uk`, `www.example.co.uk` and `example.co.uk` can navigate between one another. Navigation to a different registrable domain is blocked.

The check uses the public suffix list, including private suffixes, rather than assuming a domain is always the final two labels. This correctly handles names such as `example.co.uk` and hosted-domain boundaries such as `name.github.io`.

Strict mode applies to main-frame clicks, redirects, form submissions, JavaScript navigation and URLs entered into the terminal navigation bar. Third-party subresources are not blocked, so pages may still load scripts, styles, images, APIs and other resources from external hosts.

When a cross-domain top-level navigation is blocked, Chromium's normal `chrome-error` page is left visible for about two seconds. Kitty Browser then automatically returns that tab to the exact launch/home URL. A later blocked attempt replaces any earlier pending return timer rather than stacking multiple return navigations.

## Setup

```bash
git submodule update --init --recursive
bun install
bunx playwright install chromium
```

On headless Linux hosts, graphical renderers that use real headed Chromium bootstrap through Xvfb when no graphical `DISPLAY` is available.

## Usage

```bash
bun . https://example.com --session default
bun . https://example.com --render unicode --session personal
bun . https://example.com --render sixel --session testing
bun . https://example.com --render kitty --session work
bun . https://example.com --render kitty --resolution 720p
bun . https://example.com --render kitty --no-status
bun . https://example.com --strict
```

The Unicode renderer always derives its Chromium viewport from the terminal text grid. SIXEL and Kitty default to startup-frozen auto resolution and also expose live `native`, named presets, and arbitrary positive integer `WIDTHxHEIGHT` viewport resolutions.

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
