import { OpenContinuityError } from "../../../shared/errors.js";
import type { ResolvedMemory } from "../../../shared/types.js";
import type { BoundDensePairReceipt } from "./verification/contracts.js";

import type { DenseRescueReceipt, DenseSupportSelection } from "./rescue/contracts.js";
export type { DenseRescueReceipt } from "./rescue/contracts.js";

/** Pure final decision. The caller must validate every bound directional verdict first. */
export function decideDenseRescue(ids: readonly string[], mutualIds: readonly string[], populationCount: number, limit: number, early?: "score_gate_preserved" | "top_contradiction", generation: DenseRescueReceipt["generation"] = "authorized_cosine_top_k"): DenseRescueReceipt {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4 || !Number.isInteger(populationCount) || populationCount < 1 || populationCount > 20000
    || !["authorized_cosine_top_k", "reranked_vector_window"].includes(generation)
    || (early !== undefined && !["score_gate_preserved", "top_contradiction"].includes(early))
    || (early ? ids.length !== 1 || mutualIds.length !== 0 : ids.length !== Math.min(populationCount, limit))
    || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id.trim())
    || new Set(mutualIds).size !== mutualIds.length || mutualIds.some(id => !ids.includes(id)))
    throw new OpenContinuityError("STORAGE_ERROR", "Incomplete or invalid Dense rescue window", 500);
  return { version: "dense-bidirectional-rescue-v1", generation, limit, populationCount,
    windowMemoryIds: [...ids], mutualSupportedMemoryIds: [...mutualIds], outsideWindow: populationCount - ids.length,
    windowComplete: !early || Math.min(populationCount, limit) === 1,
    reason: early === "score_gate_preserved" && generation === "reranked_vector_window" ? "reranked_score_gate" : early ?? (mutualIds.length === 1 ? "unique_mutual_support" : mutualIds.length ? "ambiguous_mutual_support" : "no_mutual_support") };
}

export interface DenseRescueCandidate { memory: ResolvedMemory; score: number; }
/** IO is supplied through a bound verifier callback. Authorization/ranking/deadline belong to the caller. */
export async function verifyDenseRescue(ranked: readonly DenseRescueCandidate[], populationCount: number, limit: number, minScore: number, lexicalMatches: number,
  verify: (entry: DenseRescueCandidate, direction: "memory_to_query" | "query_to_memory") => Promise<BoundDensePairReceipt>, generation: DenseRescueReceipt["generation"] = "authorized_cosine_top_k"): Promise<DenseSupportSelection> {
  const pairs: BoundDensePairReceipt[] = [], reversePairs: BoundDensePairReceipt[] = [];
  const empty = (reason: string) => ({ accepted: [] as DenseRescueCandidate[], pairs, reversePairs, reason, rescue: undefined as DenseRescueReceipt | undefined });
  if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1 || !Number.isInteger(lexicalMatches) || lexicalMatches < 0)
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense rescue policy", 400);
  decideDenseRescue(ranked.slice(0, limit).map(entry => entry.memory.id), [], populationCount, limit, undefined, generation);
  const first = ranked[0]!;
  const contradiction = () => ({ ...empty("pair_rejected"), rescue: decideDenseRescue([first.memory.id], [], populationCount, limit, "top_contradiction", generation) });
  if (first.score >= minScore) {
    const verdict = await verify(first, "memory_to_query"); pairs.push(verdict);
    if (verdict.reason === "verification_unavailable") return empty("verification_unavailable");
    if (verdict.accepted) return { accepted: [first], pairs, reversePairs, reason: "admitted",
      rescue: decideDenseRescue([first.memory.id], [], populationCount, limit, "score_gate_preserved", generation) };
    if (verdict.reason === "contradictory_pair") return contradiction();
  }
  // Adding evidence to an existing lexical answer is outside this conservative rescue policy.
  if (lexicalMatches > 0) return empty("lexical_preserved");
  const window = ranked.slice(0, limit), mutual: DenseRescueCandidate[] = [];
  for (const entry of window) {
    let forward = pairs.find(pair => pair.memoryId === entry.memory.id);
    if (!forward) { forward = await verify(entry, "memory_to_query"); pairs.push(forward); }
    if (forward.reason === "verification_unavailable") return empty("verification_unavailable");
    // A contradicted nearest neighbour is a rejection, not permission to search around that veto.
    if (entry === first && forward.reason === "contradictory_pair") return contradiction();
    if (!forward.accepted) continue;
    const reverse = await verify(entry, "query_to_memory"); reversePairs.push(reverse);
    if (reverse.reason === "verification_unavailable") return empty("verification_unavailable");
    if (reverse.accepted) mutual.push(entry);
  }
  const rescue = decideDenseRescue(window.map(entry => entry.memory.id), mutual.map(entry => entry.memory.id), populationCount, limit, undefined, generation);
  return { accepted: rescue.reason === "unique_mutual_support" ? mutual : [], pairs, reversePairs, rescue,
    reason: rescue.reason === "unique_mutual_support" ? "admitted" : rescue.reason === "ambiguous_mutual_support" ? "ambiguous_candidates" : "pair_rejected" };
}
