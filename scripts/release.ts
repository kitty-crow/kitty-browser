#!/usr/bin/env bun

import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

interface ReleaseOptions {
  tag?: string;
  draft: boolean;
  prerelease: boolean;
  buildOnly: boolean;
  allowDirty: boolean;
}

interface ReleaseTarget {
  readonly id: string;
  readonly os: "linux" | "darwin" | "windows";
  readonly arch: "x64" | "arm64";
  readonly bunTarget: Bun.Build.CompileTarget;
  readonly browserArchive: string;
  readonly browserArch: "x64" | "arm64";
  readonly browserExecutable: readonly string[];
}

interface ChromiumInfo {
  readonly revision: string;
  readonly browserVersion: string;
}

interface BuiltBundle extends ReleaseTarget {
  readonly archiveFilename: string;
  readonly bytes: number;
  readonly sha256: string;
}

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "release");
const STAGE = join(OUT, ".stage");
const BUILD = join(OUT, ".build");
const CHROMIUM_CACHE = join(DIST, ".chromium-cache");
const PACKAGE_PATH = join(ROOT, "package.json");
const BROWSERS_JSON = join(ROOT, "node_modules", "playwright-core", "browsers.json");
const MIN_BUN_MAJOR = 1;
const MIN_BUN_MINOR = 4;

const PLAYWRIGHT_CDN_MIRRORS = [
  "https://cdn.playwright.dev/dbazure/download/playwright",
  "https://playwright.download.prss.microsoft.com/dbazure/download/playwright",
  "https://cdn.playwright.dev",
] as const;

const TARGETS: readonly ReleaseTarget[] = [
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    bunTarget: "bun-linux-x64-baseline",
    browserArchive: "chromium-linux.zip",
    browserArch: "x64",
    browserExecutable: ["chrome-linux", "chrome"],
  },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    bunTarget: "bun-linux-arm64",
    browserArchive: "chromium-linux-arm64.zip",
    browserArch: "arm64",
    browserExecutable: ["chrome-linux", "chrome"],
  },
  {
    id: "darwin-x64",
    os: "darwin",
    arch: "x64",
    bunTarget: "bun-darwin-x64-baseline",
    browserArchive: "chromium-mac.zip",
    browserArch: "x64",
    browserExecutable: ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  },
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    browserArchive: "chromium-mac-arm64.zip",
    browserArch: "arm64",
    browserExecutable: ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  },
  {
    id: "windows-x64",
    os: "windows",
    arch: "x64",
    bunTarget: "bun-windows-x64-baseline",
    browserArchive: "chromium-win64.zip",
    browserArch: "x64",
    browserExecutable: ["chrome-win", "chrome.exe"],
  },
  {
    id: "windows-arm64",
    os: "windows",
    arch: "arm64",
    bunTarget: "bun-windows-arm64",
    browserArchive: "chromium-win64.zip",
    browserArch: "x64",
    browserExecutable: ["chrome-win", "chrome.exe"],
  },
];

const help = (code = 0): never => {
  console.log(`Kitty Browser release builder

Usage:
  bun run release [options]

Options:
  --tag <tag>       Release tag; default v<package.json version>
  --draft           Create a draft GitHub Release
  --prerelease      Mark a newly-created release as a prerelease
  --build-only      Build bundles and manifest without uploading
  --allow-dirty     Permit tracked working-tree changes
  -h, --help        Show this help

Default output:
  dist/release/

Each target archive contains the standalone Kitty Browser executable, embedded Bun
runtime, and the exact full Chromium revision pinned by the installed Playwright version.
The normal command builds every target, writes SHA-256 checksums and a machine-readable
manifest, then creates/updates the matching GitHub Release using gh.`);
  process.exit(code);
};

