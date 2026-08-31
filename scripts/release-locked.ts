#!/usr/bin/env bun

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const LOCK_DIR = join(DIST, ".kitty-browser-release.lock");
const OWNER_PATH = join(LOCK_DIR, "owner.json");

interface LockOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly cwd: string;
}

const processAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readOwner = async (): Promise<LockOwner | undefined> => {
  try {
    const raw = await readFile(OWNER_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string" || typeof parsed.cwd !== "string") {
      return undefined;
    }
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
};

const acquire = async (): Promise<void> => {
  await mkdir(DIST, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(LOCK_DIR);
      const owner: LockOwner = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cwd: process.cwd(),
      };
      await writeFile(OWNER_PATH, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      // Give a concurrently-starting owner a moment to write owner.json before
      // deciding whether an existing lock is stale.
      await Bun.sleep(150);
      const owner = await readOwner();
      if (owner && processAlive(owner.pid)) {
        throw new Error(
          `another Kitty Browser release builder is already running (pid ${owner.pid}, started ${owner.startedAt})`,
        );
      }

      await rm(LOCK_DIR, { recursive: true, force: true });
    }
  }

  throw new Error("could not acquire Kitty Browser release-builder lock");
};

let ownsLock = false;
const releaseLock = (): void => {
  if (!ownsLock) return;
  ownsLock = false;
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Best effort during process shutdown. A stale lock is recovered on next run.
  }
};

await acquire();
ownsLock = true;

process.once("exit", releaseLock);
process.once("SIGINT", () => {
  releaseLock();
  process.exit(130);
});
process.once("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});
process.once("SIGHUP", () => {
  releaseLock();
  process.exit(129);
});

try {
  await import("./release.ts");
} finally {
  releaseLock();
}
