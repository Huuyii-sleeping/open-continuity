import type { ParsedAgenticQueryInput, AgenticEvidence, AgenticQueryResult } from "../../shared/types.js";
import type { PlannedQuery } from "./contracts.js";

export function assessQuerySufficiency(input: ParsedAgenticQueryInput, plan: PlannedQuery, evidence: AgenticEvidence[], matchedQueries: number, stoppedReason: AgenticQueryResult["execution"]["stoppedReason"], historyCount: number, historyTruncated: boolean): AgenticQueryResult["sufficiency"] {
  const reasons: string[] = [];
  if (evidence.length === 0) reasons.push("no_evidence");
  if (evidence.length < input.minEvidence) reasons.push("below_min_evidence");
  if (matchedQueries < plan.totalQueries) reasons.push("partial_query_coverage");
  if (plan.historyRequested && historyCount === 0) reasons.push("missing_history_evidence");
  if (historyTruncated) reasons.push("history_limit");
  if (plan.unsupportedComplexity) reasons.push("unsupported_complexity");
  if (stoppedReason !== "completed") reasons.push(stoppedReason);
  const sufficient = !plan.unsupportedComplexity && !plan.subqueryLimitApplied && !historyTruncated && evidence.length >= input.minEvidence && matchedQueries === plan.totalQueries && (!plan.historyRequested || historyCount > 0) && stoppedReason === "completed";
  return { status: sufficient ? "sufficient" : evidence.length > 0 ? "partial" : "insufficient", matchedQueries, totalQueries: plan.totalQueries, evidenceCount: evidence.length, reasons };
}
