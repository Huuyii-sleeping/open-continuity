import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { OpenContinuityError } from "../../../shared/errors.js";
import { ReadDeadline } from "../../runtime/deadline.js";
import { LocalModelOwner } from "../../runtime/model-owner.js";
import type { DenseExecutionBudget } from "../contracts.js";
import type { DensePairPolicy, PairProbabilities } from "./pair-contracts.js";
import type { BoundDensePairRequest, BoundDensePairReceipt, DensePairProvider, DensePairVerifier } from "./verification/contracts.js";
import { verifyDensePair } from "./pair-verification.js";

export interface DenseVerifierPolicy { timeoutMs: number; maxPending: number; idleMs: number; cacheEntries: number; cacheTtlMs: number; }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fingerprint = /^[a-f0-9]{64}$/;
type PairInput = { kind: "warmup" } | { kind: "pair"; premise: string; hypothesis: string };

/** A bounded model veto after retrieval eligibility. It never reads storage or changes memory authority. */
export class LocalDensePairVerifier implements DensePairVerifier {
  readonly directions = Object.freeze(["memory_to_query", "query_to_memory"] as const);
  readonly policy: Readonly<DensePairPolicy>;
  readonly runtimePolicy: Readonly<DenseVerifierPolicy>;
  private readonly policyFingerprint: string;
  private readonly runtimeFingerprint: string;
  private readonly owner: LocalModelOwner<PairInput, PairProbabilities | null>;
  private readonly cache = new Map<string, { receipt: BoundDensePairReceipt; expires: number; timer: ReturnType<typeof setTimeout> }>();
  private closing = false;
  constructor(provider: DensePairProvider, policy: DensePairPolicy, runtime: Partial<DenseVerifierPolicy> = {}) {
    this.policy = Object.freeze({ ...policy });
    this.policyFingerprint = verifyDensePair({ memoryId: "policy-validation", queryFingerprint: "0".repeat(64), contentFingerprint: "0".repeat(64) }, null, this.policy).policyFingerprint;
    if (provider.modelFingerprint !== policy.modelFingerprint) throw new OpenContinuityError("VALIDATION_ERROR", "Verifier model does not match policy", 400);
    this.runtimePolicy = Object.freeze({ timeoutMs: 1000, maxPending: 2, idleMs: 60000, cacheEntries: 128, cacheTtlMs: 60000, ...runtime });
    const limits = this.runtimePolicy;
    if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 5000
      || !Number.isInteger(limits.maxPending) || limits.maxPending < 1 || limits.maxPending > 8
      || !Number.isInteger(limits.idleMs) || limits.idleMs < 1 || limits.idleMs > 300000
      || !Number.isInteger(limits.cacheEntries) || limits.cacheEntries < 0 || limits.cacheEntries > 1024
      || !Number.isInteger(limits.cacheTtlMs) || limits.cacheTtlMs < 1 || limits.cacheTtlMs > 300000)
      throw new OpenContinuityError("VALIDATION_ERROR", "Invalid verifier runtime budget", 400);
    this.runtimeFingerprint = hash(JSON.stringify(limits));
    this.owner = new LocalModelOwner(async () => {
      const session = await provider.load();
      return { run: input => {
        if (session.modelFingerprint !== this.policy.modelFingerprint) throw new OpenContinuityError("STORAGE_ERROR", "Loaded verifier model changed", 500);
        return input.kind === "warmup" ? Promise.resolve(null) : session.compare(input.premise, input.hypothesis);
      }, close: () => session.close() };
    }, { maxPending: limits.maxPending, idleMs: limits.idleMs });
  }
  fingerprint() { return { model: this.policy.modelFingerprint, policy: this.policyFingerprint, runtime: this.runtimeFingerprint }; }
  status() { return { ...this.owner.snapshot(), cacheEntries: this.cache.size }; }
  /** Explicit preparation, outside normal recall latency; no automatic model downloads. */
  async warmup(timeoutMs = 10000) { this.assertOpen(); await new ReadDeadline(timeoutMs).wait(() => this.owner.run({ kind: "warmup" })); }
  private assertOpen() { if (this.closing) throw new OpenContinuityError("RUNTIME_CLOSED", "Verifier is closing", 503); }
  async verify(request: BoundDensePairRequest, budget?: DenseExecutionBudget): Promise<BoundDensePairReceipt> {
    this.assertOpen(); budget?.check();
    if (typeof request.memoryText !== "string" || typeof request.query !== "string" || !request.memoryText.trim() || !request.query.trim()
      || Buffer.byteLength(request.memoryText) > 65536 || Buffer.byteLength(request.query) > 8192
      || request.contentFingerprint !== hash(request.memoryText) || request.queryFingerprint !== hash(request.query)
      || !fingerprint.test(request.accessFingerprint) || typeof request.sourceEventId !== "string" || !request.sourceEventId.trim() || request.sourceEventId.length > 256
      || !Number.isInteger(request.memoryVersion) || request.memoryVersion < 1)
      throw new OpenContinuityError("VALIDATION_ERROR", "Unbound verifier request", 400);
    const base: BoundDensePairReceipt = { ...verifyDensePair(request, null, this.policy), sourceEventId: request.sourceEventId,
      memoryVersion: request.memoryVersion, accessFingerprint: request.accessFingerprint, cache: "unavailable" };
    const key = hash(JSON.stringify({ memory: request.memoryId, event: request.sourceEventId, version: request.memoryVersion,
      access: request.accessFingerprint, query: request.queryFingerprint, content: request.contentFingerprint, policy: this.policyFingerprint,
      ...(request.direction ? { direction: request.direction } : {}) }));
    const cached = this.cache.get(key);
    if (cached && cached.expires > performance.now()) {
      this.cache.delete(key); this.cache.set(key, cached); return structuredClone({ ...cached.receipt, cache: "hit" });
    }
    if (cached) this.remove(key);
    const deadline = new ReadDeadline(this.runtimePolicy.timeoutMs);
    let probabilities: PairProbabilities | null;
    const input: PairInput = { kind: "pair", premise: request.direction === "query_to_memory" ? request.query : request.memoryText,
      hypothesis: request.direction === "query_to_memory" ? request.memoryText : request.query };
    try { probabilities = await deadline.wait(() => budget ? budget.wait(() => this.owner.run(input)) : this.owner.run(input)); }
    catch (error) { if (error instanceof OpenContinuityError && error.code === "STORAGE_ERROR") throw error; return base; }
    if (!probabilities) throw new OpenContinuityError("STORAGE_ERROR", "Missing verifier probabilities", 500);
    const receipt: BoundDensePairReceipt = { ...base, ...verifyDensePair(request, { memoryId: request.memoryId,
      queryFingerprint: request.queryFingerprint, contentFingerprint: request.contentFingerprint, modelFingerprint: this.policy.modelFingerprint,
      memoryToQuery: probabilities, ...(request.direction === "query_to_memory" ? { queryToMemory: probabilities } : {}) }, this.policy), cache: "miss" };
    deadline.check(); budget?.check(); this.assertOpen();
    if (this.runtimePolicy.cacheEntries) {
      while (this.cache.size >= this.runtimePolicy.cacheEntries) this.remove(this.cache.keys().next().value!);
      const timer = setTimeout(() => this.remove(key), this.runtimePolicy.cacheTtlMs); timer.unref();
      this.cache.set(key, { receipt: structuredClone(receipt), expires: performance.now() + this.runtimePolicy.cacheTtlMs, timer });
    }
    return receipt;
  }
  private remove(key: string) { const value = this.cache.get(key); if (value) clearTimeout(value.timer); this.cache.delete(key); }
  async close() { this.closing = true; for (const key of [...this.cache.keys()]) this.remove(key); await this.owner.close(); }
}
