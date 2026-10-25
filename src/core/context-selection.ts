import { z } from "zod";
import { OpenContinuityError } from "../shared/errors.js";
import type { ContextSelectionReceipt, ContextSelectionReason, ContextSelectionSignal, ParsedContextPackInput, ResolvedMemory } from "../shared/types.js";

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

// Preference is an ordinal tie-break, not an additive relevance boost. Its bound is 12.
const PURPOSE_WEIGHT = {
  general: { user_preference: 8, user_fact: 6, task_state: 7, decision: 7 },
  coding: { task_state: 12, decision: 10, user_preference: 8, user_fact: 5 },
  research: { decision: 12, user_fact: 10, task_state: 7, user_preference: 5 },
  browser: { user_preference: 12, user_fact: 6, task_state: 10, decision: 5 },
} as const;
export interface SelectedContextCandidate {
  memory: ResolvedMemory; priority: number; reasons: ContextSelectionReason[]; selection: ContextSelectionSignal;
}
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid context candidate evidence", 500); }

/** Only consumes authorized Retrieval evidence. It does not query the Store or infer relevance. */
export function selectContextCandidates(input: ParsedContextPackInput, memories: ResolvedMemory[], policy: Readonly<ResolvedContextPackPolicy>) {
  const eligible = memories.map((memory, index) => ({ memory, inputRank: index + 1 }))
    .filter(({ memory }) => !policy.requireUserConfirmed || memory.userConfirmed);
  for (const { memory } of eligible) {
    if ((!input.includePrivate && memory.sensitivity === "private")
      || (memory.scope === "agent" && memory.ownerAgentId !== input.agentId)
      || (memory.scope === "task" && (!input.taskId || memory.taskId !== input.taskId))
      || (input.key && memory.key !== input.key) || (input.kind && memory.kind !== input.kind)
      || (input.scope && memory.scope !== input.scope)) invalid();
    const evidence = memory.retrieval;
    if (evidence && (!Number.isFinite(evidence.score) || evidence.score < 0
      || (evidence.exactTier !== undefined && ![0, 1].includes(evidence.exactTier)))) invalid();
  }
  // A missing score cannot safely be placed on a scored scale; preserve the upstream order.
  const allScored = eligible.every(({ memory }) => memory.retrieval !== undefined);
  const fallback = !allScored && policy.selectionMode !== "legacy_weighted";
  const order: ContextSelectionReceipt["order"] = policy.selectionMode === "legacy_weighted" ? "legacy_weighted"
    : fallback ? "input_order" : policy.selectionMode === "relevance_only" ? "exact_score_updated_id" : "exact_score_purpose_updated_id";
  const receipt: ContextSelectionReceipt = {
    version: CONTEXT_SELECTION_VERSION, mode: policy.selectionMode, order,
    priorityModel: policy.selectionMode === "legacy_weighted" ? "legacy_weighted" : fallback ? "input_position" : "retrieval_score",
    purposePreferenceMax: policy.selectionMode !== "relevance_only" && !fallback ? 12 : 0,
    scopeBoostMax: policy.selectionMode === "legacy_weighted" ? 20 : 0,
    confirmationBoost: policy.selectionMode === "legacy_weighted" ? 10 : 0,
    fallbackReason: fallback ? "missing_retrieval_score" : null,
    inputCount: memories.length, eligibleCount: eligible.length,
    confirmationFilteredCount: memories.length - eligible.length,
  };
  const ranked: SelectedContextCandidate[] = eligible.map(({ memory, inputRank }, index) => {
    const purposeWeight = PURPOSE_WEIGHT[input.purpose][memory.kind];
    const reasons: ContextSelectionReason[] = (memory.retrieval?.channels ?? []).map(channel =>
      channel === "exact" ? "retrieval_exact" : channel === "structured" ? "retrieval_structured" : "retrieval_full_text");
    if (memory.scope === "task") reasons.push("task_scope");
    if (memory.scope === "agent") reasons.push("agent_scope");
    if (memory.userConfirmed) reasons.push("user_confirmed");
    reasons.push(`purpose_${input.purpose}`);
    const score = memory.retrieval?.score ?? null;
    const tier = memory.retrieval?.exactTier ?? 0;
    const preference = policy.selectionMode !== "relevance_only" && !fallback ? purposeWeight : 0;
    let priority = fallback ? eligible.length - index : score ?? 0;
    if (policy.selectionMode === "legacy_weighted") {
      priority = Number(((score ?? 0) * 1000 + (memory.scope === "task" ? 20 : memory.scope === "agent" ? 15 : 0)
        + (memory.userConfirmed ? 10 : 0) + purposeWeight).toFixed(6));
    }
    if (!Number.isFinite(priority)) invalid();
    const selection: ContextSelectionSignal = {
      inputRank, exactTier: tier, retrievalScore: score,
      scoreModel: memory.retrieval ? memory.retrieval.scoreModel ?? "legacy_positional" : null,
      purposePreference: preference,
    };
    return { memory, priority, reasons, selection };
  });
  ranked.sort((a, b) => {
    if (fallback) return a.selection.inputRank - b.selection.inputRank;
    const difference = policy.selectionMode === "legacy_weighted" ? b.priority - a.priority
      : b.selection.exactTier - a.selection.exactTier || b.selection.retrievalScore! - a.selection.retrievalScore!
        || b.selection.purposePreference - a.selection.purposePreference;
    return difference || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id);
  });
  return { ranked, receipt };
}
