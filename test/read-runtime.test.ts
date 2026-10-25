import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { InMemoryStore, type MemoryStore } from "../src/core/memory-store.js";
import { MemoryService } from "../src/core/memory-service.js";
import { ReadDeadline, ReadRuntime, type ReadRuntimeReceipt } from "../src/core/read-runtime.js";
import { OpenContinuityError } from "../src/shared/errors.js";
import { buildHttpApp } from "../src/http/app.js";

const actor = { userId: "fictional-runtime-user", agentId: "fictional-runtime-agent" };
const context = { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 };
const queryPolicy = { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 100, maxTimeoutMs: 1000, maxSubqueries: 3, historyLimit: 50 };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function legacy(read: MemoryStore["recall"], history?: MemoryStore["history"]): MemoryStore {
  const base = new InMemoryStore();
  return { appendRemember: input => base.appendRemember(input), appendForget: (...args) => base.appendForget(...args),
    recall: read, history: history ?? (input => base.history(input)) };
}

describe("5A cooperative read runtime", () => {
  it("checks a monotonic deadline before executing the thunk and after synchronous work", async () => {
    let clock = 0; let calls = 0;
    const budget = new ReadDeadline(10, () => clock);
    await expect(budget.wait(() => { calls++; clock = 11; return "late"; })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    await expect(budget.wait(() => { calls++; return "never"; })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(calls).toBe(1);
  });
  it("rejects invalid runtime policies", () => {
    for (const policy of [{ maxPendingReads: 0 }, { maxConcurrentRequests: 257 }, { defaultTimeoutMs: 1 }]) {
      expect(() => new ReadRuntime(policy)).toThrow("Invalid read runtime policy");
    }
    expect(() => new ReadDeadline(NaN)).toThrow("Invalid read deadline");
    expect(() => new MemoryService(new InMemoryStore(), {}, context, { ...queryPolicy, maxSteps: 1 })).toThrow("Invalid query policy");
  });
  it("copies query policy so external mutation cannot alter execution budgets", async () => {
    const policy = { ...queryPolicy };
    const service = new MemoryService(new InMemoryStore(), {}, context, policy);
    policy.maxSteps = 8; policy.maxSubqueries = 8;
    expect(service.queryCapabilityPolicy()).toMatchObject({ maxSteps: 4, maxSubqueries: 3 });
    await expect(service.query({ ...actor, query: "fictional", maxSteps: 5 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await service.close();
  });
  it("returns Query timeout/abstain, stops subsequent channels and retains driver capacity", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>(); let reads = 0;
    const service = new MemoryService(legacy(() => { reads++; return pending.promise; }), {}, context, queryPolicy, { maxPendingReads: 1 });
    const result = await service.query({ ...actor, query: "fictional slow", subqueries: ["alpha", "beta"], timeoutMs: 10 });
    expect(result.execution.stoppedReason).toBe("timeout");
    expect(result.steps.map(step => step.status)).toEqual(["timed_out", "skipped"]);
    expect(result.answer).toMatchObject({ status: "abstain", statements: [], citations: [] });
    expect(service.readRuntimeStatus()).toMatchObject({ activeRequests: 0, pendingReads: 1 });
    await expect(service.recall(actor)).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    expect(reads).toBe(1);
    pending.resolve({ memories: [], nextCursor: null }); await turn();
    expect(reads).toBe(1); // Full-text does not resume when the timed-out exact channel settles.
    expect(service.readRuntimeStatus().pendingReads).toBe(0);
    expect((await service.recall(actor)).memories).toEqual([]);
    await service.close();
  });
  it("observes late driver rejection without retrying and recovers capacity", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>();
    const service = new MemoryService(legacy(() => pending.promise), {}, context, queryPolicy, { defaultTimeoutMs: 10 });
    await expect(service.recall(actor)).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    pending.reject(new Error("fictional private driver error")); await turn();
    expect(service.readRuntimeStatus().pendingReads).toBe(0);
    await service.close();
  });
  it("does not promise hard timeouts for synchronous blocking operations", async () => {
    const runtime = new ReadRuntime({ defaultTimeoutMs: 10 });
    const start = performance.now();
    await expect(runtime.run("recall", async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35);
      return "fictional late result";
    })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
    expect(runtime.snapshot()).toMatchObject({ activeRequests: 0, pendingReads: 0 });
  });
  it("shares Query budget with nested reads even when wall clock jumps", async () => {
    const base = new InMemoryStore();
    const runtime = new ReadRuntime(); const guarded = runtime.guard(base);
    const wall = vi.spyOn(Date, "now").mockReturnValue(-123456);
    try { await runtime.run("query", async () => {
      const deadline = runtime.deadline();
      expect(deadline).toBeDefined();
      await guarded.recall({ ...actor, includePrivate: false, limit: 20 });
      expect(runtime.deadline()).toBe(deadline);
      expect(deadline!.readsStarted).toBe(1);
    }); } finally { wall.mockRestore(); }
  });
  it("rejects excess requests immediately without queuing", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>(); let reads = 0;
    const service = new MemoryService(legacy(() => { reads++; return pending.promise; }), {}, context, queryPolicy,
      { maxConcurrentRequests: 1, maxPendingReads: 2, defaultTimeoutMs: 1000 });
    const first = service.recall(actor); await turn();
    const rejected = await Promise.allSettled(Array.from({ length: 20 }, () => service.recall(actor)));
    expect(rejected.every(row => row.status === "rejected" && row.reason.code === "RUNTIME_BUSY")).toBe(true);
    expect(reads).toBe(1);
    pending.resolve({ memories: [], nextCursor: null }); await first; await service.close();
  });
  it("does not disguise storage errors as empty successful Query results", async () => {
    const service = new MemoryService(legacy(() => { throw new OpenContinuityError("STORAGE_ERROR", "Storage read failed", 500); }));
    await expect(service.query({ ...actor, query: "fictional" })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(service.readRuntimeStatus()).toMatchObject({ pendingReads: 0, activeRequests: 0 });
    await service.close();
  });
  it("preserves truthful no-hit success and emits metadata without identities or text", async () => {
    const receipts: ReadRuntimeReceipt[] = [];
    const service = new MemoryService(new InMemoryStore(), {}, context, queryPolicy, {}, receipt => receipts.push(receipt));
    expect((await service.query({ ...actor, query: "fictional private prompt marker" })).answer!.status).toBe("abstain");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ operation: "query", outcome: "completed", version: "bounded-reads-v1" });
    expect(Object.keys(receipts[0]!).sort()).toEqual(["activeRequests", "elapsedMs", "operation", "outcome", "pendingReads", "readsStarted", "stages", "version"]);
    expect(JSON.stringify(receipts)).not.toContain("fictional");
    expect(Object.isFrozen(receipts[0])).toBe(true); await service.close();
  });
  it("isolates observer exceptions from successful results", async () => {
    const service = new MemoryService(new InMemoryStore(), {}, context, queryPolicy, {}, () => { throw new Error("fictional observer fault"); });
    expect((await service.recall(actor)).memories).toEqual([]); await service.close();
    const asyncObserver = new MemoryService(new InMemoryStore(), {}, context, queryPolicy, {}, async () => { throw new Error("fictional async observer fault"); });
    expect((await asyncObserver.recall(actor)).memories).toEqual([]); await turn(); await asyncObserver.close();
  });
  it("drains actual reads before closing and rejects new reads and writes", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>(); let closed = 0;
    const store = { ...legacy(() => pending.promise), close: () => { closed++; } };
    const service = new MemoryService(store, {}, context, queryPolicy, { defaultTimeoutMs: 10 });
    await expect(service.recall(actor)).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    await expect(service.close()).rejects.toMatchObject({ code: "RUNTIME_BUSY" });
    expect(closed).toBe(0);
    await expect(service.recall(actor)).rejects.toMatchObject({ code: "RUNTIME_CLOSED" });
    await expect(service.remember({ ...actor, key: "x", value: "x", kind: "user_fact", idempotencyKey: "x" })).rejects.toMatchObject({ code: "RUNTIME_CLOSED" });
    pending.resolve({ memories: [], nextCursor: null }); await turn();
    await service.close(); expect(closed).toBe(1);
  });
  it("does not close the underlying store during an unfinished write", async () => {
    const pending = deferred<void>(); let closed = false;
    const base = new InMemoryStore();
    const service = new MemoryService({ ...legacy(input => base.recall(input)),
      appendRemember: async input => { await pending.promise; return base.appendRemember(input); }, close: () => { closed = true; } });
    const writing = service.remember({ ...actor, key: "x", value: "x", kind: "user_fact", idempotencyKey: "x" }); await turn();
    await expect(service.close()).rejects.toMatchObject({ code: "RUNTIME_BUSY" }); expect(closed).toBe(false);
    pending.resolve(); await writing; await service.close(); expect(closed).toBe(true);
  });
  it("graceful close has a bounded drain and never force-closes a pending read", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>(); let closed = 0;
    const service = new MemoryService({ ...legacy(() => pending.promise), close: () => { closed++; } }, {}, context, queryPolicy, { defaultTimeoutMs: 10 });
    await expect(service.recall(actor)).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    await expect(service.closeGracefully(20)).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    expect(closed).toBe(0);
    const drain = service.closeGracefully(1000);
    pending.resolve({ memories: [], nextCursor: null }); await drain; expect(closed).toBe(1);
    await Promise.all([service.close(), service.closeGracefully()]); expect(closed).toBe(1);
  });
  it("checks Context, history and fact-group reads through the same guard", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>();
    const service = new MemoryService(legacy(() => pending.promise), {}, context, queryPolicy, { defaultTimeoutMs: 10 });
    await expect(service.context({ ...actor, query: "fictional" })).rejects.toMatchObject({ code: "READ_TIMEOUT" });
    pending.resolve({ memories: [], nextCursor: null }); await turn();
    expect((await service.history(actor)).events).toEqual([]); await service.close();
    const runtime = new ReadRuntime(); let calls = 0;
    const guarded = runtime.guard({ ...legacy(() => ({ memories: [], nextCursor: null })), readFactGroup: () => { calls++; return { memories: [], truncated: false }; } });
    await runtime.run("query", async () => { await guarded.readFactGroup!({ ...actor, group: "fictional", scope: "user", kind: "decision" }); });
    expect(calls).toBe(1);
  });
  it("exposes actual limits and stable HTTP errors, never driver details", async () => {
    const pending = deferred<{ memories: []; nextCursor: null }>();
    const service = new MemoryService(legacy(() => pending.promise), {}, context, queryPolicy, { defaultTimeoutMs: 10, maxPendingReads: 1 });
    const app = buildHttpApp(service); await app.ready();
    try {
      const caps = (await app.inject({ method: "GET", url: "/v1/capabilities" })).json();
      expect(caps.readRuntime).toMatchObject({ version: "bounded-reads-v1", maxPendingReads: 1, driverCancellation: false });
      const url = `/v1/memories?userId=${actor.userId}&agentId=${actor.agentId}`;
      const timeout = await app.inject({ method: "GET", url });
      expect(timeout.statusCode).toBe(504); expect(timeout.json().error.code).toBe("READ_TIMEOUT");
      const busy = await app.inject({ method: "GET", url });
      expect(busy.statusCode).toBe(503); expect(busy.json().error.code).toBe("RUNTIME_BUSY");
    } finally { pending.resolve({ memories: [], nextCursor: null }); await turn(); await app.close(); }
  });
});
