import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { continuityHome } from "../cli/config.js";
import { OpenContinuityError } from "../shared/errors.js";

interface LockRecord { pid: number; createdAt: string; }

export interface CaptureLock { path: string; release(): void; }

function readLock(path: string): LockRecord | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as LockRecord; } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export function captureLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(continuityHome(env), "capture.lock");
}

export function acquireCaptureLock(env: NodeJS.ProcessEnv = process.env): CaptureLock {
  const path = captureLockPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readLock(path);
    if (existing && processIsAlive(existing.pid)) {
      throw new OpenContinuityError("CAPTURE_ALREADY_RUNNING", "Capture service is already running (pid " + existing.pid + ")", 409, { path, pid: existing.pid });
    }
    try { unlinkSync(path); } catch { throw new OpenContinuityError("CAPTURE_ALREADY_RUNNING", "Unable to clear the stale capture lock", 409, { path }); }
    fd = openSync(path, "wx", 0o600);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() } satisfies LockRecord));
  closeSync(fd);
  let released = false;
  return { path, release: () => {
    if (released) return;
    released = true;
    if (readLock(path)?.pid === process.pid) { try { unlinkSync(path); } catch { /* best effort during shutdown */ } }
  } };
}

export function captureLockStatus(env: NodeJS.ProcessEnv = process.env): { path: string; locked: boolean; pid?: number; createdAt?: string } {
  const path = captureLockPath(env);
  const record = readLock(path);
  if (!record) return { path, locked: false };
  if (!processIsAlive(record.pid)) { try { unlinkSync(path); } catch { /* status is read-only */ } return { path, locked: false }; }
  return { path, locked: true, pid: record.pid, createdAt: record.createdAt };
}
