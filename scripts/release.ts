#!/usr/bin/env bun

import { mkdir, rm, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";

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
  readonly libc?: "glibc" | "musl";
  readonly bunTarget: Bun.Build.CompileTarget;
  readonly filename: string;
}

interface BuiltAsset extends ReleaseTarget {
  readonly bytes: number;
  readonly sha256: string;
}

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "dist", "release");
const PACKAGE_PATH = join(ROOT, "package.json");

const TARGETS: readonly ReleaseTarget[] = [
  {
    id: "linux-x64",
    os: "linux",
    arch: "x64",
    libc: "glibc",
    bunTarget: "bun-linux-x64-baseline",
    filename: "kitty-browser-linux-x64",
  },
  {
    id: "linux-arm64",
    os: "linux",
    arch: "arm64",
    libc: "glibc",
    bunTarget: "bun-linux-arm64",
    filename: "kitty-browser-linux-arm64",
  },
  {
    id: "linux-x64-musl",
    os: "linux",
    arch: "x64",
    libc: "musl",
    bunTarget: "bun-linux-x64-musl",
    filename: "kitty-browser-linux-x64-musl",
  },
  {
    id: "linux-arm64-musl",
    os: "linux",
    arch: "arm64",
    libc: "musl",
    bunTarget: "bun-linux-arm64-musl",
    filename: "kitty-browser-linux-arm64-musl",
  },
  {
    id: "darwin-x64",
    os: "darwin",
    arch: "x64",
    bunTarget: "bun-darwin-x64-baseline",
    filename: "kitty-browser-darwin-x64",
  },
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    filename: "kitty-browser-darwin-arm64",
  },
  {
    id: "windows-x64",
    os: "windows",
    arch: "x64",
    bunTarget: "bun-windows-x64-baseline",
    filename: "kitty-browser-windows-x64.exe",
  },
  {
    id: "windows-arm64",
    os: "windows",
    arch: "arm64",
    bunTarget: "bun-windows-arm64",
    filename: "kitty-browser-windows-arm64.exe",
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
  --build-only      Build artifacts and manifest without uploading
  --allow-dirty     Permit tracked working-tree changes
  -h, --help        Show this help

Default output:
  dist/release/

The normal command builds every supported target, writes SHA-256 checksums and a
machine-readable manifest, then creates/updates the matching GitHub Release using gh.`);
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

const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
};

const buildTarget = async (target: ReleaseTarget): Promise<BuiltAsset> => {
  const outfile = join(OUT, target.filename);
  console.log(`\n==> ${target.id} (${target.bunTarget})`);

  const result = await Bun.build({
    entrypoints: [join(ROOT, "src", "cli.ts")],
    compile: {
      target: target.bunTarget,
      outfile,
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

  const file = Bun.file(outfile);
  const sha256 = await sha256File(outfile);
  await Bun.write(`${outfile}.sha256`, `${sha256}  ${target.filename}\n`);

  console.log(`    ${target.filename}`);
  console.log(`    ${(file.size / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`    sha256 ${sha256}`);

  return {
    ...target,
    bytes: file.size,
    sha256,
  };
};

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

console.log("==> Installing build dependencies");
await checked([process.execPath, "install"]);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

console.log(`==> Building Kitty Browser ${tag}`);
console.log(`    commit ${head}`);
console.log(`    Bun ${Bun.version}`);

const assets: BuiltAsset[] = [];
for (const target of TARGETS) assets.push(await buildTarget(target));

const checksumLines = assets
  .map((asset) => `${asset.sha256}  ${asset.filename}`)
  .join("\n");
await Bun.write(join(OUT, "SHA256SUMS"), `${checksumLines}\n`);

const repository = options.buildOnly
  ? undefined
  : (await checked(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], true)).stdout;

const manifest = {
  schemaVersion: 1,
  name: "kitty-browser",
  version,
  tag,
  commit: head,
  builtAt: new Date().toISOString(),
  bunVersion: Bun.version,
  ...(repository ? { repository } : {}),
  chromium: {
    bundled: false,
    strategy: "managed-runtime-planned",
  },
  binaries: assets.map((asset) => ({
    id: asset.id,
    os: asset.os,
    arch: asset.arch,
    ...(asset.libc ? { libc: asset.libc } : {}),
    bunTarget: asset.bunTarget,
    filename: asset.filename,
    bytes: asset.bytes,
    sha256: asset.sha256,
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
await Bun.write(notesPath, `# Kitty Browser ${tag}\n\nStandalone Bun executables for supported 64-bit Linux, macOS and Windows targets.\n\n- Commit: \`${head}\`\n- Bun: \`${Bun.version}\`\n- SHA-256 checksums: \`SHA256SUMS\` and per-binary \`.sha256\` assets\n- Machine-readable selector data: \`kitty-browser-manifest.json\`\n\nChromium is intentionally not embedded in these first-stage executable assets yet; the manifest reserves the runtime strategy field for the managed Chromium bootstrap layer.\n`);

console.log(`\n==> Artifacts ready in ${OUT}`);

if (options.buildOnly) {
  console.log("==> Build-only mode; skipping GitHub upload");
  process.exit(0);
}

if (!(await commandExists("gh"))) throw new Error("gh CLI is required to publish releases");
await checked(["gh", "auth", "status"]);

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
  ...assets.flatMap((asset) => [
    join(OUT, asset.filename),
    join(OUT, `${asset.filename}.sha256`),
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