const parseOptions = (argv: readonly string[]): ReleaseOptions => {
  const out: ReleaseOptions = {
    draft: false,
    prerelease: false,
    buildOnly: false,
    allowDirty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--tag") {
      const tag = argv[++i];
      if (!tag) throw new Error("--tag requires a value");
      out.tag = tag;
      continue;
    }
    if (arg.startsWith("--tag=")) {
      out.tag = arg.slice("--tag=".length);
      continue;
    }
    if (arg === "--draft") {
      out.draft = true;
      continue;
    }
    if (arg === "--prerelease") {
      out.prerelease = true;
      continue;
    }
    if (arg === "--build-only") {
      out.buildOnly = true;
      continue;
    }
    if (arg === "--allow-dirty") {
      out.allowDirty = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") help(0);
    throw new Error(`unknown release-builder argument: ${arg}`);
  }

  return out;
};

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const exec = async (command: readonly string[], capture = false): Promise<ExecResult> => {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: process.env,
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });

  const stdoutPromise = capture && child.stdout
    ? new Response(child.stdout).text()
    : Promise.resolve("");
  const stderrPromise = capture && child.stderr
    ? new Response(child.stderr).text()
    : Promise.resolve("");
  const code = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const checked = async (command: readonly string[], capture = false): Promise<ExecResult> => {
  const result = await exec(command, capture);
  if (result.code !== 0) {
    const details = result.stderr || result.stdout;
    throw new Error(`${command.join(" ")} failed with exit code ${result.code}${details ? `\n${details}` : ""}`);
  }
  return result;
};

const commandExists = async (command: string): Promise<boolean> => {
  const result = await exec(["sh", "-lc", `command -v ${command} >/dev/null 2>&1`]);
  return result.code === 0;
};

const assertSupportedBun = (): void => {
  const [major = 0, minor = 0] = Bun.version.split(".").map((value) => Number.parseInt(value, 10));
  if (major > MIN_BUN_MAJOR || (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR)) return;
  throw new Error(
    `release builder requires Bun >= ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0 for the full target matrix (including Windows ARM64); found ${Bun.version}. Run: bun upgrade`,
  );
};

const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
};

const chromiumInfo = async (): Promise<ChromiumInfo> => {
  const data = await Bun.file(BROWSERS_JSON).json() as {
    browsers?: Array<{ name?: string; revision?: string; browserVersion?: string }>;
  };
  const chromium = data.browsers?.find((browser) => browser.name === "chromium");
  if (!chromium?.revision || !chromium.browserVersion) {
    throw new Error(`could not read Chromium revision/version from ${BROWSERS_JSON}`);
  }
  return {
    revision: chromium.revision,
    browserVersion: chromium.browserVersion,
  };
};

