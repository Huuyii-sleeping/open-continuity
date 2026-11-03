import type { RelevanceReceipt, RelevanceScore } from "../../reranking/contracts.js";
import type { BoundDensePairReceipt } from "../verification/contracts.js";
export interface DenseSelectionPhase { limit: number; reason: string; pairs: BoundDensePairReceipt[]; reversePairs: BoundDensePairReceipt[]; }
export interface DenseRerankingReceipt {
  version: "dense-cross-encoder-order-v1";
  candidateLimit: number; populationCount: number; outsideWindow: number;
  sourceModelFingerprint: string;
  sourceCandidates: Array<{ memoryId: string; sourceEventId: string; memoryVersion: number; cosineRank: number; cosineScore: number }>;
  relevance: RelevanceReceipt;
  chosenRoute: "reranked" | "baseline";
  baselineVerification: DenseSelectionPhase;
  rerankedVerification: DenseSelectionPhase;
}
export interface DenseRerankingEvidence {
  applied: boolean;
  modelFingerprint: string; policyFingerprint: string; runtimeFingerprint: string; queryFingerprint: string; accessFingerprint: string;
  score: RelevanceScore;
  cosine: { value: number; rank: number; modelFingerprint: string };
}
