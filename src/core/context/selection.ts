import type { ContextSelectionReceipt, ParsedContextPackInput, ResolvedMemory } from "../../shared/types.js";
import { CONTEXT_SELECTION_VERSION, type ResolvedContextPackPolicy } from "./contracts.js";
import { eligibleContextMemories } from "./selection/eligibility.js";
import { orderByInput } from "./selection/input-order.js";
import { orderByLegacyWeight } from "./selection/legacy.js";
import { orderByRelevance } from "./selection/relevance.js";
import { contextSelectionSignals } from "./selection/signals.js";
export { CONTEXT_SELECTION_VERSION, resolveContextPackPolicy, type ContextPackPolicy, type ResolvedContextPackPolicy, type SelectedContextCandidate } from "./contracts.js";


/** Only consumes authorized Retrieval evidence. It does not query the Store or infer relevance. */
export function selectContextCandidates(input: ParsedContextPackInput, memories: ResolvedMemory[], policy: Readonly<ResolvedContextPackPolicy>) {
  const eligible = eligibleContextMemories(input, memories, policy);
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
  const ranked = contextSelectionSignals(input, eligible, policy, fallback);
  if (fallback) orderByInput(ranked);
  else if (policy.selectionMode === "legacy_weighted") orderByLegacyWeight(ranked);
  else orderByRelevance(ranked);
  return { ranked, receipt };
}
