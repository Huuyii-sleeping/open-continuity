import { isDeepStrictEqual } from "node:util";
import type { ContextPackResult, EvidenceCitation, EvidenceStatement, ResolvedMemory } from "../../shared/types.js";
import { contextContractError } from "../context/coverage.js";
import { citationFor, projection } from "./citations.js";
export function projectEvidenceStatements(pack: ContextPackResult, byId: Map<string, ResolvedMemory>) {
  const statements: EvidenceStatement[] = [], citations: EvidenceCitation[] = [];
  for (const item of pack.items) {
    const memory = byId.get(item.memoryId);
    if (!memory || !isDeepStrictEqual(projection(item), projection({
      ...item, key: memory.key, value: memory.value, kind: memory.kind,
      scope: memory.scope, taskId: memory.taskId, fact: memory.fact, sourceEventId: memory.sourceEventId, version: memory.version, sourceAgentId: memory.sourceAgentId
    }))
      || (item.fact && !memory.retrieval?.factAssessment?.usable)) contextContractError();
    const citation = citationFor(item);
    citations.push(citation);
    statements.push({
      citationId: citation.id, key: item.key, value: structuredClone(item.value), kind: item.kind, scope: item.scope,
      ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.fact ? { fact: structuredClone(item.fact) } : {}),
      userConfirmed: memory.userConfirmed, verification: item.fact ? "visible_explicit_assertion" : "unverified_memory"
    });
  }
  return { statements, citations };
}
