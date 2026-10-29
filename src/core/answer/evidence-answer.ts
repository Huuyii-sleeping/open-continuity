export { citationFor } from "./citations.js";
import { isDeepStrictEqual } from "node:util";
import type { AgenticEvidence, AgenticQueryResult, ContextPackResult, EvidenceAnswer } from "../../shared/types.js";
import { contextContractError } from "../context/coverage.js";
import { projectEvidenceStatements } from "./statements.js";
import { validateAnswerEvidence } from "./validation.js";


/** Verbatim memory projection, never model synthesis. Only budgeted, exact-version evidence can be cited. */
export function composeEvidenceAnswer(pack: ContextPackResult, evidence: AgenticEvidence[], sufficiency: AgenticQueryResult["sufficiency"], historyRequested: boolean): EvidenceAnswer {
  const { byId, coverage } = validateAnswerEvidence(pack, evidence, sufficiency);
  const { statements, citations } = projectEvidenceStatements(pack, byId);
  const limitations: EvidenceAnswer["limitations"] = ["no_semantic_synthesis", "not_truth_verification"];
  if (historyRequested) limitations.push("history_not_projected");
  return {
    version: "evidence-answer-v1", mode: "memory_projection",
    status: !statements.length ? "abstain" : sufficiency.status === "sufficient" ? "evidence_ready" : "partial",
    statements, citations, coverage: structuredClone(coverage), reasons: [...sufficiency.reasons], limitations
  };
}

/** Local structural verification; never verifies objective truth or authorizes a caller. */
export function validateEvidenceAnswer(answer: EvidenceAnswer, pack: ContextPackResult, evidence: AgenticEvidence[],
  sufficiency: AgenticQueryResult["sufficiency"], historyRequested: boolean): void {
  if (!isDeepStrictEqual(answer, composeEvidenceAnswer(pack, evidence, sufficiency, historyRequested))) contextContractError();
}
