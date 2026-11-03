import type { ResolvedMemory } from "../../../../shared/types.js";
import type { BoundDensePairReceipt } from "../verification/contracts.js";
export interface DenseSupportSelection {
  accepted: Array<{ memory: ResolvedMemory; score: number }>;
  pairs: BoundDensePairReceipt[]; reversePairs: BoundDensePairReceipt[];
  reason: string; rescue?: DenseRescueReceipt;
}
export interface DenseRescueReceipt {
  version: "dense-bidirectional-rescue-v1";
  generation: "authorized_cosine_top_k" | "reranked_vector_window";
  limit: number;
  populationCount: number;
  windowMemoryIds: string[];
  mutualSupportedMemoryIds: string[];
  outsideWindow: number;
  /** Only this bounded window is checked; never a claim of global semantic uniqueness. */
  windowComplete: boolean;
  reason: "score_gate_preserved" | "reranked_score_gate" | "top_contradiction" | "unique_mutual_support" | "no_mutual_support" | "ambiguous_mutual_support";
}
