import { createHash } from "node:crypto";
import { OpenContinuityError } from "../shared/errors.js";
import { CandidateRetrieval } from "./candidate-search.js";
import { rankEvidence, RANKING_VERSION } from "./evidence-ranking.js";
import { FACT_POLICY, resolveFacts } from "./fact-resolution.js";
import { decodeRetrievalCursor, encodeRetrievalCursor } from "./cursor.js";
import type { MemoryStore } from "./memory-store.js";
import type { StructuredMemoryInput } from "./storage-contract.js";
import type { ParsedRecallInput, RecallResult, ResolvedMemory, RetrievalChannel } from "../shared/types.js";

interface RetrieverHit {
  memory: ResolvedMemory;
  channel: RetrievalChannel;
}

export interface MemoryRetriever {
  readonly channel: RetrievalChannel;
  retrieve(input: ParsedRecallInput): Promise<ResolvedMemory[]>;
}

interface RankedMemory {
  memory: ResolvedMemory;
  score: number;
  channels: Set<RetrievalChannel>;
  ranks: Partial<Record<RetrievalChannel, number>>;
}

export interface RetrievalPipelineOptions {
  channels?: readonly RetrievalChannel[];
  candidateLimit?: number;
  rrfK?: number;
  exactPrecedence?: boolean;
  /** Explicit ablation option; the production default is rrf. */
  fusion?: "rrf" | "best_rank";
  factGroupLimit?: number;
}

function retrievalFingerprint(input: ParsedRecallInput): string {
  const scope = {
    userId: input.userId, agentId: input.agentId, query: input.query ?? "", key: input.key ?? null, kind: input.kind ?? null,
    scope: input.scope ?? null, taskId: input.taskId ?? null, includePrivate: input.includePrivate,
  };
  return createHash("sha256").update(JSON.stringify(scope)).digest("base64url");
}

function withoutCursor(input: ParsedRecallInput, candidateLimit: number): ParsedRecallInput {
  return { ...input, cursor: undefined, limit: candidateLimit };
}

function sortRanked(left: RankedMemory, right: RankedMemory): number {
  return right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id);
}

function uniqueChannels(channels: Iterable<RetrievalChannel>): RetrievalChannel[] {
  return [...new Set(channels)];
}

class StoreRetriever implements MemoryRetriever {
  constructor(
    readonly channel: RetrievalChannel,
    private readonly store: MemoryStore,
    private readonly buildInput: (input: ParsedRecallInput) => ParsedRecallInput,
  ) {}

  async retrieve(input: ParsedRecallInput): Promise<ResolvedMemory[]> {
    const request = this.buildInput(input);
    const result = request.query === undefined && this.store.list
      ? await this.store.list(request as StructuredMemoryInput)
      : await this.store.recall(request);
    return result.memories;
  }
}

function createDefaultRetrievers(store: MemoryStore, candidateLimit: number): { exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever } {
  return {
    exact: new StoreRetriever("exact", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: undefined, key: input.key && input.key !== input.query ? undefined : input.query })),
    structured: new StoreRetriever("structured", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: undefined })),
    fullText: new StoreRetriever("full_text", store, (input) => ({ ...withoutCursor(input, candidateLimit), query: input.query })),
  };
}

export class RetrievalPipeline {
  private readonly store: MemoryStore;
  private readonly retrievers: { exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever };
  private readonly enabledChannels: ReadonlySet<RetrievalChannel>;
  private readonly candidateLimit: number;
  private readonly rrfK: number;
  private readonly candidates?: CandidateRetrieval;
  private readonly exactPrecedence: boolean;
  private readonly fusion: "rrf" | "best_rank";
  private readonly factGroupLimit: number;

  constructor(store: MemoryStore, options: RetrievalPipelineOptions = {}, retrievers?: Partial<{ exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever }>) {
    this.store = store;
    this.candidateLimit = options.candidateLimit ?? 50;
    this.rrfK = options.rrfK ?? 60;
    this.enabledChannels = new Set(options.channels ?? ["exact", "structured", "full_text"]);
    this.exactPrecedence = options.exactPrecedence ?? true;
    this.fusion = options.fusion ?? "rrf";
    this.factGroupLimit = options.factGroupLimit ?? 100;
    if (!Number.isInteger(this.candidateLimit) || this.candidateLimit < 1 || this.candidateLimit > 100
      || !Number.isFinite(this.rrfK) || this.rrfK < 1 || !this.enabledChannels.size
      || [...this.enabledChannels].some(c => !["exact", "structured", "full_text"].includes(c))
      || !["rrf", "best_rank"].includes(this.fusion) || !Number.isInteger(this.factGroupLimit)
      || this.factGroupLimit < 1 || this.factGroupLimit > 100) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid retrieval policy", 400);
    // Old custom retrievers/stores keep their explicit compatibility path.
    if (store.searchCandidates && !retrievers) this.candidates = new CandidateRetrieval({ searchCandidates: request => store.searchCandidates!(request) });
    const defaults = createDefaultRetrievers(store, this.candidateLimit);
    this.retrievers = { ...defaults, ...retrievers };
  }

