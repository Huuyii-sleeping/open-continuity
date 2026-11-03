import { type FactGroupRequest } from "../../core/facts/contracts.js";
import type { MemoryReceiptLike, MemoryStore } from "../../core/memory/contracts.js";
import { assertStructuredInput, type MemoryRepository, type StructuredMemoryInput } from "../../core/memory/storage-contract.js";
import type { CandidateSearchRequest, CandidateSearchResult, CandidateSearchStore } from "../../core/retrieval/contracts.js";
import { dispatchCandidateSearch } from "../../core/retrieval/readers.js";
import { memoryEventSchema, type HistoryResult, type MemoryEvent, type ParsedHistoryInput, type ParsedRecallInput, type ParsedRememberInput, type RecallResult, type ResolvedMemory } from "../../shared/types.js";
import type { InMemoryOperations } from "./contracts.js";
import { replayInMemoryEvent } from "./events/replay.js";
import { createInMemoryCandidateReaders } from "./readers/index.js";
import { factGroupInMemory } from "./records/facts.js";
import { historyInMemory } from "./records/history.js";
import { listInMemory } from "./records/list.js";
import { forgetInMemory } from "./writes/forget.js";
import { rememberInMemory } from "./writes/remember.js";


export class InMemoryStore implements MemoryStore, MemoryRepository, CandidateSearchStore {
  readonly handoffReviewVersion = "handoff-review-v1" as const;
  readonly candidateReaders = createInMemoryCandidateReaders({
    current: () => this.resolved.values(),
    belongsToUser: (memory, userId) => this.belongsToUser(memory, userId),
    isVisible: (memory, agentId, taskId) => this.isVisible(memory, agentId, taskId),
  });
  private readonly events: MemoryEvent[] = [];
  private readonly resolved = new Map<string, ResolvedMemory>();
  private readonly idempotency = new Map<string, MemoryReceiptLike>();
  private readonly eventOwners = new Map<string, string>();
  private readonly operations: InMemoryOperations = { state: { events: this.events, resolved: this.resolved, idempotency: this.idempotency, eventOwners: this.eventOwners }, belongsToUser: (memory, userId) => this.belongsToUser(memory, userId), isVisible: (memory, agentId, taskId) => this.isVisible(memory, agentId, taskId) };

  constructor(initialEvents: MemoryEvent[] = []) {
    for (const event of initialEvents) this.applyEvent(memoryEventSchema.parse(structuredClone(event)));
  }

  allEvents(): MemoryEvent[] {
    return structuredClone(this.events);
  }

  appendRemember(input: ParsedRememberInput): MemoryReceiptLike { return rememberInMemory(this.operations, input); }

  appendForget(userId: string, agentId: string, memoryId: string, taskId?: string, includePrivate = false): MemoryReceiptLike { return forgetInMemory(this.operations, userId, agentId, memoryId, taskId, includePrivate); }

  list(input: StructuredMemoryInput): RecallResult { assertStructuredInput(input); return this.read(input); }
  recall(input: ParsedRecallInput): RecallResult {
    return input.query === undefined ? this.list(input as StructuredMemoryInput) : this.read(input);
  }
  private read(input: ParsedRecallInput): RecallResult { return listInMemory(this.operations, input); }
  searchCandidates(request: CandidateSearchRequest): CandidateSearchResult {
    return dispatchCandidateSearch(request, this.candidateReaders);
  }
  history(input: ParsedHistoryInput): HistoryResult { return historyInMemory(this.operations, input); }
  readFactGroup(request: FactGroupRequest) { return factGroupInMemory(this.operations, request); }
  private belongsToUser(memory: ResolvedMemory, userId: string): boolean { return this.eventOwners.get(memory.sourceEventId) === userId; }
  private isVisible(memory: ResolvedMemory, agentId: string, taskId?: string): boolean {
    if (memory.scope === "agent") return memory.ownerAgentId === agentId;
    if (memory.scope === "task") return Boolean(taskId) && memory.taskId === taskId;
    return true;
  }

  private applyEvent(event: MemoryEvent): void { return replayInMemoryEvent(this.operations, event); }
}
