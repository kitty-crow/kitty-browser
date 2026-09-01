# Kitty Browser

A real Chromium browser for the terminal.

Kitty Browser renders normal web pages directly in your terminal using one of three display modes:

- **Unicode** — portable terminal rendering using Unicode Braille and text.
- **SIXEL** — graphical rendering in SIXEL-capable terminals.
- **Kitty** — graphical rendering using the Kitty graphics protocol.

Renderer selection is automatic by default.

## Install

### Standalone release

Download the archive for your platform from the GitHub Releases page and extract it:

```text
kitty-browser-linux-x64.tar.gz
kitty-browser-linux-arm64.tar.gz
kitty-browser-darwin-x64.tar.gz
kitty-browser-darwin-arm64.tar.gz
kitty-browser-windows-x64.tar.gz
kitty-browser-windows-arm64.tar.gz
```

Each release archive contains Kitty Browser and Chromium together. No separate Bun, Node.js, npm, Playwright or Chrome installation is required.

Run the extracted executable:

```bash
./kitty-browser https://example.com
```

On Windows:

```powershell
.\kitty-browser.exe https://example.com
```

### From source

Requires Bun.

```bash
git clone --recurse-submodules git@github.com:kitty-crow/kitty-browser.git
cd kitty-browser
bun install
bunx playwright install chromium
bun . https://example.com
```

## Usage

```text
kitty-browser <url> [options]
```

When running from source, replace `kitty-browser` with `bun .`.

Examples:

```bash
kitty-browser https://example.com
kitty-browser https://example.com --render unicode
kitty-browser https://example.com --render sixel
kitty-browser https://example.com --render kitty
kitty-browser https://example.com --session personal
kitty-browser https://example.com --strict
kitty-browser https://example.com --no-status
```

### Options

| Option | Description |
| --- | --- |
| `--render auto` | Automatically choose Kitty, SIXEL or Unicode. This is the default. |
| `--render unicode` | Force Unicode rendering. |
| `--render sixel` | Force SIXEL rendering. |
| `--render kitty` | Force Kitty graphics rendering. |
| `--fps <1-24>` | Set the capture rate. Default: `12`. |
| `--resolution auto` | Size graphical renderers from the terminal at startup. Default for SIXEL and Kitty. |
| `--resolution native` | Follow the live terminal size. |
| `--resolution <preset>` | Use a named resolution such as `720p`. |
| `--resolution <WIDTHxHEIGHT>` | Use a fixed custom viewport such as `960x540`. |
| `--session <id>` | Use a persistent named Chromium session. |
| `--strict` | Restrict top-level navigation to the launch URL's registrable domain. |
| `--no-status` | Hide the navigation/status bar. |

`--resolution` applies to the SIXEL and Kitty renderers. Unicode always follows the terminal text grid.

## Navigation

The status bar provides Back, Refresh and an editable URL field:

```text
 [<] [R] https://example.com/
```

`Backspace` goes back when a webpage text field is not focused. `Ctrl+H` returns to the URL Kitty Browser was originally launched with.

Named sessions preserve normal Chromium browser data between launches:

```bash
kitty-browser https://example.com --session personal
```
