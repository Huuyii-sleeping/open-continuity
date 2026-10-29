import { createHash } from "node:crypto";
import { OpenContinuityError } from "../../shared/errors.js";
import type { ParsedRecallInput, RecallResult, ResolvedMemory, RetrievalChannel } from "../../shared/types.js";
import { FACT_POLICY, resolveFacts } from "../facts/resolution.js";
import { decodeRetrievalCursor } from "../pagination/cursor.js";
import { CandidateRetrieval } from "./candidates.js";
import { validateCandidateEligibility } from "./eligibility.js";
import { retrievalFingerprint } from "./fingerprint.js";
import { LEXICAL_FALLBACK_LIMITS, LEXICAL_FALLBACK_VERSION } from "./full-text/lexical-fallback.js";
import { recallLegacy } from "./legacy/recall.js";
import { createDefaultRetrievers } from "./legacy/retrievers.js";
import { paginateRankedEvidence } from "./pagination.js";
import { rankEvidence, RANKING_VERSION } from "./ranking.js";

import type { MemoryRetriever, RetrievalPipelineOptions, RetrievalSource, DenseRetrievalExtension } from "./contracts.js";
export type { MemoryRetriever, RetrievalPipelineOptions } from "./contracts.js";

export class RetrievalPipeline {
  private readonly store: RetrievalSource;
  private readonly retrievers: { exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever };
  private readonly enabledChannels: ReadonlySet<RetrievalChannel>;
  private readonly candidateLimit: number;
  private readonly rrfK: number;
  private readonly candidates?: CandidateRetrieval;
  private readonly exactPrecedence: boolean;
  private readonly fusion: "rrf" | "best_rank";
  private readonly factGroupLimit: number;
  private readonly dense?: DenseRetrievalExtension;
  private readonly lexicalFallback: boolean;

