import type { AgenticQueryResult } from "../../shared/types.js";
import type { PlannedQuery } from "./contracts.js";
export function queryFallback(plan: PlannedQuery, historyTruncated: boolean, stoppedReason: AgenticQueryResult["execution"]["stoppedReason"], sufficiency: AgenticQueryResult["sufficiency"]): AgenticQueryResult["fallback"] {
  const fallbackReasons: AgenticQueryResult["fallback"]["reasons"] = [];
  if (plan.unsupportedComplexity) fallbackReasons.push("unsupported_complexity");
  if (plan.subqueryLimitApplied) fallbackReasons.push("subquery_limit");
  if (historyTruncated) fallbackReasons.push("history_limit");
  if (stoppedReason === "max_steps") fallbackReasons.push("max_steps");
  if (stoppedReason === "timeout") fallbackReasons.push("timeout");
  if (sufficiency.status !== "sufficient") fallbackReasons.push("insufficient_evidence");
  return { used: fallbackReasons.length > 0, reasons: [...new Set(fallbackReasons)], mode: "deterministic" };
}
