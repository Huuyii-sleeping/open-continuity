import { z } from "zod";
import { OpenContinuityError } from "../../shared/errors.js";
import type { ContextCoverageRequirement, ContextPackResult, ParsedContextPackInput, ContextSelectionReason, ContextSelectionSignal, ResolvedMemory } from "../../shared/types.js";
export const CONTEXT_SELECTION_VERSION = "context-selection-v2" as const;
const policySchema = z.object({
  defaultTokenBudget: z.number().int().min(64).max(32768),
  maxTokenBudget: z.number().int().min(64).max(32768),
  maxMemories: z.number().int().min(1).max(100),
  requireUserConfirmed: z.boolean().default(false),
  selectionMode: z.enum(["relevance_first", "relevance_only", "legacy_weighted"]).default("relevance_first"),
  queryPacking: z.enum(["query_coverage", "rank_only"]).default("query_coverage"),
}).strict().refine(policy => policy.defaultTokenBudget <= policy.maxTokenBudget);
export type ContextPackPolicy = z.input<typeof policySchema>;
export type ResolvedContextPackPolicy = z.output<typeof policySchema>;
export function resolveContextPackPolicy(input: ContextPackPolicy): Readonly<ResolvedContextPackPolicy> {
  const result = policySchema.safeParse(input);
  if (!result.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid context policy", 400);
  return Object.freeze(result.data);
}


export interface SelectedContextCandidate {
  memory: ResolvedMemory; priority: number; reasons: ContextSelectionReason[]; selection: ContextSelectionSignal;
}

/** Query response composition needs a packer, not its retrieval or constructor. */
export interface ContextMemoryPacker {
  buildFromMemories(input: ParsedContextPackInput, memories: ResolvedMemory[], retrieval?: ContextPackResult["retrieval"], requirements?: ContextCoverageRequirement[]): ContextPackResult;
}
