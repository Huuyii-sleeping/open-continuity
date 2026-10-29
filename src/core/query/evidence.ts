import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../../shared/errors.js";
import type { AgenticEvidence, MemoryEvent, ResolvedMemory, RetrievalChannel } from "../../shared/types.js";
import { memoryProjection } from "../context/coverage.js";
import type { EvidenceAccumulator } from "./contracts.js";
export function combineRetrieval(left: ResolvedMemory["retrieval"], right: ResolvedMemory["retrieval"], score: number, query: string, stepId: string): ResolvedMemory["retrieval"] {
  const channels = [...new Set([...(left?.channels ?? []), ...(right?.channels ?? [])])];
  const ranks: Partial<Record<RetrievalChannel, number>> = { ...(left?.ranks ?? {}) };
  for (const [channel, rank] of Object.entries(right?.ranks ?? {}) as Array<[RetrievalChannel, number]>) ranks[channel] = Math.min(ranks[channel] ?? rank, rank);
  const evidence = [...(left?.evidence ?? []), ...(right?.evidence ?? []).map(item => ({ ...item, query, stepId }))];
  return {
    score: Number(score.toFixed(8)), channels, ranks, ...(right?.factAssessment ? { factAssessment: right.factAssessment } : {}), ...(right?.rankingVersion ? {
      rankingVersion: right.rankingVersion, scoreModel: "query_sum" as const, fusedScore: null,
      exactTier: Math.max(left?.exactTier ?? 0, right.exactTier ?? 0), evidence,
      selectionReasons: [...new Set([...(left?.selectionReasons ?? []), ...(right.selectionReasons ?? [])])],
    } : {})
  };
}
export function mergeQueryEvidence(evidenceById: Map<string, EvidenceAccumulator>, memories: ResolvedMemory[], query: string, stepId: string): void {
  memories.forEach((memory, index) => {
    const current = evidenceById.get(memory.id) ?? { memory, matchedQueries: new Set<string>(), stepIds: new Set<string>(), score: 0 };
    if (!isDeepStrictEqual(memoryProjection(current.memory), memoryProjection(memory))) {
      throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent query evidence versions", 500);
    }
    const previousRetrieval = current.score === 0 ? undefined : current.memory.retrieval;
    current.score += memory.retrieval?.score ?? 1 / (60 + index + 1);
    current.memory = { ...current.memory, ...memory, retrieval: combineRetrieval(previousRetrieval, memory.retrieval, current.score, query, stepId) };
    current.matchedQueries.add(query); current.stepIds.add(stepId); evidenceById.set(memory.id, current);
  });
}
export function materializeEvidence(accumulators: Map<string, EvidenceAccumulator>, events: MemoryEvent[], historyRequested: boolean, truncatedMemoryIds: Set<string>): AgenticEvidence[] {
  const historyByMemory = new Map<string, MemoryEvent[]>();
  for (const event of events) historyByMemory.set(event.memoryId, [...(historyByMemory.get(event.memoryId) ?? []), event]);
  return [...accumulators.values()].sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id)).map((item) => {
    const history = historyByMemory.get(item.memory.id) ?? [];
    return { memory: item.memory, matchedQueries: [...item.matchedQueries], stepIds: [...item.stepIds], score: Number(item.score.toFixed(8)), ...(historyRequested ? { history: { eventCount: history.length, versions: [...new Set(history.map((event) => event.memoryVersion).filter((value): value is number => value !== undefined))].sort((a, b) => a - b), eventIds: history.map((event) => event.id), truncated: truncatedMemoryIds.has(item.memory.id) } } : {}) };
  });
}
