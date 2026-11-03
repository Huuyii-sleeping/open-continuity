import type { ParsedAgenticQueryInput } from "../../shared/types.js";
import type { MemoryHistoryReader } from "../memory/storage-contract.js";
import type { EvidenceAccumulator, HistoryExpansion } from "./contracts.js";
import { type AgenticQueryPolicy } from "./contracts.js";

export async function loadQueryHistory(store: MemoryHistoryReader, policy: AgenticQueryPolicy, input: ParsedAgenticQueryInput, accumulators: Map<string, EvidenceAccumulator>): Promise<HistoryExpansion> {
  const ranked = [...accumulators.values()].sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id));
  const targets = ranked.slice(0, Math.min(policy.maxSubqueries, policy.historyLimit));
  const truncatedMemoryIds = new Set(ranked.slice(targets.length).map((item) => item.memory.id));
  const baseLimit = Math.floor(policy.historyLimit / targets.length);
  const remainder = policy.historyLimit % targets.length;
  const pages = await Promise.all(targets.map((item, index) => Promise.resolve(store.history({
    userId: input.userId, agentId: input.agentId, memoryId: item.memory.id, taskId: input.taskId, includePrivate: input.includePrivate,
    limit: baseLimit + (index < remainder ? 1 : 0), cursor: undefined,
  }))));
  pages.forEach((page, index) => { if (page.nextCursor) truncatedMemoryIds.add(targets[index]!.memory.id); });
  const events = pages.flatMap((page) => page.events).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return { events, truncatedMemoryIds, truncated: truncatedMemoryIds.size > 0 };
}
