import { createHash } from "node:crypto";
import type { ResolvedMemory } from "../../../shared/types.js";
import type { CandidateRetrievalRequest, CandidateSearchResult, DenseRetrievalExtension, DenseExecutionBudget } from "../contracts.js";
import type { DenseAdmissionPolicy } from "./contracts.js";
import type { DenseVectorIndex, EmbeddingProvider, EmbeddingModelSpec } from "./index-contracts.js";
import type { BoundDensePairReceipt, BoundDensePairRequest, DensePairVerifier } from "./verification/contracts.js";
import { validateBoundVerification } from "./validate-verification.js";
import type { DensePairRequest } from "./pair-contracts.js";
import { admitDenseCandidates, densePolicyFingerprint } from "./admission.js";
import { embeddingText, validateEmbeddingModel, validateVector } from "./vectors.js";
import { DenseCandidateRanker } from "./ranker.js";
import type { DenseCachePolicy } from "./snapshot-cache.js";
import { LocalModelOwner } from "../../runtime/model-owner.js";
import { ReadDeadline } from "../../runtime/deadline.js";
import { OpenContinuityError } from "../../../shared/errors.js";
import { parseCandidateSearch } from "../contracts.js";

export interface DenseExperimentOptions {
  mode?: "miss_only" | "hybrid";
  admission: DenseAdmissionPolicy;
  modelTimeoutMs?: number;
  populationLimit?: number;
  snapshotCache?: Partial<DenseCachePolicy>;
  /** Optional bounded candidate veto; the larger NLI model is never a default dependency. */
  verify?: (request: DensePairRequest, memoryText: string, query: string) => Promise<boolean>;
  verificationFingerprint?: string;
  pairVerifier?: DensePairVerifier;
  maxVerificationCandidates?: number;
}

