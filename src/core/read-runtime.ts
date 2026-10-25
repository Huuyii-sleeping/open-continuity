import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import type { MemoryStore } from "./memory-store.js";

export const READ_RUNTIME_VERSION = "bounded-reads-v1" as const;
const policySchema = z.object({
  defaultTimeoutMs: z.number().int().min(10).max(30000).default(1500),
  maxConcurrentRequests: z.number().int().min(1).max(256).default(16),
  maxPendingReads: z.number().int().min(1).max(256).default(8),
}).strict();
export type ReadRuntimePolicy = z.input<typeof policySchema>;
export type ReadOperation = "recall" | "context" | "query" | "history" | "handoff_resume";
type ReadStage = "lookup" | "list" | "candidates" | "history" | "fact_group";
export interface ReadStageReceipt { stage: ReadStage; started: number; settled: number; failed: number; durationMs: number; }
export interface ReadRuntimeReceipt {
  version: typeof READ_RUNTIME_VERSION; operation: ReadOperation;
  outcome: "completed" | "timeout" | "busy" | "failed" | "closed";
  elapsedMs: number; readsStarted: number; activeRequests: number; pendingReads: number;
  stages: readonly Readonly<ReadStageReceipt>[];
}
export type ReadRuntimeObserver = (receipt: Readonly<ReadRuntimeReceipt>) => void;

export class ReadTimeoutError extends OpenContinuityError {
  constructor() { super("READ_TIMEOUT", "Read execution budget exhausted", 504); }
}

/** Monotonic cooperative deadline. It cannot interrupt synchronous SQL or cancel a driver. */
export class ReadDeadline {
  private readonly deadline: number;
  private stopped = false;
  readsStarted = 0;
  readonly stages = new Map<ReadStage, ReadStageReceipt>();
  constructor(timeoutMs: number, private readonly clock: () => number = performance.now.bind(performance)) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid read deadline", 400);
    this.deadline = this.clock() + timeoutMs;
  }
  expired() { return this.stopped || this.clock() >= this.deadline; }
  stop() { this.stopped = true; }
  check() { if (this.expired()) throw new ReadTimeoutError(); }
  async wait<T>(start: () => T | Promise<T>): Promise<T> {
    this.check();
    // Check after invoking the thunk too: a synchronous operation may block past its deadline.
    const operation = Promise.resolve().then(() => { this.check(); return start(); });
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadTimeoutError()), Math.max(0, this.deadline - this.clock()));
      })]);
      this.check();
      return result;
    } catch (error) {
      if (error instanceof ReadTimeoutError) this.stop();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
}

