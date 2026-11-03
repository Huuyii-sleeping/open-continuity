import { z } from "zod";
import { OpenContinuityError } from "../../shared/errors.js";
import type { AgenticQueryPlanStep, MemoryEvent, ParsedRecallInput, QueryComplexity, ResolvedMemory } from "../../shared/types.js";
import type { FactResolutionResult } from "../facts/contracts.js";
import type { RecallReader } from "../retrieval/contracts.js";

export interface QueryEvidenceReader extends RecallReader {
  reviewFacts(input: ParsedRecallInput, memories: ResolvedMemory[], requireUserConfirmed?: boolean): Promise<FactResolutionResult>;
}
export interface AgenticQueryPolicy {
  defaultMaxSteps: number; maxSteps: number; defaultTimeoutMs: number; maxTimeoutMs: number; maxSubqueries: number; historyLimit: number;
}
export function resolveAgenticQueryPolicy(input: AgenticQueryPolicy): Readonly<AgenticQueryPolicy> {
  const parsed = z.object({
    defaultMaxSteps: z.number().int().min(1).max(8), maxSteps: z.number().int().min(1).max(8),
    defaultTimeoutMs: z.number().int().min(10).max(30000), maxTimeoutMs: z.number().int().min(10).max(30000),
    maxSubqueries: z.number().int().min(1).max(8), historyLimit: z.number().int().min(1).max(100),
  }).strict().refine(policy => policy.defaultMaxSteps <= policy.maxSteps && policy.defaultTimeoutMs <= policy.maxTimeoutMs).safeParse(input);
  if (!parsed.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid query policy", 400);
  return Object.freeze(parsed.data);
}

export interface PlannedQuery {
  id: string; complexity: QueryComplexity; strategy: "direct" | "multi_step"; rationale: string[]; queries: string[];
  steps: AgenticQueryPlanStep[]; requestedQueries: string[]; totalQueries: number; historyRequested: boolean; unsupportedComplexity: boolean; subqueryLimitApplied: boolean;
}

export interface EvidenceAccumulator { memory: ResolvedMemory; matchedQueries: Set<string>; stepIds: Set<string>; score: number; }
export interface HistoryExpansion { events: MemoryEvent[]; truncatedMemoryIds: Set<string>; truncated: boolean; }
