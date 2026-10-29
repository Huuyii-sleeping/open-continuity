import { OpenContinuityError } from "../../../shared/errors.js";
import type { ContextSelectionReason, ContextSelectionSignal, ParsedContextPackInput, ResolvedMemory } from "../../../shared/types.js";
import { type ResolvedContextPackPolicy, type SelectedContextCandidate } from "../contracts.js";
import { PURPOSE_WEIGHT } from "./purpose.js";
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid context candidate evidence", 500); }
export function contextSelectionSignals(input: ParsedContextPackInput, eligible: { memory: ResolvedMemory; inputRank: number }[], policy: Readonly<ResolvedContextPackPolicy>, fallback: boolean): SelectedContextCandidate[] {
  const ranked: SelectedContextCandidate[] = eligible.map(({ memory, inputRank }, index) => {
    const purposeWeight = PURPOSE_WEIGHT[input.purpose][memory.kind];
    const reasons: ContextSelectionReason[] = (memory.retrieval?.channels ?? []).map(channel =>
      channel === "exact" ? "retrieval_exact" : channel === "structured" ? "retrieval_structured" : channel === "dense" ? "retrieval_dense" : "retrieval_full_text");
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
  return ranked;
}
