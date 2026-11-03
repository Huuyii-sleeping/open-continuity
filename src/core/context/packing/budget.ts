import type { ContextPackItem, ContextPackOmission } from "../../../shared/types.js";
import { estimateContextTokens, renderMemory } from "../rendering.js";
import type { SelectedContextCandidate } from "../selection.js";
import type { PackingState } from "./contracts.js";
export function createPackingState(requestedTokens: number, maxMemories: number): PackingState {
  const items: ContextPackItem[] = [];
  const omitted: ContextPackOmission[] = [];
  const lines: string[] = [];
  let usedTokens = 0;

  const accepted = new Set<string>();
  const rejected = new Set<string>();
  const append = (candidate: SelectedContextCandidate) => {
    const line = renderMemory(candidate.memory);
    const estimatedTokens = estimateContextTokens(line);
    if (candidate.memory.fact && !candidate.memory.retrieval?.factAssessment?.usable) {
      omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "fact_unresolved" });
      rejected.add(candidate.memory.id); return false;
    }
    if (items.length >= maxMemories) {
      omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "max_memories" });
      rejected.add(candidate.memory.id); return false;
    }
    const nextContext = lines.length === 0 ? line : lines.join("\n") + "\n" + line;
    const nextUsedTokens = estimateContextTokens(nextContext);
    if (nextUsedTokens > requestedTokens) {
      omitted.push({ memoryId: candidate.memory.id, key: candidate.memory.key, estimatedTokens, reason: "token_budget" });
      rejected.add(candidate.memory.id); return false;
    }
    lines.push(line);
    usedTokens = nextUsedTokens;
    items.push({
      memoryId: candidate.memory.id, key: candidate.memory.key, value: candidate.memory.value, kind: candidate.memory.kind, scope: candidate.memory.scope,
      taskId: candidate.memory.taskId, estimatedTokens, priority: candidate.priority, reasons: candidate.reasons,
      sourceEventId: candidate.memory.sourceEventId, sourceAgentId: candidate.memory.sourceAgentId, updatedAt: candidate.memory.updatedAt,
      version: candidate.memory.version, supersedes: candidate.memory.supersedes, confidence: candidate.memory.confidence,
      retrieval: candidate.memory.retrieval,
      fact: candidate.memory.fact,
      selection: candidate.selection,
    });
    accepted.add(candidate.memory.id); return true;
  };
  return { items, omitted, lines, accepted, rejected, append, hasCapacity: () => items.length < maxMemories, get usedTokens() { return usedTokens; } };
}
