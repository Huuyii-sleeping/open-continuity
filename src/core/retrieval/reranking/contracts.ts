import type { DenseExecutionBudget } from "../contracts.js";

export interface RelevanceCandidate {
  memoryId: string; sourceEventId: string; memoryVersion: number; contentFingerprint: string; text: string;
}
export interface RelevanceRequest {
  query: string; queryFingerprint: string; accessFingerprint: string; candidates: readonly RelevanceCandidate[];
}
export interface RelevanceScore {
  memoryId: string; sourceEventId: string; memoryVersion: number; contentFingerprint: string; value: number;
}
export interface RelevanceReceipt {
  version: "cross-encoder-relevance-v1";
  modelFingerprint: string; policyFingerprint: string; runtimeFingerprint: string;
  queryFingerprint: string; accessFingerprint: string;
  status: "scored" | "unavailable"; cache: "hit" | "miss" | "unavailable";
  scores: RelevanceScore[];
  meaning: "relative_query_document_relevance_logit";
}
export interface RelevanceSession {
  readonly modelFingerprint: string;
  score(query: string, documents: readonly string[]): Promise<readonly number[]>;
  close(): Promise<void>;
}
export interface RelevanceProvider { readonly modelFingerprint: string; load(): Promise<RelevanceSession>; }
export interface CandidateReranker {
  fingerprint(): { model: string; policy: string; runtime: string };
  rank(request: RelevanceRequest, budget?: DenseExecutionBudget): Promise<RelevanceReceipt>;
  close(): Promise<void>;
}
