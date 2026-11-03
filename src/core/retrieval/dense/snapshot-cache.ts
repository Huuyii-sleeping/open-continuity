import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ParsedRecallInput } from "../../../shared/types.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { DenseMemoryReference } from "./index-contracts.js";

export interface DenseCachePolicy { maxBytes: number; maxEntries: number; ttlMs: number; }
export interface DenseVectorSnapshot {
  revision: string; references: DenseMemoryReference[]; vectors: Float32Array; normSquared: Float64Array;
  dimensions: number; bytes: number;
}
/** Contains approved vector projections, never memory values, queries or verification text. */
export class DenseSnapshotCache {
  private revision?: string;
  private readonly entries = new Map<string, { snapshot: DenseVectorSnapshot; timer: ReturnType<typeof setTimeout>; expires: number }>();
  readonly policy: Readonly<DenseCachePolicy>;
  constructor(policy: Partial<DenseCachePolicy> = {}, private readonly clock = performance.now.bind(performance)) {
    this.policy = Object.freeze({ maxBytes: 24 * 1024 * 1024, maxEntries: 2, ttlMs: 60000, ...policy });
    if (!Number.isInteger(this.policy.maxBytes) || this.policy.maxBytes < 0 || this.policy.maxBytes > 64 * 1024 * 1024
      || !Number.isInteger(this.policy.maxEntries) || this.policy.maxEntries < 1 || this.policy.maxEntries > 8
      || !Number.isInteger(this.policy.ttlMs) || this.policy.ttlMs < 1 || this.policy.ttlMs > 300000)
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense snapshot budget", 400);
  }
  key(input: ParsedRecallInput, revision: string, model: string, maximum: number) {
    if (revision !== this.revision) { this.clear(); this.revision = revision; }
    return createHash("sha256").update(JSON.stringify({ userId: input.userId, agentId: input.agentId, taskId: input.taskId ?? null,
      includePrivate: input.includePrivate, key: input.key ?? null, kind: input.kind ?? null, scope: input.scope ?? null,
      confirmation: true, revision, model, maximum })).digest("hex");
  }
  get(key: string): DenseVectorSnapshot | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.clock()) { this.remove(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry); return entry.snapshot;
  }
  put(key: string, snapshot: DenseVectorSnapshot): boolean {
    if (snapshot.bytes > this.policy.maxBytes || !this.policy.maxBytes) return false;
    if (this.entries.get(key)?.snapshot === snapshot) return true;
    this.remove(key);
    while (this.entries.size >= this.policy.maxEntries || this.status().bytes + snapshot.bytes > this.policy.maxBytes)
      this.remove(this.entries.keys().next().value!);
    const timer = setTimeout(() => this.remove(key), this.policy.ttlMs); timer.unref();
    this.entries.set(key, { snapshot, timer, expires: this.clock() + this.policy.ttlMs }); return true;
  }
  status() { return { entries: this.entries.size, bytes: [...this.entries.values()].reduce((sum, entry) => sum + entry.snapshot.bytes, 0), ...this.policy }; }
  private remove(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    clearTimeout(entry.timer); entry.snapshot.vectors.fill(0); entry.snapshot.normSquared.fill(0); this.entries.delete(key);
  }
  clear() { for (const key of [...this.entries.keys()]) this.remove(key); this.revision = undefined; }
}
