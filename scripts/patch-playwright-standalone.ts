#!/usr/bin/env bun

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PATCH_ENV = "KITTY_BROWSER_RELEASE_PATCH_PLAYWRIGHT";

if (process.env[PATCH_ENV] !== "1") process.exit(0);

const ROOT = resolve(import.meta.dir, "..");
const CORE_ROOT = join(ROOT, "node_modules", "playwright-core");
const CORE_PACKAGE = join(CORE_ROOT, "package.json");
const PROJECT_PACKAGE = join(ROOT, "package.json");

interface PackageJson {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
}

const projectPackage = JSON.parse(await readFile(PROJECT_PACKAGE, "utf8")) as PackageJson;
const corePackage = JSON.parse(await readFile(CORE_PACKAGE, "utf8")) as PackageJson;
const expectedVersion = projectPackage.dependencies?.playwright;

if (!expectedVersion || !/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
  throw new Error("release patch requires an exact Playwright version in package.json");
}

if (corePackage.version !== expectedVersion) {
  throw new Error(
    `release patch expected playwright-core ${expectedVersion}, found ${corePackage.version ?? "unknown"}`,
  );
}

interface PatchSpec {
  readonly file: string;
  readonly description: string;
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly patchedMarker: string;
}

const versionLiteral = JSON.stringify(expectedVersion);
const patches: readonly PatchSpec[] = [
  {
    file: join(CORE_ROOT, "lib", "server", "utils", "nodePlatform.js"),
    description: "nodePlatform core directory",
    pattern: /require\.resolve\((["'])(?:\.\/)?\.\.\/\.\.\/\.\.\/package\.json\1\)/gu,
    replacement: "process.execPath",
    patchedMarker: "process.execPath",
  },
  {
    file: join(CORE_ROOT, "lib", "server", "utils", "userAgent.js"),
    description: "user-agent Playwright version",
    pattern: /require\((["'])(?:\.\/)?\.\.\/\.\.\/\.\.\/package\.json\1\)\.version/gu,
    replacement: versionLiteral,
    patchedMarker: versionLiteral,
  },
  {
    file: join(CORE_ROOT, "lib", "server", "registry", "dependencies.js"),
    description: "dependency-check Playwright version",
    pattern: /require\((["'])(?:\.\/)?\.\.\/\.\.\/\.\.\/package\.json\1\)\.version/gu,
    replacement: versionLiteral,
    patchedMarker: versionLiteral,
  },
  {
    file: join(CORE_ROOT, "lib", "cli", "program.js"),
    description: "CLI package metadata",
    pattern: /require\((["'])\.\.\/\.\.\/package\.json\1\)/gu,
    replacement: `({ version: ${versionLiteral} })`,
    patchedMarker: `version: ${versionLiteral}`,
  },
];

for (const patch of patches) {
  const original = await readFile(patch.file, "utf8");
  const matches = [...original.matchAll(patch.pattern)];

  if (matches.length === 0) {
    if (original.includes(patch.patchedMarker)) continue;
    throw new Error(
      `could not locate Playwright standalone patch site: ${patch.description} (${patch.file})`,
    );
  }

  if (matches.length !== 1) {
    throw new Error(
      `expected one Playwright standalone patch site for ${patch.description}, found ${matches.length}`,
    );
  }

  const patched = original.replace(patch.pattern, patch.replacement);
  await writeFile(patch.file, patched, "utf8");
}

const unresolvedPackageRequire = /require(?:\.resolve)?\(\s*["'][^"']*package\.json["']\s*\)/u;
const unresolved: string[] = [];

const scan = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const source = await readFile(path, "utf8");
    if (unresolvedPackageRequire.test(source)) unresolved.push(path);
  }
};

await scan(join(CORE_ROOT, "lib"));

if (unresolved.length > 0) {
  throw new Error(
    `Playwright still contains runtime package.json resolution after standalone patch:\n${unresolved.join("\n")}`,
  );
}

console.log(`kitty-browser: patched playwright-core ${expectedVersion} for standalone Bun compilation`);
