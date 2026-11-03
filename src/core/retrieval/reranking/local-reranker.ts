import { performance } from "node:perf_hooks";
import { OpenContinuityError } from "../../../shared/errors.js";
import { LocalModelOwner } from "../../runtime/model-owner.js";
import { ReadDeadline } from "../../runtime/deadline.js";
import type { DenseExecutionBudget } from "../contracts.js";
import type { CandidateReranker, RelevanceProvider, RelevanceReceipt, RelevanceRequest } from "./contracts.js";
import { relevanceHash, validateRelevanceReceipt, validateRelevanceRequest } from "./validation.js";

export interface RerankerRuntimePolicy { timeoutMs: number; maxPending: number; idleMs: number; cacheEntries: number; cacheTtlMs: number; }
type ModelInput = { kind: "warmup" } | { kind: "score"; query: string; documents: string[] };
/** Independent query/document scorer. It has no database, admission or authorization side effects. */
export class LocalCandidateReranker implements CandidateReranker {
  readonly runtimePolicy: Readonly<RerankerRuntimePolicy>;
  private readonly identity: Readonly<{ model: string; policy: string; runtime: string }>;
  private readonly owner: LocalModelOwner<ModelInput, readonly number[] | null>;
  private readonly cache = new Map<string, { receipt: RelevanceReceipt; expires: number; timer: ReturnType<typeof setTimeout> }>();
  private closing = false;
  constructor(provider: RelevanceProvider, policy: Partial<RerankerRuntimePolicy> = {}) {
    if (!/^[a-f0-9]{64}$/.test(provider.modelFingerprint)) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid relevance model identity", 400);
    this.runtimePolicy = Object.freeze({ timeoutMs: 1000, maxPending: 2, idleMs: 60000, cacheEntries: 64, cacheTtlMs: 60000, ...policy });
    const p = this.runtimePolicy;
    if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 5000 || !Number.isInteger(p.maxPending) || p.maxPending < 1 || p.maxPending > 8
      || !Number.isInteger(p.idleMs) || p.idleMs < 1 || p.idleMs > 300000 || !Number.isInteger(p.cacheEntries) || p.cacheEntries < 0 || p.cacheEntries > 256
      || !Number.isInteger(p.cacheTtlMs) || p.cacheTtlMs < 1 || p.cacheTtlMs > 300000) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid reranker runtime budget", 400);
    this.identity = Object.freeze({ model: provider.modelFingerprint, policy: relevanceHash(JSON.stringify({ version: "cross-encoder-relevance-v1", maximumCandidates: 20,
      interpretation: "relative_order_only", admission: "caller_owned" })), runtime: relevanceHash(JSON.stringify(p)) });
    this.owner = new LocalModelOwner(async () => {
      const session = await provider.load();
      return { run: input => {
        if (session.modelFingerprint !== this.identity.model) throw new OpenContinuityError("STORAGE_ERROR", "Loaded reranker identity changed", 500);
        return input.kind === "warmup" ? Promise.resolve(null) : session.score(input.query, input.documents);
      }, close: () => session.close() };
    }, { maxPending: p.maxPending, idleMs: p.idleMs });
  }
  fingerprint() { return { ...this.identity }; }
  status() { return { ...this.owner.snapshot(), cacheEntries: this.cache.size }; }
  private assertOpen() { if (this.closing) throw new OpenContinuityError("RUNTIME_CLOSED", "Reranker is closing", 503); }
  async warmup(timeoutMs = 10000) { this.assertOpen(); await new ReadDeadline(timeoutMs).wait(() => this.owner.run({ kind: "warmup" })); }
  async rank(request: RelevanceRequest, budget?: DenseExecutionBudget): Promise<RelevanceReceipt> {
    this.assertOpen(); budget?.check(); validateRelevanceRequest(request);
    // Snapshot all binding fields before awaiting a model. Never retain caller-owned mutable evidence.
    const input = structuredClone(request);
    const base: RelevanceReceipt = { version: "cross-encoder-relevance-v1", modelFingerprint: this.identity.model, policyFingerprint: this.identity.policy,
      runtimeFingerprint: this.identity.runtime, queryFingerprint: input.queryFingerprint, accessFingerprint: input.accessFingerprint,
      status: "unavailable", cache: "unavailable", scores: [], meaning: "relative_query_document_relevance_logit" };
    const key = relevanceHash(JSON.stringify({ identity: this.identity, query: input.queryFingerprint, access: input.accessFingerprint,
      candidates: input.candidates.map(({ text: _text, ...reference }) => reference) }));
    const cached = this.cache.get(key);
    if (cached && cached.expires > performance.now()) { this.cache.delete(key); this.cache.set(key, cached); return structuredClone({ ...cached.receipt, cache: "hit" }); }
    if (cached) this.remove(key);
    const deadline = new ReadDeadline(this.runtimePolicy.timeoutMs);
    let scores: readonly number[] | null;
    try { const run = () => this.owner.run({ kind: "score", query: input.query, documents: input.candidates.map(candidate => candidate.text) });
      scores = await deadline.wait(() => budget ? budget.wait(run) : run()); }
    catch (error) { if (error instanceof OpenContinuityError && error.code === "STORAGE_ERROR") throw error; return base; }
    if (!Array.isArray(scores) || scores.length !== input.candidates.length || scores.some(score => !Number.isFinite(score)))
      throw new OpenContinuityError("STORAGE_ERROR", "Invalid relevance model scores", 500);
    const receipt: RelevanceReceipt = { ...base, status: "scored", cache: "miss", scores: input.candidates.map(({ text: _text, ...reference }, index) => ({ ...reference, value: scores![index]! })) };
    deadline.check(); budget?.check(); this.assertOpen(); validateRelevanceReceipt(input, receipt, this);
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