  constructor(store: RetrievalSource, options: RetrievalPipelineOptions = {}, retrievers?: Partial<{ exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever }>) {
    if (Object.hasOwn(options, "termAliases")) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Manual term aliases have been removed; remove termAliases from retrieval policy", 400);
    }
    this.store = store;
    this.dense = options.experimentalDense;
    this.candidateLimit = options.candidateLimit ?? 50;
    this.rrfK = options.rrfK ?? 60;
    this.enabledChannels = new Set(options.channels ?? ["exact", "structured", "full_text"]);
    this.exactPrecedence = options.exactPrecedence ?? true;
    this.fusion = options.fusion ?? "rrf";
    this.factGroupLimit = options.factGroupLimit ?? 100;
    this.lexicalFallback = options.lexicalFallback === "latin_one_edit" && store.lexicalFallbackVersion === LEXICAL_FALLBACK_VERSION
      && Boolean(store.candidateReaders || store.searchCandidates) && this.enabledChannels.has("full_text") && !retrievers;
    if (!Number.isInteger(this.candidateLimit) || this.candidateLimit < 1 || this.candidateLimit > 100
      || !Number.isFinite(this.rrfK) || this.rrfK < 1 || !this.enabledChannels.size
      || [...this.enabledChannels].some(c => !["exact", "structured", "full_text"].includes(c))
      || !["rrf", "best_rank"].includes(this.fusion) || !Number.isInteger(this.factGroupLimit)
      || this.factGroupLimit < 1 || this.factGroupLimit > 100 || !["off", "latin_one_edit"].includes(options.lexicalFallback ?? "off")) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid retrieval policy", 400);
    // Old custom retrievers/stores keep their explicit compatibility path.
    const candidateSource = store.searchCandidates ? { searchCandidates: store.searchCandidates.bind(store) } : store.candidateReaders;
    if (candidateSource && !retrievers) {
      this.candidates = new CandidateRetrieval(candidateSource);
      this.candidates.assertChannelsAvailable([...this.enabledChannels]);
    }
    if (this.dense && (!this.candidates || retrievers)) throw new OpenContinuityError("VALIDATION_ERROR", "Dense requires a scored candidate source", 400);
    const defaults = createDefaultRetrievers(store, this.candidateLimit);
    this.retrievers = { ...defaults, ...retrievers };
  }

  async recall(input: ParsedRecallInput, policy: { requireUserConfirmed?: boolean } = {}): Promise<RecallResult> {
    if (!input.query?.trim()) return this.store.recall(input);
    if (this.candidates) return this.recallCandidates(input, policy.requireUserConfirmed ?? false);
    return recallLegacy(input, policy.requireUserConfirmed ?? false, {
      store: this.store, retrievers: this.retrievers,
      enabledChannels: this.enabledChannels, candidateLimit: this.candidateLimit, rrfK: this.rrfK, factGroupLimit: this.factGroupLimit
    });
  }

  async reviewFacts(input: ParsedRecallInput, memories: ResolvedMemory[], requireUserConfirmed = false) {
    return resolveFacts(memories.map(memory => ({
      memory, score: memory.retrieval?.score ?? 0,
      exactTier: memory.retrieval?.exactTier ?? 0, retrieval: memory.retrieval ?? { score: 0, channels: [], ranks: {} }
    })),
      this.store, input, { requireUserConfirmed, groupLimit: this.factGroupLimit });
  }

  /** Report the active pipeline, not assumptions derived solely from a storage profile. */
  capabilityPolicy() {
    return {
      scored: Boolean(this.candidates), channels: [...this.enabledChannels, ...(this.dense ? ["dense" as const] : [])], candidateLimit: this.candidateLimit,
      rrfK: this.rrfK, exactPrecedence: this.exactPrecedence, factGroupLimit: this.factGroupLimit,
      experimentalDense: this.dense ? { status: "experimental" as const, mode: this.dense.mode, ...this.dense.fingerprint() } : null,
      lexicalFallbackSupported: Boolean(this.candidates) && this.store.lexicalFallbackVersion === LEXICAL_FALLBACK_VERSION,
      lexicalFallback: this.lexicalFallback ? { version: LEXICAL_FALLBACK_VERSION, ...LEXICAL_FALLBACK_LIMITS } : null
    };
  }

  private async recallCandidates(input: ParsedRecallInput, requireUserConfirmed: boolean): Promise<RecallResult> {
    const configuration = {
      rankingVersion: RANKING_VERSION, candidateLimit: this.candidateLimit, rrfK: this.rrfK,
      channels: [...this.enabledChannels].sort(), exactPrecedence: this.exactPrecedence, fusion: this.fusion, requireUserConfirmed,
      factPolicy: FACT_POLICY, factGroupLimit: this.factGroupLimit,
      ...(this.dense ? { experimentalDense: this.dense.fingerprint() } : {}),
      ...(this.lexicalFallback ? { lexicalFallback: { version: LEXICAL_FALLBACK_VERSION, ...LEXICAL_FALLBACK_LIMITS } } : {})
    };
    const fingerprint = createHash("sha256").update(JSON.stringify({ queryFingerprint: retrievalFingerprint(input), configuration })).digest("base64url");
    // Validate before issuing reads; old ranking cursors require restarting from page one.
    const cursor = decodeRetrievalCursor(input.cursor, fingerprint, true);
    const { cursor: _cursor, ...request } = input;
    const batches = await this.candidates!.retrieve({
      ...request, limit: this.candidateLimit, requireUserConfirmed,
      ...(this.lexicalFallback ? { lexicalFallback: true } : {})
    }, [...this.enabledChannels]);
    validateCandidateEligibility(batches, input, requireUserConfirmed);
    if (this.dense) {
      const lexical = new Set(batches.filter(batch => batch.channel !== "structured").flatMap(batch => batch.hits.map(hit => hit.memory.id))).size;
      const dense = await this.dense.retrieve({ ...request, limit: this.candidateLimit, requireUserConfirmed: true }, lexical);
      const snapshots = new Map(batches.flatMap(batch => batch.hits.map(hit => [hit.memory.id, hit.memory] as const)));
      const changed = dense.hits.some(hit => { const old = snapshots.get(hit.memory.id); return old && (old.sourceEventId !== hit.memory.sourceEventId || old.version !== hit.memory.version); });
      if (changed || this.dense.fingerprint().index !== configuration.experimentalDense?.index) {
        dense.hits = []; dense.status = "skipped"; dense.truncated = false; dense.skippedReason = "dense_unavailable"; dense.implementation = "not_run";
        if (dense.dense) dense.dense.reason = "index_changed";
      }
      batches.push(dense);
      validateCandidateEligibility([dense], input, true);
    }
    const ranking = rankEvidence(batches, { rrfK: this.rrfK, exactPrecedence: this.exactPrecedence, fusion: this.fusion });
    const { ranked, review } = await resolveFacts(ranking, this.store, input, { requireUserConfirmed, groupLimit: this.factGroupLimit });
    const { page, nextCursor } = paginateRankedEvidence(ranked, cursor, input.limit, fingerprint);
    return {
      memories: page.map(item => ({ ...item.memory, retrieval: item.retrieval })),
      nextCursor,
      retrieval: {
        mode: "hybrid", channels: (["exact", "structured", "full_text", "dense"] as const).filter(c => ranked.some(item => item.retrieval.channels.includes(c))), candidateCount: ranked.length, candidateLimit: this.candidateLimit,
        path: "scored_candidates", rankingVersion: RANKING_VERSION, truncated: batches.some(b => b.truncated),
        factReview: review,
        channelResults: batches.map(({ hits, ...batch }) => ({ ...batch, candidateCount: hits.length }))
      }
    };
  }

}
