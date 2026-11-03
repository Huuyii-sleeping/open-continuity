import type { ResolvedMemory } from "../../../../shared/types.js";
import type { RelevanceReceipt } from "../../reranking/contracts.js";
import { OpenContinuityError } from "../../../../shared/errors.js";
export interface VectorRankedMemory { memory: ResolvedMemory; score: number; }
/** Relevance ordering is independent of the caller's cosine/support admission thresholds. */
export function orderDenseWindow(window: readonly VectorRankedMemory[], receipt: RelevanceReceipt): VectorRankedMemory[] {
  if (receipt.status !== "scored" || receipt.scores.length !== window.length || new Set(window.map(entry => entry.memory.id)).size !== window.length)
    throw new OpenContinuityError("STORAGE_ERROR", "Incomplete relevance ordering", 500);
  const relevance = new Map(receipt.scores.map(score => [score.memoryId, score.value]));
  if (relevance.size !== window.length || window.some(entry => !Number.isFinite(relevance.get(entry.memory.id))))
    throw new OpenContinuityError("STORAGE_ERROR", "Invalid relevance ordering", 500);
  return [...window].sort((a, b) => relevance.get(b.memory.id)! - relevance.get(a.memory.id)! || b.score - a.score
    || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id));
}
