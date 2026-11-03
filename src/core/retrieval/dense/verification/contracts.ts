import type { DenseExecutionBudget } from "../../contracts.js";
/** Staged, bounded text-pair verification. Similarity/entailment never proves source truth. */
export interface PairProbabilities { entailment: number; neutral: number; contradiction: number; }
export interface DensePairEvidence {
  memoryId: string;
  queryFingerprint: string;
  contentFingerprint: string;
  modelFingerprint: string;
  memoryToQuery: PairProbabilities;
  /** Diagnostic for the original forward policy; explicit query_to_memory requests evaluate this direction. */
  queryToMemory?: PairProbabilities;
}
export interface DensePairPolicy {
  version: "dense-pair-v1";
  modelFingerprint: string;
  maxContradiction: number;
  minEntailment: number;
}
export interface DensePairRequest {
  memoryId: string;
  queryFingerprint: string;
  contentFingerprint: string;
  /** Omission keeps the original directional veto. Reverse support is an explicit experiment. */
  direction?: "memory_to_query" | "query_to_memory";
}
export interface DensePairReceipt {
  direction?: "memory_to_query" | "query_to_memory";
  version: "dense-pair-v1";
  accepted: boolean;
  reason: "verified_pair" | "contradictory_pair" | "insufficient_pair_support" | "verification_unavailable";
  policyFingerprint: string;
  modelFingerprint: string;
  memoryId: string;
  queryFingerprint: string;
  contentFingerprint: string;
  contradiction: number | null;
  entailment: number | null;
  meaning: "text_pair_model_support";
}

export interface DensePairSession {
  readonly modelFingerprint: string;
  compare(premise: string, hypothesis: string): Promise<PairProbabilities>;
  close(): Promise<void>;
}
export interface DensePairProvider { readonly modelFingerprint: string; load(): Promise<DensePairSession>; }
export interface BoundDensePairRequest extends DensePairRequest {
  sourceEventId: string; memoryVersion: number; accessFingerprint: string; memoryText: string; query: string;
}
export interface BoundDensePairReceipt extends DensePairReceipt {
  sourceEventId: string; memoryVersion: number; accessFingerprint: string; cache: "hit" | "miss" | "unavailable";
}
export interface DensePairVerifier {
  readonly directions?: readonly ("memory_to_query" | "query_to_memory")[];
  readonly policy: Readonly<DensePairPolicy>;
  fingerprint(): { model: string; policy: string; runtime: string };
  verify(request: BoundDensePairRequest, budget?: DenseExecutionBudget): Promise<BoundDensePairReceipt>;
  close(): Promise<void>;
}