  async recall(input: ParsedRecallInput, policy: { requireUserConfirmed?: boolean } = {}): Promise<RecallResult> {
    if (!input.query?.trim()) return this.store.recall(input);
    if (this.candidates) return this.recallCandidates(input, policy.requireUserConfirmed ?? false);

    const hits: RetrieverHit[][] = [];
    const channels: RetrievalChannel[] = [];

    const exactMemories = !this.enabledChannels.has("exact") || (input.key && input.key !== input.query)
      ? []
      : await this.retrievers.exact.retrieve(input);
    hits.push(exactMemories.map((memory) => ({ memory, channel: "exact" as const })));
    if (exactMemories.length > 0) channels.push("exact");

    const fullTextMemories = this.enabledChannels.has("full_text") ? await this.retrievers.fullText.retrieve(input) : [];

    if (this.enabledChannels.has("structured") && (input.key || input.kind || input.scope || input.taskId)) {
      const structuredMemories = await this.retrievers.structured.retrieve(input);
      const queryMatches = new Set([...exactMemories, ...fullTextMemories].map((memory) => memory.id));
      const structuredHits = structuredMemories.filter((memory) => queryMatches.has(memory.id));
      hits.push(structuredHits.map((memory) => ({ memory, channel: "structured" as const })));
      if (structuredHits.length > 0) channels.push("structured");
    }

    hits.push(fullTextMemories.map((memory) => ({ memory, channel: "full_text" as const })));
    if (fullTextMemories.length > 0) channels.push("full_text");

    let ranked = this.fuse(hits);
    let factReview: NonNullable<RecallResult["retrieval"]>["factReview"];
    if (ranked.some(item => item.memory.fact)) {
      const resolved = await resolveFacts(ranked.map(item => ({ ...item, exactTier: 0,
        retrieval: { score: item.score, channels: uniqueChannels(item.channels), ranks: item.ranks } })), this.store, input,
        { requireUserConfirmed: policy.requireUserConfirmed ?? false, groupLimit: this.factGroupLimit });
      const byId = new Map(resolved.ranked.map(item => [item.memory.id, item.retrieval]));
      ranked = ranked.filter(item => byId.has(item.memory.id)).map(item => ({ ...item, memory: { ...item.memory, retrieval: byId.get(item.memory.id) } }));
      factReview = resolved.review;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ query: retrievalFingerprint(input), factPolicy: FACT_POLICY,
      groupLimit: this.factGroupLimit, requireUserConfirmed: policy.requireUserConfirmed ?? false })).digest("base64url");
    const cursor = decodeRetrievalCursor(input.cursor, fingerprint);
    const afterCursor = cursor ? ranked.filter((item) => item.score < cursor.score
      || (item.score === cursor.score && (item.memory.updatedAt < cursor.timestamp
        || (item.memory.updatedAt === cursor.timestamp && item.memory.id < cursor.id)))) : ranked;
    const page = afterCursor.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const pageItems = hasMore ? page.slice(0, input.limit) : page;
    const memories = pageItems.map((item) => ({
      ...item.memory,
      retrieval: { ...item.memory.retrieval, score: item.score, channels: uniqueChannels(item.channels), ranks: item.ranks },
    }));
    const last = pageItems.at(-1);
    return {
      memories,
      nextCursor: hasMore && last ? encodeRetrievalCursor(last.score, last.memory.updatedAt, last.memory.id, fingerprint) : null,
      retrieval: { mode: "hybrid", channels: uniqueChannels(channels), candidateCount: ranked.length, candidateLimit: this.candidateLimit, ...(factReview ? { factReview } : {}) },
    };
  }

  async reviewFacts(input: ParsedRecallInput, memories: ResolvedMemory[], requireUserConfirmed = false) {
    return resolveFacts(memories.map(memory => ({ memory, score: memory.retrieval?.score ?? 0,
      exactTier: memory.retrieval?.exactTier ?? 0, retrieval: memory.retrieval ?? { score: 0, channels: [], ranks: {} } })),
    this.store, input, { requireUserConfirmed, groupLimit: this.factGroupLimit });
  }

  /** Report the active pipeline, not assumptions derived solely from a storage profile. */
  capabilityPolicy() {
    return { scored: Boolean(this.candidates), channels: [...this.enabledChannels], candidateLimit: this.candidateLimit,
      rrfK: this.rrfK, exactPrecedence: this.exactPrecedence, factGroupLimit: this.factGroupLimit };
  }

  private async recallCandidates(input: ParsedRecallInput, requireUserConfirmed: boolean): Promise<RecallResult> {
    const configuration = { rankingVersion: RANKING_VERSION, candidateLimit: this.candidateLimit, rrfK: this.rrfK,
      channels: [...this.enabledChannels].sort(), exactPrecedence: this.exactPrecedence, fusion: this.fusion, requireUserConfirmed,
      factPolicy: FACT_POLICY, factGroupLimit: this.factGroupLimit };
    const fingerprint = createHash("sha256").update(JSON.stringify({ queryFingerprint: retrievalFingerprint(input), configuration })).digest("base64url");
    // Validate before issuing reads; old ranking cursors require restarting from page one.
    const cursor = decodeRetrievalCursor(input.cursor, fingerprint, true);
    const { cursor: _cursor, ...request } = input;
    const batches = await this.candidates!.retrieve({ ...request, limit: this.candidateLimit, requireUserConfirmed }, [...this.enabledChannels]);
    for (const batch of batches) for (const { memory } of batch.hits) {
      if ((!input.includePrivate && memory.sensitivity === "private") || (requireUserConfirmed && !memory.userConfirmed)
        || (memory.scope === "agent" && memory.ownerAgentId !== input.agentId) || (memory.scope === "task" && memory.taskId !== input.taskId)
        || (input.key && memory.key !== input.key) || (input.kind && memory.kind !== input.kind) || (input.scope && memory.scope !== input.scope)) {
        throw new OpenContinuityError("STORAGE_ERROR", "Candidate eligibility contract violated", 500);
      }
    }
    const ranking = rankEvidence(batches, { rrfK: this.rrfK, exactPrecedence: this.exactPrecedence, fusion: this.fusion });
    const { ranked, review } = await resolveFacts(ranking, this.store, input, { requireUserConfirmed, groupLimit: this.factGroupLimit });
    const remaining = cursor ? ranked.filter(item => item.exactTier < cursor.exactTier!
      || (item.exactTier === cursor.exactTier && (item.score < cursor.score || (item.score === cursor.score
        && (item.memory.updatedAt < cursor.timestamp || (item.memory.updatedAt === cursor.timestamp && item.memory.id < cursor.id)))))) : ranked;
    const page = remaining.slice(0,input.limit),last = page.at(-1);
    return { memories: page.map(item => ({ ...item.memory, retrieval: item.retrieval })),
      nextCursor: remaining.length > input.limit && last ? encodeRetrievalCursor(last.score,last.memory.updatedAt,last.memory.id,fingerprint,last.exactTier) : null,
      retrieval: { mode: "hybrid", channels: (["exact", "structured", "full_text"] as const).filter(c => ranked.some(item => item.retrieval.channels.includes(c))), candidateCount: ranked.length, candidateLimit: this.candidateLimit,
        path: "scored_candidates", rankingVersion: RANKING_VERSION, truncated: batches.some(b => b.truncated),
        factReview: review,
        channelResults: batches.map(({ hits, ...batch }) => ({ ...batch, candidateCount: hits.length })) } };
  }


  private fuse(hitLists: RetrieverHit[][]): RankedMemory[] {
    const ranked = new Map<string, RankedMemory>();
    for (const hitList of hitLists) {
      hitList.forEach((hit, index) => {
        const rank = index + 1;
        const current = ranked.get(hit.memory.id) ?? { memory: hit.memory, score: 0, channels: new Set<RetrievalChannel>(), ranks: {} };
        current.score += 1 / (this.rrfK + rank);
        current.channels.add(hit.channel);
        current.ranks[hit.channel] = rank;
        ranked.set(hit.memory.id, current);
      });
    }
    return [...ranked.values()].sort(sortRanked);
  }
}
