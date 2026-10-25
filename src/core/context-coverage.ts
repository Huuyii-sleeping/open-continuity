import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import type { ContextCoverage, ContextCoverageRequirement, ContextPackOmission, ResolvedMemory } from "../shared/types.js";

export function contextContractError(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent context evidence", 500); }
export function memoryProjection(memory: ResolvedMemory) {
  const { retrieval: _retrieval, ...snapshot } = memory;
  return snapshot;
}
export function uniqueContextMemories(memories: ResolvedMemory[]) {
  const seen = new Map<string, ResolvedMemory>();
  for (const memory of memories) {
    const previous = seen.get(memory.id);
    if (previous && (!isDeepStrictEqual(memoryProjection(previous), memoryProjection(memory)) || !isDeepStrictEqual(previous.retrieval, memory.retrieval))) contextContractError();
    if (!previous) seen.set(memory.id, memory);
  }
  return { memories: [...seen.values()], duplicatesRemoved: memories.length - seen.size };
}
export function validateCoverageRequirements(requirements: ContextCoverageRequirement[], memories: ResolvedMemory[]) {
  if (requirements.length > 32 || new Set(requirements.map(item => item.id)).size !== requirements.length) contextContractError();
  const ids = new Set(memories.map(memory => memory.id));
  for (const requirement of requirements) if (!requirement.id || !requirement.query.trim()
    || requirement.memoryIds.length > 100 || new Set(requirement.memoryIds).size !== requirement.memoryIds.length
    || requirement.memoryIds.some(id => !ids.has(id))) contextContractError();
}
export function contextCoverage(requirements: ContextCoverageRequirement[], selected: Set<string>, omitted: ContextPackOmission[],
  policy: ContextCoverage["policy"], duplicatesRemoved: number, confirmationFiltered = new Set<string>()): ContextCoverage {
  const rows: ContextCoverage["requirements"] = requirements.map(item => {
    const selectedMemoryIds = item.memoryIds.filter(id => selected.has(id));
    const factRejected = item.memoryIds.length > 0 && item.memoryIds.every(id => omitted.some(row => row.memoryId === id && row.reason === "fact_unresolved"));
    const confirmationRejected = item.memoryIds.length > 0 && item.memoryIds.every(id => confirmationFiltered.has(id));
    return { id: item.id, query: item.query, retrievedCount: item.memoryIds.length, selectedMemoryIds,
      status: selectedMemoryIds.length ? "covered" : "missing",
      reason: selectedMemoryIds.length ? "selected_match" : !item.memoryIds.length ? "no_retrieved_match" : confirmationRejected ? "confirmation_required" : factRejected ? "fact_unresolved" : "context_budget" };
  });
  return { version: "context-coverage-v1", policy, meaning: "lexical_query_matches_not_semantic_answerability",
    requirements: rows, coveredQueries: rows.filter(row => row.status === "covered").length, totalQueries: rows.length, duplicatesRemoved };
}
