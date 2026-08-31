// Kitty Browser never launches Playwright's Electron backend.
// This tiny package exists only so Bun can resolve Playwright's optional
// `require("electron")` while compiling the standalone Chromium-only binary.
module.exports = "";