/** Per-service admission, no queue/retry. Timed-out driver work retains its slot until settlement. */
export class ReadRuntime {
  private readonly policy;
  private readonly scopes = new AsyncLocalStorage<ReadDeadline>();
  private activeRequests = 0;
  private pendingReads = 0;
  private activeWrites = 0;
  private closing = false;
  constructor(policy: ReadRuntimePolicy = {}, private readonly observer?: ReadRuntimeObserver) {
    const parsed = policySchema.safeParse(policy);
    if (!parsed.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid read runtime policy", 400);
    this.policy = Object.freeze(parsed.data);
  }
  capabilities() {
    return { version: READ_RUNTIME_VERSION, ...this.policy, admission: "reject_without_queue" as const,
      cancellation: "cooperative_deadline" as const, driverCancellation: false as const,
      timedOutReadsRetainSlots: true as const, scope: "per_service_instance" as const };
  }
  snapshot() { return { activeRequests: this.activeRequests, pendingReads: this.pendingReads, activeWrites: this.activeWrites, closing: this.closing }; }
  deadline() { return this.scopes.getStore(); }
  assertOpen() { if (this.closing) throw new OpenContinuityError("RUNTIME_CLOSED", "Memory runtime is closing", 503); }
  beginClose() {
    this.closing = true;
    if (this.pendingReads || this.activeRequests || this.activeWrites) throw new OpenContinuityError("RUNTIME_BUSY", "Operations are still draining; retry close after settlement", 503);
  }
  private emit(receipt: ReadRuntimeReceipt) {
    // Observability is optional, synchronous and metadata-only; observer failures must not alter results.
    try {
      const pending: unknown = this.observer?.(Object.freeze(receipt));
      // A caller may supply an async callback despite the void contract. Observe its rejection too.
      if (pending && typeof pending === "object" && "then" in pending) void Promise.resolve(pending).catch(() => {});
    } catch { /* best-effort observer */ }
  }
  async run<T>(operation: ReadOperation, start: () => Promise<T>, timeoutMs = this.policy.defaultTimeoutMs,
    allowTimeoutResult = false): Promise<T> {
    const started = performance.now();
    const scope = new ReadDeadline(timeoutMs);
    let outcome: ReadRuntimeReceipt["outcome"] = "completed";
    let admitted = false;
    try {
      this.assertOpen();
      if (this.activeRequests >= this.policy.maxConcurrentRequests || this.pendingReads >= this.policy.maxPendingReads) {
        throw new OpenContinuityError("RUNTIME_BUSY", "Read capacity is exhausted", 503);
      }
      admitted = true; this.activeRequests++;
      return await this.scopes.run(scope, async () => {
        // Query owns its structured timeout response. Store reads still share this same deadline.
        const result = allowTimeoutResult ? await start() : await scope.wait(start);
        if (scope.expired()) outcome = "timeout";
        return result;
      });
    } catch (error) {
      outcome = error instanceof ReadTimeoutError ? "timeout" : error instanceof OpenContinuityError
        && error.code === "RUNTIME_BUSY" ? "busy" : error instanceof OpenContinuityError
        && error.code === "RUNTIME_CLOSED" ? "closed" : "failed";
      throw error;
    } finally {
      scope.stop();
      if (admitted) this.activeRequests--;
      if (this.observer) this.emit({ version: READ_RUNTIME_VERSION, operation, outcome, elapsedMs: performance.now() - started,
        readsStarted: scope.readsStarted, ...this.snapshotCounts(),
        stages: Object.freeze([...scope.stages.values()].map(stage => Object.freeze({ ...stage }))) });
    }
  }
  private snapshotCounts() { return { activeRequests: this.activeRequests, pendingReads: this.pendingReads }; }
  async write<T>(start: () => T | Promise<T>): Promise<T> {
    this.assertOpen(); this.activeWrites++;
    try { return await start(); } finally { this.activeWrites--; }
  }
  private async read<T>(stage: ReadStage, start: () => T | Promise<T>): Promise<T> {
    const scope = this.scopes.getStore();
    if (!scope) throw new OpenContinuityError("INTERNAL_ERROR", "Read requires an execution scope", 500);
    return scope.wait(() => {
      if (this.pendingReads >= this.policy.maxPendingReads) throw new OpenContinuityError("RUNTIME_BUSY", "Read capacity is exhausted", 503);
      this.pendingReads++; scope.readsStarted++;
      const stats = this.observer ? scope.stages.get(stage) ?? { stage, started: 0, settled: 0, failed: 0, durationMs: 0 } : undefined;
      if (stats) { stats.started++; scope.stages.set(stage, stats); }
      const started = stats ? performance.now() : 0;
      // Release on actual settlement, NOT on the timeout of wait(). Observe late rejections too.
      return Promise.resolve().then(() => { scope.check(); return start(); })
        .catch(error => { if (stats) stats.failed++; throw error; })
        .finally(() => { this.pendingReads--; if (stats) { stats.settled++; stats.durationMs += performance.now() - started; } });
    });
  }
  guard(store: MemoryStore): MemoryStore {
    return {
      appendRemember: input => store.appendRemember(input), appendForget: (...args) => store.appendForget(...args),
      recall: input => this.read("lookup", () => store.recall(input)), history: input => this.read("history", () => store.history(input)),
      ...(store.list ? { list: input => this.read("list", () => store.list!(input)) } : {}),
      ...(store.searchCandidates ? { searchCandidates: input => this.read("candidates", () => store.searchCandidates!(input)) } : {}),
      ...(store.readFactGroup ? { readFactGroup: input => this.read("fact_group", () => store.readFactGroup!(input)) } : {}),
      ...(store.close ? { close: () => store.close!() } : {}),
    };
  }
}