export class DenseRetriever implements DenseRetrievalExtension {
  readonly mode: "miss_only" | "hybrid";
  private readonly model: Readonly<EmbeddingModelSpec>;
  private readonly owner: LocalModelOwner<{ texts: string[]; mode: "query" | "document" }, readonly (readonly number[])[]>;
  private readonly policyFingerprint: string;
  private readonly timeout: number;
  private readonly verifierIdentity?: Readonly<{ model: string; policy: string; runtime: string }>;
  private readonly verificationLimit: number;
  private readonly ranker: DenseCandidateRanker;
  private readonly maximum: number;
  constructor(private readonly index: DenseVectorIndex, provider: EmbeddingProvider, private readonly options: DenseExperimentOptions) {
    validateEmbeddingModel(provider.model); validateEmbeddingModel(index.model);
    this.model = Object.freeze({ ...provider.model });
    this.options = Object.freeze({ ...options, admission: Object.freeze({ ...options.admission }) });
    if (provider.model.fingerprint !== index.model.fingerprint || provider.model.dimensions !== index.model.dimensions
      || options.admission.modelFingerprint !== provider.model.fingerprint) throw new OpenContinuityError("VALIDATION_ERROR", "Dense model and index are incompatible", 400);
    const identity = options.pairVerifier?.fingerprint();
    if (identity && [identity.model, identity.policy, identity.runtime].some(value => !/^[a-f0-9]{64}$/.test(value))) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid verifier identity", 400);
    this.verifierIdentity = identity ? Object.freeze({ model: identity.model, policy: identity.policy, runtime: identity.runtime }) : undefined;
    this.verificationLimit = options.maxVerificationCandidates ?? 1;
    this.mode = options.mode ?? "miss_only"; this.timeout = options.modelTimeoutMs ?? 1000; this.maximum = options.populationLimit ?? 10000;
    if (!["miss_only", "hybrid"].includes(this.mode) || !Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 5000
      || !Number.isInteger(this.maximum) || this.maximum < 1 || this.maximum > 20000
      || (options.verify !== undefined && typeof options.verify !== "function")
      || (Boolean(options.verify) && Boolean(options.pairVerifier))
      || !Number.isInteger(this.verificationLimit) || this.verificationLimit < 1 || this.verificationLimit > 4
      || Boolean(options.verify) !== Boolean(options.verificationFingerprint)
      || (options.verificationFingerprint && !/^[a-f0-9]{64}$/.test(options.verificationFingerprint))) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense experiment policy", 400);
    this.ranker = new DenseCandidateRanker(index, options.snapshotCache);
    this.policyFingerprint = createHash("sha256").update(JSON.stringify({ admission: densePolicyFingerprint(options.admission), mode: this.mode,
      verification: this.verifierIdentity ?? options.verificationFingerprint ?? null, verificationLimit: this.verificationLimit, maximum: this.maximum, timeout: this.timeout, vectorRanking: "projection-cache-v1", cache: this.ranker.cache.policy })).digest("hex");
    this.owner = new LocalModelOwner(async () => {
      const session = await provider.load();
      return { run: input => {
        if (session.model.fingerprint !== this.model.fingerprint || session.model.dimensions !== this.model.dimensions || session.model.textVersion !== this.model.textVersion)
          throw new OpenContinuityError("STORAGE_ERROR", "Loaded model does not match the index", 500);
        return session.embed(input.texts, input.mode);
      }, close: () => session.close() };
    }, { maxPending: 4, idleMs: 60000 });
  }
  private checkVerifierIdentity() {
    const live = this.options.pairVerifier?.fingerprint();
    if (live && (live.model !== this.verifierIdentity?.model || live.policy !== this.verifierIdentity.policy || live.runtime !== this.verifierIdentity.runtime))
      throw new OpenContinuityError("STORAGE_ERROR", "Verifier identity changed", 500);
  }
  fingerprint() {
    let index = "unavailable"; try { index = this.index.revision(); } catch { /* Keep lexical available after index/model failure. */ }
    return { model: this.model.fingerprint, policy: this.policyFingerprint, index, ...(this.options.pairVerifier ? { verification: this.verifierIdentity! } : {}) };
  }
  status() { return { ...this.owner.snapshot(), vectorCache: this.ranker.cache.status() }; }
  private unavailable(reason: string, indexRevision = "unavailable", pairs?: BoundDensePairReceipt[]): CandidateSearchResult {
    return { channel: "dense", status: "skipped", skippedReason: reason === "lexical_preserved" ? "dense_lexical_preserved" : reason === "index_incomplete" ? "dense_index_incomplete" : reason === "unavailable" ? "dense_unavailable" : "dense_rejected",
      hits: [], truncated: false, ordering: "cosine_then_updated_at_id", implementation: "not_run",
      dense: { version: "dense-integration-v1", modelFingerprint: this.model.fingerprint, policyFingerprint: this.policyFingerprint, indexRevision, mode: this.mode,
        reason, ...(pairs ? { pairs } : {}), ...(this.options.pairVerifier ? { verificationModel: this.verifierIdentity! } : {}), verification: this.options.verify || this.options.pairVerifier ? "pair_model" : "none" } };
  }
  async synchronize(input: CandidateRetrievalRequest, maximumJobs = 100) {
    const parsed = parseCandidateSearch({ ...input, channel: "dense" });
    const tasks = this.index.pending(parsed, maximumJobs); let indexed = 0, stale = 0, failed = 0;
    let attempted = 0;
    for (const task of tasks) {
      attempted++;
      try {
        const deadline = new ReadDeadline(this.timeout);
        const output = await deadline.wait(() => this.owner.run({ texts: [embeddingText(task.memory.value)], mode: "document" }));
        if (output.length !== 1) throw new Error("invalid model output");
        validateVector(output[0]!, this.model.dimensions);
        if (this.index.commit(task, output[0]!)) indexed++; else stale++;
      } catch { failed++; break; }
    }
    return { attempted, indexed, stale, failed, remaining: this.index.pending(parsed, maximumJobs).length };
  }
  async retrieve(request: CandidateRetrievalRequest, lexicalMatches: number, budget?: DenseExecutionBudget): Promise<CandidateSearchResult> {
    if (!Number.isInteger(lexicalMatches) || lexicalMatches < 0) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid lexical match count", 400);
    if (this.mode === "miss_only" && lexicalMatches > 0) return this.unavailable("lexical_preserved");
    const input = parseCandidateSearch({ ...request, channel: "dense" });
    if (!input.query?.trim()) return this.unavailable("empty_query");
    try {
      budget?.check();
      const population = this.ranker.coverage(input, this.maximum);
      if (!population.complete) return this.unavailable("index_incomplete", population.revision);
      if (!population.count) return this.unavailable("no_candidates", population.revision);
      const deadline = new ReadDeadline(this.timeout);
      const wait = <T>(start: () => Promise<T>) => deadline.wait(() => budget ? budget.wait(start) : start());
      const output = await wait(() => this.owner.run({ texts: [input.query!], mode: "query" }));
      if (output.length !== 1) throw new Error("invalid model output");
      validateVector(output[0]!, this.model.dimensions); const query = output[0]!;
      const result = this.ranker.rank(input, query, this.maximum, population, () => { deadline.check(); budget?.check(); }, this.options.admission.minScore);
      if (!result) return this.unavailable("index_changed", population.revision);
      const { ranked, aboveThreshold } = result;
      // The full authorized population was scored; its first 100 include the true top two.
      const admission = admitDenseCandidates({ lexicalMatches: 0, modelReady: true, comparison: "complete",
        candidates: ranked.slice(0, 100).map(entry => ({ memoryId: entry.memory.id, modelFingerprint: this.model.fingerprint, score: entry.score })) }, this.options.admission);
      const selected = this.mode === "miss_only" ? ranked.filter(entry => admission.admittedMemoryIds.includes(entry.memory.id))
        : ranked.filter(entry => entry.score >= this.options.admission.minScore).slice(0, input.limit);
      const accepted = [], pairs: BoundDensePairReceipt[] = [];
      const toVerify = this.options.pairVerifier ? selected.slice(0, this.verificationLimit) : selected;
      for (const entry of toVerify) {
        if (this.options.pairVerifier) {
          this.checkVerifierIdentity();
          const text = embeddingText(entry.memory.value);
          const pair: BoundDensePairRequest = { memoryId: entry.memory.id, sourceEventId: entry.memory.sourceEventId, memoryVersion: entry.memory.version,
            queryFingerprint: createHash("sha256").update(input.query!).digest("hex"), contentFingerprint: createHash("sha256").update(text).digest("hex"),
            accessFingerprint: createHash("sha256").update(JSON.stringify({ userId: input.userId, agentId: input.agentId, taskId: input.taskId ?? null,
              includePrivate: input.includePrivate, scope: input.scope ?? null, key: input.key ?? null, kind: input.kind ?? null, confirmation: true })).digest("hex"), memoryText: text, query: input.query! };
          const verified = await wait(() => this.options.pairVerifier!.verify(pair, budget));
          this.checkVerifierIdentity();
          validateBoundVerification(pair, verified, this.options.pairVerifier); pairs.push(verified);
          if (verified.reason === "verification_unavailable") return this.unavailable("verification_unavailable", population.revision, pairs);
          if (!verified.accepted) continue;
        }
        if (this.options.verify) {
          const text = embeddingText(entry.memory.value);
          const pair = { memoryId: entry.memory.id, queryFingerprint: createHash("sha256").update(input.query!).digest("hex"), contentFingerprint: createHash("sha256").update(text).digest("hex") };
          const verified = await wait(() => this.options.verify!(pair, text, input.query!));
          if (typeof verified !== "boolean") throw new OpenContinuityError("STORAGE_ERROR", "Invalid verification evidence", 500);
          if (!verified) continue;
        }
        accepted.push(entry);
      }
      // All score evidence is discarded if another writer/model rebuild changed eligibility/current versions.
      deadline.check(); budget?.check();
      if (this.index.revision() !== population.revision) return this.unavailable("index_changed", population.revision, pairs);
      if (!accepted.length) return this.unavailable(selected.length ? "pair_rejected" : admission.reason, population.revision, pairs);
      return { channel: "dense", status: "ok", truncated: (this.mode === "hybrid" && aboveThreshold > input.limit) || selected.length > toVerify.length,
        ordering: "cosine_then_updated_at_id", implementation: "sqlite_dense_experimental",
        dense: { version: "dense-integration-v1", modelFingerprint: this.model.fingerprint, policyFingerprint: this.policyFingerprint, indexRevision: population.revision,
          mode: this.mode, reason: "admitted", ranking: result.receipt, ...(this.options.pairVerifier ? { pairs, verificationModel: this.verifierIdentity!,
            verificationBudget: { limit: this.verificationLimit, attempted: pairs.length, notVerified: selected.length - toVerify.length } } : {}), verification: this.options.verify || this.options.pairVerifier ? "pair_model" : "none" },
        hits: accepted.map((entry, index) => ({ memory: entry.memory, ...(this.options.pairVerifier ? { verification: pairs.find(pair => pair.memoryId === entry.memory.id)! } : {}), channel: "dense", channelRank: index + 1, rankMeaning: "relevance",
          score: { model: "cosine_similarity", value: entry.score, direction: "higher_is_better", modelFingerprint: this.model.fingerprint },
          match: { type: "semantic_similarity", reason: "vector_neighbour", filters: (["key", "kind", "scope"] as const).filter(field => input[field] !== undefined) } })) };
    } catch { return this.unavailable("unavailable"); }
  }
  async close() {
    this.ranker.close();
    const results = await Promise.allSettled([this.owner.close(), this.options.pairVerifier?.close()]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
