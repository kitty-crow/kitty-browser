# Kitty Browser

A real Chromium browser for the terminal.

Kitty Browser renders normal web pages directly in the terminal using Unicode, SIXEL or the Kitty graphics protocol. Renderer selection is automatic by default.

## Install

### Standalone release

Download the archive for your platform from GitHub Releases:

```text
kitty-browser-linux-x64.tar.gz
kitty-browser-linux-arm64.tar.gz
kitty-browser-darwin-x64.tar.gz
kitty-browser-darwin-arm64.tar.gz
kitty-browser-windows-x64.tar.gz
kitty-browser-windows-arm64.tar.gz
```

Extract it and run Kitty Browser:

```bash
./kitty-browser https://example.com
```

On Windows:

```powershell
.\kitty-browser.exe https://example.com
```

The standalone release includes Chromium. No separate Bun, Node.js, npm, Playwright or Chrome installation is required.

### From source

Requires Bun.

```bash
git clone --recurse-submodules git@github.com:kitty-crow/kitty-browser.git
cd kitty-browser
bun install
bunx playwright install chromium
bun . https://example.com
```
