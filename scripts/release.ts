#!/usr/bin/env bun

import { chmod, copyFile, mkdir, open, rename, rm } from "node:fs/promises";
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

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
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
const MIB = 1024 * 1024;

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

const formatBytes = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

class ReleaseProgress {
  readonly #total: number;
  readonly #tty = Boolean(process.stderr.isTTY);
  #completed = 0;
  #label = "starting";
  #detail = "";
  #subprogress = 0;
  #stepStarted = performance.now();
  #lastRender = 0;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #spinner = 0;

  constructor(total: number) {
    this.#total = Math.max(1, total);
  }

  begin(label: string): void {
    this.#stopTicker();
    this.#label = label;
    this.#detail = "";
    this.#subprogress = 0;
    this.#stepStarted = performance.now();
    this.#spinner = 0;

    if (this.#tty) {
      this.render(true);
      this.#ticker = setInterval(() => {
        this.#spinner += 1;
        this.render(false);
      }, 250);
      this.#ticker.unref?.();
    } else {
      process.stderr.write(`[${this.#completed}/${this.#total}] ${label}\n`);
    }
  }

  update(detail: string, subprogress?: number): void {
    this.#detail = detail;
    if (subprogress !== undefined && Number.isFinite(subprogress)) {
      this.#subprogress = Math.max(0, Math.min(1, subprogress));
    }
    this.render(false);
  }

  complete(detail = "done"): void {
    this.#detail = detail;
    this.#subprogress = 1;
    this.#stopTicker();
    this.#completed = Math.min(this.#total, this.#completed + 1);

    if (this.#tty) {
      this.#subprogress = 0;
      this.render(true);
    } else {
      process.stderr.write(`    -> ${detail}\n`);
    }
  }

  async step<T>(label: string, work: () => Promise<T>, done = "done"): Promise<T> {
    this.begin(label);
    try {
      const result = await work();
      this.complete(done);
      return result;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  fail(error: unknown): void {
    this.#stopTicker();
    if (this.#tty) process.stderr.write("\r\x1b[2K");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FAILED: ${this.#label}: ${message}\n`);
  }

  finish(): void {
    this.#stopTicker();
    this.#completed = this.#total;
    this.#label = "release build complete";
    this.#detail = "";
    this.#subprogress = 0;
    this.#stepStarted = performance.now();
    if (this.#tty) {
      this.render(true);
      process.stderr.write("\n");
    }
  }

  render(force: boolean): void {
    if (!this.#tty) return;
    const now = performance.now();
    if (!force && now - this.#lastRender < 100) return;
    this.#lastRender = now;

    const fractionalSteps = this.#completed + this.#subprogress;
    const fraction = Math.max(0, Math.min(1, fractionalSteps / this.#total));
    const percentage = fraction * 100;
    const columns = Math.max(60, process.stderr.columns ?? 120);
    const barWidth = Math.max(12, Math.min(30, Math.floor(columns * 0.24)));
    const filled = Math.max(0, Math.min(barWidth, Math.round(fraction * barWidth)));
    const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
    const spinner = ["|", "/", "-", "\\"][this.#spinner % 4]!;
    const elapsed = formatDuration((now - this.#stepStarted) / 1000);
    const detail = this.#detail ? ` · ${this.#detail}` : "";
    const raw = `[${bar}] ${percentage.toFixed(1).padStart(5)}% ${String(this.#completed).padStart(2)}/${this.#total} ${spinner} ${this.#label}${detail} · ${elapsed}`;
    const line = raw.length >= columns ? `${raw.slice(0, Math.max(1, columns - 2))}…` : raw;
    process.stderr.write(`\r\x1b[2K${line}`);
  }

  #stopTicker(): void {
    if (!this.#ticker) return;
    clearInterval(this.#ticker);
    this.#ticker = undefined;
  }
}

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

The builder uses one live progress/status bar on an interactive terminal (including tmux).
Non-interactive output falls back to ordinary per-step progress lines. Each target archive
contains Kitty Browser, the Bun runtime and the exact Chromium revision pinned by Playwright.`);
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
    if (arg === "--draft") out.draft = true;
    else if (arg === "--prerelease") out.prerelease = true;
    else if (arg === "--build-only") out.buildOnly = true;
    else if (arg === "--allow-dirty") out.allowDirty = true;
    else if (arg === "--help" || arg === "-h") help(0);
    else throw new Error(`unknown release-builder argument: ${arg}`);
  }

  return out;
};

const exec = async (command: readonly string[]): Promise<ExecResult> => {
  const child = Bun.spawn([...command], {
    cwd: ROOT,
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = child.stdout ? new Response(child.stdout).text() : Promise.resolve("");
  const stderrPromise = child.stderr ? new Response(child.stderr).text() : Promise.resolve("");
  const code = await child.exited;
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const checked = async (command: readonly string[]): Promise<ExecResult> => {
  const result = await exec(command);
  if (result.code === 0) return result;
  const details = result.stderr || result.stdout;
  throw new Error(`${command.join(" ")} failed with exit code ${result.code}${details ? `\n${details}` : ""}`);
};

const commandExists = async (command: string): Promise<boolean> =>
  (await exec(["sh", "-lc", `command -v ${command} >/dev/null 2>&1`])).code === 0;

const assertSupportedBun = (): void => {
  const [major = 0, minor = 0] = Bun.version.split(".").map((part) => Number.parseInt(part, 10));
  if (major > MIN_BUN_MAJOR || (major === MIN_BUN_MAJOR && minor >= MIN_BUN_MINOR)) return;
  throw new Error(`release builder requires Bun >= ${MIN_BUN_MAJOR}.${MIN_BUN_MINOR}.0; found ${Bun.version}`);
};

const chromiumInfo = async (): Promise<ChromiumInfo> => {
  const data = await Bun.file(BROWSERS_JSON).json() as {
    browsers?: Array<{ name?: string; revision?: string; browserVersion?: string }>;
  };
  const chromium = data.browsers?.find((browser) => browser.name === "chromium");
  if (!chromium?.revision || !chromium.browserVersion) {
    throw new Error(`could not read Chromium revision/version from ${BROWSERS_JSON}`);
  }
  return { revision: chromium.revision, browserVersion: chromium.browserVersion };
};

const sha256File = async (path: string, progress: ReleaseProgress): Promise<string> => {
  const file = Bun.file(path);
  const total = Math.max(1, file.size);
  const hasher = new Bun.CryptoHasher("sha256");
  let read = 0;
  for await (const chunk of file.stream()) {
    hasher.update(chunk);
    read += chunk.byteLength;
    progress.update(`${formatBytes(read)} / ${formatBytes(total)}`, read / total);
  }
  return hasher.digest("hex");
};

const writeChunk = async (
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("download file write made no progress");
    offset += bytesWritten;
  }
};

const downloadChromium = async (
  info: ChromiumInfo,
  archiveName: string,
  progress: ReleaseProgress,
): Promise<string> => {
  await mkdir(CHROMIUM_CACHE, { recursive: true });
  const cached = join(CHROMIUM_CACHE, `${info.revision}-${archiveName}`);
  if (await Bun.file(cached).exists()) {
    progress.update(`cached · ${formatBytes(Bun.file(cached).size)}`, 1);
    return cached;
  }

  const temporary = `${cached}.tmp`;
  await rm(temporary, { force: true });
  const relative = `builds/chromium/${info.revision}/${archiveName}`;
  let lastError = "";

  for (let mirrorIndex = 0; mirrorIndex < PLAYWRIGHT_CDN_MIRRORS.length; mirrorIndex += 1) {
    const mirror = PLAYWRIGHT_CDN_MIRRORS[mirrorIndex]!;
    const url = `${mirror}/${relative}`;
    progress.update(`connecting to mirror ${mirrorIndex + 1}/${PLAYWRIGHT_CDN_MIRRORS.length}`, 0);

    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        lastError = `${response.status} ${response.statusText}`;
        continue;
      }

      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
      const reader = response.body.getReader();
      const handle = await open(temporary, "w");
      const started = performance.now();
      let downloaded = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeChunk(handle, value);
          downloaded += value.byteLength;

          const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
          const speed = downloaded / elapsedSeconds;
          if (total) {
            const fraction = Math.min(1, downloaded / total);
            const eta = speed > 0 ? (total - downloaded) / speed : Number.NaN;
            progress.update(
              `${(fraction * 100).toFixed(1)}% · ${formatBytes(downloaded)} / ${formatBytes(total)} · ${(speed / MIB).toFixed(1)} MiB/s · ETA ${formatDuration(eta)}`,
              fraction,
            );
          } else {
            progress.update(
              `${formatBytes(downloaded)} · ${(speed / MIB).toFixed(1)} MiB/s · elapsed ${formatDuration(elapsedSeconds)}`,
            );
          }
        }
      } finally {
        await handle.close();
      }

      await rename(temporary, cached);
      progress.update(`downloaded · ${formatBytes(downloaded)}`, 1);
      return cached;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await rm(temporary, { force: true });
    }
  }

  throw new Error(`failed to download Playwright Chromium ${archiveName}: ${lastError || "all mirrors failed"}`);
};

const compileTarget = async (target: ReleaseTarget, executable: string): Promise<void> => {
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
  progress: ReleaseProgress,
): Promise<BuiltBundle> => {
  const bundleDir = join(STAGE, target.id);
  const buildDir = join(BUILD, target.id);
  const executableName = target.os === "windows" ? "kitty-browser.exe" : "kitty-browser";
  const builtExecutable = join(buildDir, executableName);
  const bundledExecutable = join(bundleDir, executableName);
  const chromiumDir = join(bundleDir, "chromium");

  await progress.step(`${target.id} · compile`, async () => {
    await rm(bundleDir, { recursive: true, force: true });
    await rm(buildDir, { recursive: true, force: true });
    await mkdir(chromiumDir, { recursive: true });
    await compileTarget(target, builtExecutable);
  }, target.bunTarget);

  await progress.step(`${target.id} · stage executable`, async () => {
    await copyFile(builtExecutable, bundledExecutable);
    if (target.os !== "windows") await chmod(bundledExecutable, 0o755);
  });

  const chromiumZip = await progress.step(`${target.id} · Chromium`, async () =>
    downloadChromium(info, target.browserArchive, progress));

  await progress.step(`${target.id} · unpack Chromium`, async () => {
    await checked(["unzip", "-q", "-o", chromiumZip, "-d", chromiumDir]);
    const browserExecutable = join(chromiumDir, ...target.browserExecutable);
    if (!(await Bun.file(browserExecutable).exists())) {
      throw new Error(`Chromium archive ${target.browserArchive} did not contain ${target.browserExecutable.join("/")}`);
    }
    if (target.os !== "windows") await chmod(browserExecutable, 0o755).catch(() => undefined);
  });

  await progress.step(`${target.id} · bundle metadata`, async () => {
    await Bun.write(join(bundleDir, "kitty-browser-bundle.json"), `${JSON.stringify({
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
    }, null, 2)}\n`);
  });

  const archiveFilename = `kitty-browser-${target.id}.tar.gz`;
  const archivePath = join(OUT, archiveFilename);
  await progress.step(`${target.id} · archive`, async () => {
    await rm(archivePath, { force: true });
    await checked(["tar", "-czf", archivePath, "-C", bundleDir, "."]);
  });

  let sha256 = "";
  await progress.step(`${target.id} · SHA-256`, async () => {
    sha256 = await sha256File(archivePath, progress);
    await Bun.write(`${archivePath}.sha256`, `${sha256}  ${archiveFilename}\n`);
  }, formatBytes(Bun.file(archivePath).size));

  const archive = Bun.file(archivePath);
  return { ...target, archiveFilename, bytes: archive.size, sha256 };
};

const main = async (): Promise<void> => {
  assertSupportedBun();
  const options = parseOptions(process.argv.slice(2));
  const pkg = await Bun.file(PACKAGE_PATH).json() as { version?: string };
  if (!pkg.version) throw new Error("package.json has no version");
  const tag = options.tag ?? `v${pkg.version}`;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;

  const buildSteps = 7 + TARGETS.length * 7 + 4;
  const uploadCount = TARGETS.length * 2 + 4;
  const publishSteps = options.buildOnly ? 0 : 3 + uploadCount;
  const progress = new ReleaseProgress(buildSteps + publishSteps);

  const head = await progress.step("verify Git repository", async () => {
    await checked(["git", "rev-parse", "--is-inside-work-tree"]);
    return (await checked(["git", "rev-parse", "HEAD"])).stdout;
  });

  await progress.step("check working tree", async () => {
    if (options.allowDirty) return;
    const [unstaged, staged] = await Promise.all([
      exec(["git", "diff", "--quiet"]),
      exec(["git", "diff", "--cached", "--quiet"]),
    ]);
    if (unstaged.code !== 0 || staged.code !== 0) {
      throw new Error("tracked working-tree changes exist; commit them first or pass --allow-dirty");
    }
  }, options.allowDirty ? "allowed" : "clean");

  await progress.step("check required tools", async () => {
    for (const command of ["git", "unzip", "tar"]) {
      if (!(await commandExists(command))) throw new Error(`${command} is required by the release builder`);
    }
    if (!options.buildOnly && !(await commandExists("gh"))) {
      throw new Error("gh CLI is required to publish releases");
    }
  });

  await progress.step("update submodules", async () => {
    await checked(["git", "submodule", "update", "--init", "--recursive"]);
  });

  await progress.step("check submodules", async () => {
    if (options.allowDirty) return;
    const result = await exec([
      "git",
      "submodule",
      "foreach",
      "--recursive",
      "--quiet",
      "test -z \"$(git status --porcelain)\"",
    ]);
    if (result.code !== 0) throw new Error("a vendored submodule has local changes");
  }, options.allowDirty ? "allowed" : "clean");

  await progress.step("install build dependencies", async () => {
    await checked([process.execPath, "install"]);
  });

  const info = await progress.step("prepare release workspace", async () => {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(STAGE, { recursive: true });
    await mkdir(BUILD, { recursive: true });
    return await chromiumInfo();
  });

  const bundles: BuiltBundle[] = [];
  for (const target of TARGETS) {
    bundles.push(await buildBundle(target, info, version, head, progress));
  }

  await progress.step("write SHA256SUMS", async () => {
    await Bun.write(
      join(OUT, "SHA256SUMS"),
      `${bundles.map((bundle) => `${bundle.sha256}  ${bundle.archiveFilename}`).join("\n")}\n`,
    );
  });

  let repository: string | undefined;
  if (!options.buildOnly) {
    repository = await progress.step("GitHub authentication", async () => {
      await checked(["gh", "auth", "status"]);
      return (await checked(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).stdout;
    });
  }

  await progress.step("write release manifest", async () => {
    await Bun.write(join(OUT, "kitty-browser-manifest.json"), `${JSON.stringify({
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
        revision: info.revision,
        browserVersion: info.browserVersion,
      },
      bundles: bundles.map((bundle) => ({
        id: bundle.id,
        os: bundle.os,
        arch: bundle.arch,
        bunTarget: bundle.bunTarget,
        archive: bundle.archiveFilename,
        bytes: bundle.bytes,
        sha256: bundle.sha256,
        chromiumArch: bundle.browserArch,
        chromiumExecutable: ["chromium", ...bundle.browserExecutable].join("/"),
      })),
    }, null, 2)}\n`);
  });

  await progress.step("copy bootstrap scripts", async () => {
    for (const bootstrap of ["kitty-browser.sh", "kitty-browser.ps1"]) {
      await copyFile(join(ROOT, "bootstrap", bootstrap), join(OUT, bootstrap));
    }
  });

  const notesPath = join(OUT, "release-notes.md");
  await Bun.write(notesPath, `# Kitty Browser ${tag}\n\nSelf-contained Kitty Browser bundles with Bun and Chromium.\n\n- Commit: \`${head}\`\n- Bun: \`${Bun.version}\`\n- Chromium: \`${info.browserVersion}\` / Playwright revision \`${info.revision}\`\n- SHA-256: \`SHA256SUMS\` and per-bundle \`.sha256\` assets\n- Selector metadata: \`kitty-browser-manifest.json\`\n\nWindows ARM64 uses a native ARM64 Kitty Browser executable with Playwright's x64 Chromium under Windows x64 emulation.\n`);

  await progress.step("clean staging files", async () => {
    await rm(STAGE, { recursive: true, force: true });
    await rm(BUILD, { recursive: true, force: true });
  });

  if (options.buildOnly) {
    progress.finish();
    console.log(`Artifacts ready: ${OUT}`);
    console.log(`Commit: ${head}`);
    console.log(`Chromium: ${info.browserVersion} / Playwright revision ${info.revision}`);
    return;
  }

  await progress.step("validate remote tag", async () => {
    const remoteTag = await exec(["git", "ls-remote", "origin", `refs/tags/${tag}`]);
    if (remoteTag.code !== 0) throw new Error(`could not query origin for tag ${tag}`);
    if (!remoteTag.stdout) return;
    const remoteSha = remoteTag.stdout.split(/\s+/u)[0];
    if (remoteSha && remoteSha !== head) {
      throw new Error(`remote tag ${tag} already points to ${remoteSha}, not current HEAD ${head}`);
    }
  });

  await progress.step("create/update GitHub Release", async () => {
    const releaseExists = (await exec(["gh", "release", "view", tag])).code === 0;
    if (releaseExists) return;
    const create = [
      "gh", "release", "create", tag,
      "--target", head,
      "--title", `Kitty Browser ${tag}`,
      "--notes-file", notesPath,
    ];
    if (options.draft) create.push("--draft");
    if (options.prerelease) create.push("--prerelease");
    else if (!options.draft) create.push("--latest");
    await checked(create);
  });

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

  for (const path of uploadPaths) {
    const filename = path.split(/[\\/]/u).at(-1) ?? path;
    await progress.step(`upload · ${filename}`, async () => {
      await checked(["gh", "release", "upload", tag, path, "--clobber"]);
    });
  }

  progress.finish();
  console.log(`Release complete: ${repository}@${tag}`);
  console.log(`Commit: ${head}`);
  console.log(`Chromium: ${info.browserVersion} / Playwright revision ${info.revision}`);
};

await main();
