import type { AgenticEvidence, AgenticQueryResult, AgenticQueryStepReceipt, ParsedAgenticQueryInput } from "../../shared/types.js";
import type { PlannedQuery } from "./contracts.js";
import { assessQuerySufficiency } from "./sufficiency.js";
export function assessBudgetedQuery(input: ParsedAgenticQueryInput, plan: PlannedQuery, evidence: AgenticEvidence[], packed: AgenticEvidence[], coveredQueries: number, stoppedReason: AgenticQueryResult["execution"]["stoppedReason"], historyTruncated: boolean, candidateTruncated: boolean, steps: AgenticQueryStepReceipt[]): AgenticQueryResult["sufficiency"] {
  const sufficiency = assessQuerySufficiency(input, plan, packed, coveredQueries, stoppedReason, 0, historyTruncated);
  if (evidence.length && !packed.length) sufficiency.reasons.push("empty_context");
  if (packed.length < evidence.length) sufficiency.reasons.push("context_budget");
  if (plan.historyRequested) sufficiency.reasons.push("history_not_projected");
  if (plan.subqueryLimitApplied) sufficiency.reasons.push("subquery_limit");
  if (candidateTruncated) sufficiency.reasons.push("candidate_limit");
  if (steps.some(step => step.factReview?.omitted.some(item => item.assessment.status === "conflict"))) sufficiency.reasons.push("fact_conflict");
  if (sufficiency.status === "sufficient" && candidateTruncated) sufficiency.status = "partial";
  return sufficiency;
}
