import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { OpenContinuityError } from "../../shared/errors.js";
import type { MemoryStore } from "../memory/contracts.js";
import type { ReadStage } from "./contracts.js";
import { READ_RUNTIME_VERSION, type ReadOperation, type ReadRuntimeObserver, type ReadRuntimeReceipt } from "./contracts.js";
import { ReadDeadline, ReadTimeoutError } from "./deadline.js";
import { emitReadReceipt } from "./observer.js";
import { resolveReadRuntimePolicy, type ReadRuntimePolicy } from "./policy.js";
import { guardMemoryStore } from "./store-guard.js";
export type { ReadStageReceipt } from "./contracts.js";
export { ReadDeadline, ReadTimeoutError } from "./deadline.js";

export { READ_RUNTIME_VERSION, type ReadOperation, type ReadRuntimeObserver, type ReadRuntimeReceipt } from "./contracts.js";
export type { ReadRuntimePolicy } from "./policy.js";
/** Per-service admission, no queue/retry. Timed-out driver work retains its slot until settlement. */
export class ReadRuntime {
  private readonly policy;
  private readonly scopes = new AsyncLocalStorage<ReadDeadline>();
  private activeRequests = 0;
  private pendingReads = 0;
  private activeWrites = 0;
  private closing = false;
  constructor(policy: ReadRuntimePolicy = {}, private readonly observer?: ReadRuntimeObserver) {
    this.policy = resolveReadRuntimePolicy(policy);
  }
  capabilities() {
    return {
      version: READ_RUNTIME_VERSION, ...this.policy, admission: "reject_without_queue" as const,
      cancellation: "cooperative_deadline" as const, driverCancellation: false as const,
      timedOutReadsRetainSlots: true as const, scope: "per_service_instance" as const
    };
  }
  snapshot() { return { activeRequests: this.activeRequests, pendingReads: this.pendingReads, activeWrites: this.activeWrites, closing: this.closing }; }
  deadline() { return this.scopes.getStore(); }
  assertOpen() { if (this.closing) throw new OpenContinuityError("RUNTIME_CLOSED", "Memory runtime is closing", 503); }
  beginClose() {
    this.closing = true;
    if (this.pendingReads || this.activeRequests || this.activeWrites) throw new OpenContinuityError("RUNTIME_BUSY", "Operations are still draining; retry close after settlement", 503);
  }
  private emit(receipt: ReadRuntimeReceipt) { emitReadReceipt(this.observer, receipt); }
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
      if (this.observer) this.emit({
        version: READ_RUNTIME_VERSION, operation, outcome, elapsedMs: performance.now() - started,
        readsStarted: scope.readsStarted, ...this.snapshotCounts(),
        stages: Object.freeze([...scope.stages.values()].map(stage => Object.freeze({ ...stage })))
      });
    }
  }
  private snapshotCounts() { return { activeRequests: this.activeRequests, pendingReads: this.pendingReads }; }
  async write<T>(start: () => T | Promise<T>): Promise<T> {
    this.assertOpen(); this.activeWrites++;
    try { return await start(); } finally { this.activeWrites--; }
  }
  /** Guards an auxiliary read under the same request deadline and drain accounting. */
  async read<T>(stage: ReadStage, start: () => T | Promise<T>): Promise<T> {
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
  guard(store: MemoryStore): MemoryStore { return guardMemoryStore(store, (stage, start) => this.read(stage, start)); }
}