const downloadChromium = async (
  info: ChromiumInfo,
  archiveName: string,
): Promise<string> => {
  await mkdir(CHROMIUM_CACHE, { recursive: true });
  const cached = join(CHROMIUM_CACHE, `${info.revision}-${archiveName}`);
  if (await Bun.file(cached).exists()) return cached;

  const relative = `builds/chromium/${info.revision}/${archiveName}`;
  const temporary = `${cached}.tmp`;
  await rm(temporary, { force: true });

  let lastError = "";
  for (const mirror of PLAYWRIGHT_CDN_MIRRORS) {
    const url = `${mirror}/${relative}`;
    console.log(`    downloading ${url}`);
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`;
        continue;
      }
      await Bun.write(temporary, response);
      await rm(cached, { force: true });
      await Bun.write(cached, Bun.file(temporary));
      await rm(temporary, { force: true });
      return cached;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  await rm(temporary, { force: true });
  throw new Error(`failed to download Playwright Chromium ${archiveName}: ${lastError || "all CDN mirrors failed"}`);
};

const compileTarget = async (target: ReleaseTarget, executable: string): Promise<void> => {
  console.log(`\n==> Compiling ${target.id} (${target.bunTarget})`);
  await mkdir(dirname(executable), { recursive: true });

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "cli.ts")],
    compile: {
      target: target.bunTarget,
      outfile: executable,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
    },
    minify: true,
    bytecode: true,
    sourcemap: "none",
    throw: false,
  });

  if (!result.success) {
    const diagnostics = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`failed to build ${target.id}${diagnostics ? `\n${diagnostics}` : ""}`);
  }
};

const buildBundle = async (
  target: ReleaseTarget,
  info: ChromiumInfo,
  version: string,
  head: string,
): Promise<BuiltBundle> => {
  const bundleDir = join(STAGE, target.id);
  const buildDir = join(BUILD, target.id);
  const executableName = target.os === "windows" ? "kitty-browser.exe" : "kitty-browser";
  const builtExecutable = join(buildDir, executableName);
  const bundledExecutable = join(bundleDir, executableName);
  const chromiumDir = join(bundleDir, "chromium");

  await rm(bundleDir, { recursive: true, force: true });
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(chromiumDir, { recursive: true });

  await compileTarget(target, builtExecutable);
  await copyFile(builtExecutable, bundledExecutable);
  if (target.os !== "windows") await chmod(bundledExecutable, 0o755);

  console.log(`    Chromium ${info.browserVersion} revision ${info.revision}`);
  const chromiumZip = await downloadChromium(info, target.browserArchive);
  await checked(["unzip", "-q", "-o", chromiumZip, "-d", chromiumDir]);

  const browserExecutable = join(chromiumDir, ...target.browserExecutable);
  if (!(await Bun.file(browserExecutable).exists())) {
    throw new Error(`Chromium archive ${target.browserArchive} did not contain ${target.browserExecutable.join("/")}`);
  }
  if (target.os !== "windows") await chmod(browserExecutable, 0o755).catch(() => undefined);

  const bundleMetadata = {
    schemaVersion: 1,
    name: "kitty-browser",
    version,
    commit: head,
    target: target.id,
    os: target.os,
    arch: target.arch,
    chromium: {
      revision: info.revision,
      browserVersion: info.browserVersion,
      browserArch: target.browserArch,
      executable: ["chromium", ...target.browserExecutable].join("/"),
    },
  };
  await Bun.write(
    join(bundleDir, "kitty-browser-bundle.json"),
    `${JSON.stringify(bundleMetadata, null, 2)}\n`,
  );

  const archiveFilename = `kitty-browser-${target.id}.tar.gz`;
  const archivePath = join(OUT, archiveFilename);
  await rm(archivePath, { force: true });
  await checked(["tar", "-czf", archivePath, "-C", bundleDir, "."]);

  const archive = Bun.file(archivePath);
  const sha256 = await sha256File(archivePath);
  await Bun.write(`${archivePath}.sha256`, `${sha256}  ${archiveFilename}\n`);

  console.log(`    ${archiveFilename}`);
  console.log(`    ${(archive.size / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`    sha256 ${sha256}`);

  return {
    ...target,
    archiveFilename,
    bytes: archive.size,
    sha256,
  };
};

assertSupportedBun();
const options = parseOptions(process.argv.slice(2));
const pkg = await Bun.file(PACKAGE_PATH).json() as { version?: string };
if (!pkg.version) throw new Error("package.json has no version");
const tag = options.tag ?? `v${pkg.version}`;
const version = tag.startsWith("v") ? tag.slice(1) : tag;

await checked(["git", "rev-parse", "--is-inside-work-tree"], true);
const head = (await checked(["git", "rev-parse", "HEAD"], true)).stdout;

if (!options.allowDirty) {
  const unstaged = await exec(["git", "diff", "--quiet"]);
  const staged = await exec(["git", "diff", "--cached", "--quiet"]);
  if (unstaged.code !== 0 || staged.code !== 0) {
    throw new Error("tracked working-tree changes exist; commit them first or pass --allow-dirty");
  }
}

if (!options.buildOnly && !(await commandExists("gh"))) {
  throw new Error("gh CLI is required to publish releases");
}

console.log("==> Preparing repository");
await checked(["git", "submodule", "update", "--init", "--recursive"]);
const submodules = await exec([
  "git",
  "submodule",
  "foreach",
  "--recursive",
  "--quiet",
  "test -z \"$(git status --porcelain)\"",
]);
if (submodules.code !== 0 && !options.allowDirty) {
  throw new Error("a vendored submodule has local changes; commit/reset them or pass --allow-dirty");
}

if (!(await commandExists("unzip"))) throw new Error("unzip is required to assemble Chromium release bundles");
if (!(await commandExists("tar"))) throw new Error("tar is required to assemble release bundles");

console.log("==> Installing build dependencies");
await checked([process.execPath, "install"]);
const chromium = await chromiumInfo();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(STAGE, { recursive: true });
await mkdir(BUILD, { recursive: true });

console.log(`==> Building Kitty Browser ${tag}`);
console.log(`    commit ${head}`);
console.log(`    Bun ${Bun.version}`);
console.log(`    Chromium ${chromium.browserVersion} (Playwright revision ${chromium.revision})`);

const bundles: BuiltBundle[] = [];
for (const target of TARGETS) bundles.push(await buildBundle(target, chromium, version, head));

const checksumLines = bundles
  .map((bundle) => `${bundle.sha256}  ${bundle.archiveFilename}`)
  .join("\n");
await Bun.write(join(OUT, "SHA256SUMS"), `${checksumLines}\n`);

let repository: string | undefined;
if (!options.buildOnly) {
  await checked(["gh", "auth", "status"]);
  repository = (await checked(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], true)).stdout;
}

const manifest = {
  schemaVersion: 2,
  name: "kitty-browser",
  version,
  tag,
  commit: head,
  builtAt: new Date().toISOString(),
  bunVersion: Bun.version,
  ...(repository ? { repository } : {}),
  chromium: {
    bundled: true,
    source: "playwright",
    revision: chromium.revision,
    browserVersion: chromium.browserVersion,
  },
  bundles: bundles.map((bundle) => ({
    id: bundle.id,
    os: bundle.os,
    arch: bundle.arch,
    bunTarget: bundle.bunTarget,
    archive: bundle.archiveFilename,
    bytes: bundle.bytes,
    sha256: bundle.sha256,
    chromium: {
      browserArch: bundle.browserArch,
      archive: bundle.browserArchive,
      executable: ["chromium", ...bundle.browserExecutable].join("/"),
    },
  })),
};
await Bun.write(
  join(OUT, "kitty-browser-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

for (const installer of ["kitty-browser.sh", "kitty-browser.ps1"]) {
  await copyFile(join(ROOT, "bootstrap", installer), join(OUT, installer));
}

const notesPath = join(OUT, "release-notes.md");
await Bun.write(notesPath, `# Kitty Browser ${tag}\n\nSelf-contained Kitty Browser bundles for supported 64-bit Linux, macOS and Windows targets. Each archive includes the standalone Kitty Browser executable, Bun runtime and full Playwright Chromium ${chromium.browserVersion} (revision ${chromium.revision}).\n\n- Commit: \`${head}\`\n- Bun: \`${Bun.version}\`\n- Chromium: \`${chromium.browserVersion}\` / Playwright revision \`${chromium.revision}\`\n- SHA-256 checksums: \`SHA256SUMS\` and per-bundle \`.sha256\` assets\n- Machine-readable selector data: \`kitty-browser-manifest.json\`\n\nWindows ARM64 uses a native ARM64 Kitty Browser executable with Playwright's supported win64 Chromium build. Linux bundles target glibc systems; Playwright Chromium is not a musl/Alpine build.\n`);

await rm(STAGE, { recursive: true, force: true });
await rm(BUILD, { recursive: true, force: true });

console.log(`\n==> Bundles ready in ${OUT}`);

if (options.buildOnly) {
  console.log("==> Build-only mode; skipping GitHub upload");
  process.exit(0);
}

const remoteTag = await exec(["git", "ls-remote", "origin", `refs/tags/${tag}`], true);
if (remoteTag.code !== 0) throw new Error(`could not query origin for tag ${tag}`);
if (remoteTag.stdout) {
  const remoteSha = remoteTag.stdout.split(/\s+/u)[0];
  if (remoteSha && remoteSha !== head) {
    throw new Error(`remote tag ${tag} already points to ${remoteSha}, not current HEAD ${head}`);
  }
}

const releaseExists = (await exec(["gh", "release", "view", tag], true)).code === 0;
if (!releaseExists) {
  const create = [
    "gh",
    "release",
    "create",
    tag,
    "--target",
    head,
    "--title",
    `Kitty Browser ${tag}`,
    "--notes-file",
    notesPath,
  ];
  if (options.draft) create.push("--draft");
  if (options.prerelease) create.push("--prerelease");
  else if (!options.draft) create.push("--latest");
  console.log(`\n==> Creating GitHub Release ${tag}`);
  await checked(create);
} else {
  console.log(`\n==> GitHub Release ${tag} already exists; assets will be replaced`);
}

const uploadPaths = [
  ...bundles.flatMap((bundle) => [
    join(OUT, bundle.archiveFilename),
    join(OUT, `${bundle.archiveFilename}.sha256`),
  ]),
  join(OUT, "SHA256SUMS"),
  join(OUT, "kitty-browser-manifest.json"),
  join(OUT, "kitty-browser.sh"),
  join(OUT, "kitty-browser.ps1"),
];

console.log("==> Uploading release assets");
for (const path of uploadPaths) {
  await checked(["gh", "release", "upload", tag, path, "--clobber"]);
}

console.log(`\nRelease complete: ${repository}@${tag}`);
