import { isDeepStrictEqual } from "node:util";
import type { AgenticEvidence, AgenticQueryResult, ContextPackResult } from "../../shared/types.js";
import { contextContractError } from "../context/coverage.js";
export function validateAnswerEvidence(pack: ContextPackResult, evidence: AgenticEvidence[], sufficiency: AgenticQueryResult["sufficiency"]) {
  if (!pack.coverage) contextContractError();
  const byId = new Map(evidence.map(item => [item.memory.id, item.memory]));
  if (byId.size !== evidence.length || new Set(pack.items.map(item => item.memoryId)).size !== pack.items.length) contextContractError();
  const selectedIds = new Set(pack.items.map(item => item.memoryId));
  if (new Set(pack.coverage.requirements.map(row => row.id)).size !== pack.coverage.requirements.length
    || pack.coverage.totalQueries !== pack.coverage.requirements.length
    || pack.coverage.coveredQueries !== pack.coverage.requirements.filter(row => row.status === "covered").length) contextContractError();
  for (const row of pack.coverage.requirements) {
    const matches = evidence.filter(item => item.matchedQueries.includes(row.query));
    const selected = matches.filter(item => selectedIds.has(item.memory.id)).map(item => item.memory.id);
    if (row.retrievedCount !== matches.length || !isDeepStrictEqual(row.selectedMemoryIds, selected)
      || row.status !== (selected.length ? "covered" : "missing")) contextContractError();
  }
  if (sufficiency.evidenceCount !== pack.items.length || sufficiency.matchedQueries !== pack.coverage.coveredQueries
    || sufficiency.totalQueries !== pack.coverage.totalQueries || (sufficiency.status === "sufficient"
      && (!pack.items.length || pack.coverage.coveredQueries !== pack.coverage.totalQueries))) contextContractError();
  return { byId, coverage: pack.coverage };
}
