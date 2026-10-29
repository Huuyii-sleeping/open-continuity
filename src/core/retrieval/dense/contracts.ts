/** Internal admission policy; Dense is exposed only through explicit experimental service wiring. */
export interface DenseAdmissionPolicy {
  version: "dense-admission-v1";
  modelFingerprint: string;
  minScore: number;
  minMargin: number;
  minimumCandidates: number;
}

/** Scores must come from the same authorized population and normalized embedding space. */
export interface DenseCandidateScore {
  memoryId: string;
  modelFingerprint: string;
  score: number;
}

export interface DenseAdmissionInput {
  /** Count eligible Exact/BM25 matches before any consumer budget or fact abstention. */
  lexicalMatches: number;
  modelReady: boolean;
  /** Truncation/unavailable population cannot prove a runner-up comparison. */
  comparison: "complete" | "truncated" | "unavailable";
  candidates: readonly DenseCandidateScore[];
}

export type DenseAdmissionReason = "lexical_preserved" | "model_not_ready" | "comparison_incomplete"
  | "no_candidates" | "insufficient_comparison" | "below_similarity" | "ambiguous_candidates" | "admitted";

export interface DenseAdmissionReceipt {
  version: "dense-admission-v1";
  policyFingerprint: string;
  modelFingerprint: string;
  reason: DenseAdmissionReason;
  admittedMemoryIds: string[];
  topScore: number | null;
  runnerUpScore: number | null;
  margin: number | null;
  /** This is a similarity gate, never a truth/authority/permission score. */
  scoreMeaning: "cosine_similarity";
}
