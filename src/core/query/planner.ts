import { createHash } from "node:crypto";
import { OpenContinuityError } from "../../shared/errors.js";
import type { ParsedAgenticQueryInput, AgenticQueryPlanStep, QueryComplexity } from "../../shared/types.js";
import type { AgenticQueryPolicy, PlannedQuery } from "./contracts.js";

const HISTORY_SIGNAL = /(?:history|historical|change|changed|evolution|previous|before|timeline|why|历史|变化|演化|之前|原因|决策过程)/i;

const MULTI_HOP_SIGNAL = /(?:relationship|related across|across projects|root cause|multi[- ]?hop|关系|跨项目|根因|多跳)/i;

const SPLIT_PATTERN = /(?:\s+&&\s+|\s+and\s+|\s+also\s+|\s+versus\s+|\s+vs\.?\s+|[;；]+|以及|并且|同时|对比|比较)/i;

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

function stripPlanningWords(value: string): string {
  const stripped = value
  .replace(/\b(?:history|historical|change|changed|evolution|previous|before|timeline|why|relationship|related across|across projects|root cause|multi[- ]?hop)\b/gi, " " )
  .replace(/(?:历史|变化|演化|之前|原因|决策过程|关系|跨项目|根因|多跳)/g, " " )
  .replace(/\s+/g, " " ).trim();
  return stripped || value.trim();
}

function planId(input: ParsedAgenticQueryInput, queries: string[]): string {
  return createHash("sha256").update(JSON.stringify({ query: input.query, queries, strategy: input.strategy, includeHistory: input.includeHistory, key: input.key ?? null, kind: input.kind ?? null, scope: input.scope ?? null, taskId: input.taskId ?? null })).digest("base64url").slice(0, 16);
}

export function createQueryPlan(input: ParsedAgenticQueryInput, policy: AgenticQueryPolicy): PlannedQuery {
  const split = unique((input.subqueries ?? (input.key ? [input.key] : input.query.split(SPLIT_PATTERN))).map(stripPlanningWords));
  const requestedQueries = input.strategy === "direct" ? [split[0] ?? input.query] : split;
  if (requestedQueries.length > 32) throw new OpenContinuityError("VALIDATION_ERROR", "Query plan exceeds the bounded obligation limit", 400);
  const queries = requestedQueries.slice(0, policy.maxSubqueries);
  const subqueryLimitApplied = requestedQueries.length > queries.length;
  const requestedHistory = input.includeHistory || HISTORY_SIGNAL.test(input.query);
  const historySignal = input.strategy !== "direct" && requestedHistory;
  const unsupportedComplexity = MULTI_HOP_SIGNAL.test(input.query);
  const complexity: QueryComplexity = unsupportedComplexity ? "L3" : historySignal || queries.length > 1 ? "L2" : input.key ? "L0" : "L1";
  const strategy = input.strategy === "direct" ? "direct" : input.strategy === "multi_step" || complexity === "L2" || complexity === "L3" ? "multi_step" : "direct";
  const rationale = [input.key ? "explicit_key" : "text_query"];
  if (queries.length > 1) rationale.push("query_decomposed");
  if (subqueryLimitApplied) rationale.push("subquery_limit_applied");
  if (historySignal) rationale.push("history_signal");
  if (requestedHistory && input.strategy === "direct") rationale.push("history_signal_ignored_by_direct_strategy");
  if (unsupportedComplexity) rationale.push("graph_or_semantic_reasoning_unavailable");
  const steps: AgenticQueryPlanStep[] = queries.map((query, index) => ({ id: `recall-${index + 1}`, type: "recall", query, reason: index === 0 ? "primary_query" : "subquery_coverage" }));
  if (strategy === "multi_step" && historySignal) steps.push({ id: "history-1", type: "history", reason: "evolution_evidence" });
  return { id: planId(input, queries), complexity, strategy, rationale, queries, steps, requestedQueries, totalQueries: requestedQueries.length, historyRequested: strategy === "multi_step" && historySignal, unsupportedComplexity, subqueryLimitApplied };
}
