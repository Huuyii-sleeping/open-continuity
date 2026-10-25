import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgenticEvidence, AgenticQueryResult, ContextPackItem, ContextPackResult, EvidenceAnswer, EvidenceCitation, EvidenceStatement } from "../shared/types.js";
import { contextContractError } from "./context-coverage.js";
import { jsonValueSchema } from "../shared/types.js";

function projection(item: ContextPackItem) {
  return { key: item.key, value: item.value, kind: item.kind, scope: item.scope, taskId: item.taskId,
    fact: item.fact, memoryId: item.memoryId, sourceEventId: item.sourceEventId, version: item.version, sourceAgentId: item.sourceAgentId };
}
export function citationFor(item: ContextPackItem): EvidenceCitation {
  if (!item.memoryId || !item.sourceEventId || !item.sourceAgentId || !Number.isInteger(item.version) || item.version < 1
    || !jsonValueSchema.safeParse(item.value).success) contextContractError();
  const contentHash = createHash("sha256").update(JSON.stringify(projection(item))).digest("hex");
  const id = "memory:" + createHash("sha256").update(JSON.stringify([item.memoryId, item.sourceEventId, item.version, contentHash])).digest("base64url");
  return { id, memoryId: item.memoryId, sourceEventId: item.sourceEventId, version: item.version,
    sourceAgentId: item.sourceAgentId, contentHash, hashModel: "sha256-json-projection-v1" };
}

/** Verbatim memory projection, never model synthesis. Only budgeted, exact-version evidence can be cited. */
export function composeEvidenceAnswer(pack: ContextPackResult, evidence: AgenticEvidence[], sufficiency: AgenticQueryResult["sufficiency"], historyRequested: boolean): EvidenceAnswer {
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
  const statements: EvidenceStatement[] = [], citations: EvidenceCitation[] = [];
  for (const item of pack.items) {
    const memory = byId.get(item.memoryId);
    if (!memory || !isDeepStrictEqual(projection(item), projection({ ...item, key: memory.key, value: memory.value, kind: memory.kind,
      scope: memory.scope, taskId: memory.taskId, fact: memory.fact, sourceEventId: memory.sourceEventId, version: memory.version, sourceAgentId: memory.sourceAgentId }))
      || (item.fact && !memory.retrieval?.factAssessment?.usable)) contextContractError();
    const citation = citationFor(item);
    citations.push(citation);
    statements.push({ citationId: citation.id, key: item.key, value: structuredClone(item.value), kind: item.kind, scope: item.scope,
      ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.fact ? { fact: structuredClone(item.fact) } : {}),
      userConfirmed: memory.userConfirmed, verification: item.fact ? "visible_explicit_assertion" : "unverified_memory" });
  }
  const limitations: EvidenceAnswer["limitations"] = ["no_semantic_synthesis", "not_truth_verification"];
  if (historyRequested) limitations.push("history_not_projected");
  return { version: "evidence-answer-v1", mode: "memory_projection",
    status: !statements.length ? "abstain" : sufficiency.status === "sufficient" ? "evidence_ready" : "partial",
    statements, citations, coverage: structuredClone(pack.coverage), reasons: [...sufficiency.reasons], limitations };
}

/** Local structural verification; never verifies objective truth or authorizes a caller. */
export function validateEvidenceAnswer(answer: EvidenceAnswer, pack: ContextPackResult, evidence: AgenticEvidence[],
  sufficiency: AgenticQueryResult["sufficiency"], historyRequested: boolean): void {
  if (!isDeepStrictEqual(answer, composeEvidenceAnswer(pack, evidence, sufficiency, historyRequested))) contextContractError();
}
