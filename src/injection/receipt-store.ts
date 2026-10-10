import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { continuityHome } from "../cli/config.js";
import type { InjectionReceipt } from "./types.js";

export interface InjectionReceiptPolicy {
  receiptRetentionDays: number;
  maxReceipts: number;
}

export function injectionReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(continuityHome(env), "injection-receipts.jsonl");
}

function cleanupMarkerPath(env: NodeJS.ProcessEnv): string {
  return join(continuityHome(env), "injection-receipts.cleanup");
}

function readReceiptLines(env: NodeJS.ProcessEnv): string[] {
  const path = injectionReceiptPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
}

export function injectionReceiptStatus(env: NodeJS.ProcessEnv = process.env): { path: string; exists: boolean; count: number; bytes: number; oldestAt?: string; latestAt?: string } {
  const path = injectionReceiptPath(env);
  if (!existsSync(path)) return { path, exists: false, count: 0, bytes: 0 };
  const created: string[] = [];
  const lines = readReceiptLines(env);
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as { createdAt?: unknown };
      if (typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))) created.push(new Date(value.createdAt).toISOString());
    } catch { /* malformed lines are counted but never surfaced */ }
  }
  created.sort();
  return {
    path,
    exists: true,
    count: lines.length,
    bytes: statSync(path).size,
    ...(created[0] ? { oldestAt: created[0] } : {}),
    ...(created.at(-1) ? { latestAt: created.at(-1)! } : {}),
  };
}

export function cleanupInjectionReceipts(
  env: NodeJS.ProcessEnv,
  policy: InjectionReceiptPolicy,
  now = Date.now(),
): { path: string; before: number; retained: number; deleted: number; invalidDeleted: number; cutoff: string } {
  const path = injectionReceiptPath(env);
  const cutoff = new Date(now - policy.receiptRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const lines = readReceiptLines(env);
  const retained: Array<{ line: string; createdAt: string }> = [];
  let invalidDeleted = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as { createdAt?: unknown };
      if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
        invalidDeleted += 1;
        continue;
      }
      const createdAt = new Date(value.createdAt).toISOString();
      if (createdAt >= cutoff) retained.push({ line, createdAt });
    } catch {
      invalidDeleted += 1;
    }
  }
  retained.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const bounded = retained.slice(-policy.maxReceipts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bounded.length ? bounded.map((entry) => entry.line).join("\n") + "\n" : "", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  writeFileSync(cleanupMarkerPath(env), new Date(now).toISOString() + "\n", { encoding: "utf8", mode: 0o600 });
  return { path, before: lines.length, retained: bounded.length, deleted: lines.length - bounded.length, invalidDeleted, cutoff };
}

function maybeCleanup(env: NodeJS.ProcessEnv, policy: InjectionReceiptPolicy): void {
  const marker = cleanupMarkerPath(env);
  try {
    if (existsSync(marker) && Date.now() - statSync(marker).mtimeMs < 24 * 60 * 60 * 1000) return;
    cleanupInjectionReceipts(env, policy);
  } catch {
    // Receipt retention must never make prompt processing fail.
  }
}

export function appendInjectionReceipt(env: NodeJS.ProcessEnv, receipt: InjectionReceipt, policy: InjectionReceiptPolicy): void {
  const path = injectionReceiptPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(receipt) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  maybeCleanup(env, policy);
}

export function purgeInjectionReceipts(env: NodeJS.ProcessEnv = process.env): { path: string; deleted: number } {
  const status = injectionReceiptStatus(env);
  if (existsSync(status.path)) unlinkSync(status.path);
  const marker = cleanupMarkerPath(env);
  if (existsSync(marker)) unlinkSync(marker);
  return { path: status.path, deleted: status.count };
}
