import { createHash } from "node:crypto";
import { decodeRetrievalCursor, encodeRetrievalCursor } from "./cursor.js";
import type { MemoryStore } from "./memory-store.js";
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
    return (await this.store.recall(this.buildInput(input))).memories;
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

  constructor(store: MemoryStore, options: RetrievalPipelineOptions = {}, retrievers?: Partial<{ exact: MemoryRetriever; structured: MemoryRetriever; fullText: MemoryRetriever }>) {
    this.store = store;
    this.candidateLimit = options.candidateLimit ?? 50;
    this.rrfK = options.rrfK ?? 60;
    this.enabledChannels = new Set(options.channels ?? ["exact", "structured", "full_text"]);
    const defaults = createDefaultRetrievers(store, this.candidateLimit);
    this.retrievers = { ...defaults, ...retrievers };
  }

  async recall(input: ParsedRecallInput): Promise<RecallResult> {
    if (!input.query?.trim()) return this.store.recall(input);

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

    const ranked = this.fuse(hits);
    const fingerprint = retrievalFingerprint(input);
    const cursor = decodeRetrievalCursor(input.cursor, fingerprint);
    const afterCursor = cursor ? ranked.filter((item) => item.score < cursor.score
      || (item.score === cursor.score && (item.memory.updatedAt < cursor.timestamp
        || (item.memory.updatedAt === cursor.timestamp && item.memory.id < cursor.id)))) : ranked;
    const page = afterCursor.slice(0, input.limit + 1);
    const hasMore = page.length > input.limit;
    const pageItems = hasMore ? page.slice(0, input.limit) : page;
    const memories = pageItems.map((item) => ({
      ...item.memory,
      retrieval: { score: item.score, channels: uniqueChannels(item.channels), ranks: item.ranks },
    }));
    const last = pageItems.at(-1);
    return {
      memories,
      nextCursor: hasMore && last ? encodeRetrievalCursor(last.score, last.memory.updatedAt, last.memory.id, fingerprint) : null,
      retrieval: { mode: "hybrid", channels: uniqueChannels(channels), candidateCount: ranked.length, candidateLimit: this.candidateLimit },
    };
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
