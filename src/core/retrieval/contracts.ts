import { z } from "zod";
import type { DenseRescueReceipt } from "./dense/rescue/contracts.js";
import type { DenseRerankingEvidence, DenseRerankingReceipt } from "./dense/reranking/contracts.js";
import type { BoundDensePairReceipt } from "./dense/verification/contracts.js";
import { recallInputSchema, retrievalChannelSchema, type MemoryRetrieval, type ParsedRecallInput, type RecallResult, type ResolvedMemory, type RetrievalChannel } from "../../shared/types.js";
import type { LegacyMemoryLookup, MemoryRepository } from "../memory/storage-contract.js";
import type { FactGroupStore } from "../facts/contracts.js";
import { OpenContinuityError } from "../../shared/errors.js";
export type WordEdit = "insert" | "delete" | "substitute" | "transpose";
export interface WordCorrection { queryToken: string; matchedToken: string; edit: WordEdit; }

/** A bounded, single-channel candidate batch. Not a paginated list or a fused answer. */
export const candidateSearchInputSchema = recallInputSchema.safeExtend({
  channel: retrievalChannelSchema,
  query: z.string().max(2048).refine(value => !value.includes("\0"), "NUL is not allowed").optional(),
  cursor: z.never().optional(),
  requireUserConfirmed: z.boolean().default(false),
  /** Internal scored retrieval policy, not a new public Recall parameter. */
  lexicalFallback: z.boolean().default(false),
}).strict();
export type CandidateSearchRequest = z.input<typeof candidateSearchInputSchema>;
export type CandidateSearchInput = z.output<typeof candidateSearchInputSchema>;
export type CandidateMatchType = "exact_key" | "structured_filter" | "lexical_terms" | "literal_substring" | "one_edit_terms" | "semantic_similarity";
export interface LexicalFallbackReceipt {
  version: "latin-one-edit-v1"; used: boolean;
  reason: "literal_hit" | "unsupported_query" | "literal_miss";
  probes: number; inspected: number; boundedOut: number; probeLimit: 100; truncated: boolean;
}
export interface ScoredSearchHit {
  reranking?: DenseRerankingEvidence;
  verification?: BoundDensePairReceipt;
  memory: ResolvedMemory;
  channel: RetrievalChannel;
  /** One-based position within this bounded channel batch, not a global/fused rank. */
  channelRank: number;
  rankMeaning: "relevance" | "filter_order" | "match_order";
  score: { model: "fts5_bm25"; value: number; direction: "lower_is_better" }
    | { model: "cosine_similarity"; value: number; direction: "higher_is_better"; modelFingerprint: string }
    | { model: "cross_encoder_logit"; value: number; direction: "higher_is_better"; modelFingerprint: string }
    | { model: "token_edit_distance"; value: 1; direction: "lower_is_better" }
    | { model: "none"; value: null; direction: "not_applicable" };
  match: { type: CandidateMatchType; reason: "key_equals" | "explicit_filters" | "all_literal_terms" | "literal_contains" | "all_terms_one_edit" | "vector_neighbour"; filters: Array<"key" | "kind" | "scope">; termCount?: number; correction?: WordCorrection };
}
export interface CandidateSearchResult {
  /** Fingerprinted search projection; absent on legacy/other-store compatibility paths. */
  lexicalIndexVersion?: "json-literal-values-v1";
  channel: RetrievalChannel;
  status: "ok" | "skipped";
  skippedReason?: "missing_exact_key" | "key_query_mismatch" | "missing_structured_filter" | "empty_query" | "dense_lexical_preserved" | "dense_index_incomplete" | "dense_rejected" | "dense_unavailable";
  hits: ScoredSearchHit[];
  /** More eligible matches exist beyond this top-K batch; no total count is claimed. */
  truncated: boolean;
  ordering: "bm25_then_updated_at_id" | "updated_at_id" | "edit_distance_then_updated_at_id" | "cosine_then_updated_at_id" | "cross_encoder_then_cosine_updated_at_id";
  implementation: "sqlite_fts5_bm25" | "sqlite_literal_fallback" | "sqlite_one_edit_fallback" | "postgres_substring_fallback" | "inmemory_compatibility" | "json_compatibility" | "structured_lookup" | "not_run" | "sqlite_dense_experimental";
  lexicalFallback?: LexicalFallbackReceipt;
  dense?: { reranking?: DenseRerankingReceipt; rescue?: DenseRescueReceipt; reversePairs?: BoundDensePairReceipt[]; pairs?: BoundDensePairReceipt[]; verificationModel?: { model: string; policy: string; runtime: string }; verificationBudget?: { limit: number; attempted: number; reverseAttempted?: number; notVerified: number }; ranking?: { engine: "vector_projection_v1" | "legacy_stream"; cache: "hit" | "miss" | "bypassed"; populationCount: number; vectorBytes: number; hydratedCount: number }; version: "dense-integration-v1"; modelFingerprint: string; policyFingerprint: string; indexRevision: string;
    mode: "miss_only" | "hybrid"; reason: string; verification: "none" | "pair_model"; };
}
export interface CandidateSearchStore {
  searchCandidates(input: CandidateSearchRequest): CandidateSearchResult | Promise<CandidateSearchResult>;
  readonly candidateReaders?: CandidateReaderSet;
}

/** A channel has one narrow reader; storage algorithms remain outside Core. */
export type CandidateRetrievalRequest = Omit<CandidateSearchRequest, "channel">;
export type CandidateReader = (input: CandidateRetrievalRequest) => CandidateSearchResult | Promise<CandidateSearchResult>;
export type CandidateReaderSet = Readonly<Partial<Record<RetrievalChannel, CandidateReader>>>;
export type SyncCandidateReader = (input: CandidateRetrievalRequest) => CandidateSearchResult;
export type SyncCandidateReaderSet = Readonly<Partial<Record<RetrievalChannel, SyncCandidateReader>>>;
/** The three existing synchronous backends expose these concrete readers. */
export interface BuiltinSyncCandidateReaders {
  readonly exact: SyncCandidateReader;
  readonly structured: SyncCandidateReader;
  readonly full_text: SyncCandidateReader;
}
export interface CandidateRetriever {
  readonly channel: RetrievalChannel;
  retrieve(input: CandidateRetrievalRequest): Promise<CandidateSearchResult>;
}
export interface MemoryRetriever {
  readonly channel: RetrievalChannel;
  retrieve(input: ParsedRecallInput): Promise<ResolvedMemory[]>;
}
export interface RecallReader {
  recall(input: ParsedRecallInput, policy?: { requireUserConfirmed?: boolean }): Promise<RecallResult>;
}
export interface RetrievalSource extends LegacyMemoryLookup, Partial<FactGroupStore> {
  readonly lexicalIndexVersion?: "json-literal-values-v1";
  list?: MemoryRepository["list"];
  searchCandidates?: CandidateSearchStore["searchCandidates"];
  readonly candidateReaders?: CandidateReaderSet;
  readonly lexicalFallbackVersion?: "latin-one-edit-v1";
}
export interface EvidenceRankingPolicy { rrfK: number; exactPrecedence: boolean; fusion: "rrf" | "best_rank"; }
export interface RankedEvidence { memory: ResolvedMemory; score: number; exactTier: number; retrieval: MemoryRetrieval; }
export interface RetrievalPipelineOptions {
  channels?: readonly RetrievalChannel[];
  candidateLimit?: number;
  rrfK?: number;
  exactPrecedence?: boolean;
  /** Explicit ablation option; the production default is rrf. */
  fusion?: "rrf" | "best_rank";
  factGroupLimit?: number;
  lexicalFallback?: "off" | "latin_one_edit";
  /** Core-only explicit experiment. Default factories never install a model. */
  experimentalDense?: DenseRetrievalExtension;
}

export interface DenseExecutionBudget {
  check(): void;
  wait<T>(start: () => T | Promise<T>): Promise<T>;
}
export interface DenseRetrievalExtension {
  readonly mode: "miss_only" | "hybrid";
  fingerprint(): { model: string; policy: string; index: string; verification?: { model: string; policy: string; runtime: string }; reranking?: { model: string; policy: string; runtime: string; candidateLimit: number; verificationLimit: number } };
  retrieve(input: CandidateRetrievalRequest, lexicalMatches: number, budget?: DenseExecutionBudget): Promise<CandidateSearchResult>;
  synchronize?(input: CandidateRetrievalRequest, maximumJobs?: number): Promise<{ attempted: number; indexed: number; stale: number; failed: number; remaining: number }>;
  close?(): Promise<void>;
}

export function parseCandidateSearch(input: CandidateSearchRequest): CandidateSearchInput {
  const result = candidateSearchInputSchema.safeParse(input);
  if (!result.success) throw new OpenContinuityError("VALIDATION_ERROR", "Invalid candidate search request", 400);
  if (result.data.query && result.data.query.trim().split(/\s+/u).length > 32) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Candidate query exceeds the term budget", 400);
  }
  return result.data;
}

export function candidateQuery(input: CandidateSearchInput): string { return input.query?.trim() ?? ""; }
export function exactCandidateKey(input: CandidateSearchInput): string | undefined { return input.key ?? (candidateQuery(input) || undefined); }
export function candidateSkip(input: CandidateSearchInput): CandidateSearchResult["skippedReason"] {
  if (input.channel === "exact") {
    if (!exactCandidateKey(input)) return "missing_exact_key";
    if (input.key && candidateQuery(input) && input.key !== candidateQuery(input)) return "key_query_mismatch";
  }
  if (input.channel === "structured" && !input.key && !input.kind && !input.scope) return "missing_structured_filter";
  if (input.channel === "full_text" && !candidateQuery(input)) return "empty_query";
  return undefined;
}
export function candidateFilters(input: CandidateSearchInput): ScoredSearchHit["match"]["filters"] {
  return (["key", "kind", "scope"] as const).filter(field => input[field] !== undefined);
}
export function skippedCandidates(input: CandidateSearchInput): CandidateSearchResult | undefined {
  const skippedReason = candidateSkip(input);
  return skippedReason ? { channel: input.channel, status: "skipped", skippedReason, hits: [], truncated: false, ordering: "updated_at_id", implementation: "not_run" } : undefined;
}
export function unscoredCandidate(memory: ResolvedMemory, input: CandidateSearchInput, index: number): ScoredSearchHit {
  const type = input.channel === "exact" ? "exact_key" : input.channel === "structured" ? "structured_filter" : "literal_substring";
  return { memory, channel: input.channel, channelRank: index + 1, rankMeaning: input.channel === "structured" ? "filter_order" : "match_order",
    score: { model: "none", value: null, direction: "not_applicable" },
    match: { type, reason: type === "exact_key" ? "key_equals" : type === "structured_filter" ? "explicit_filters" : "literal_contains", filters: candidateFilters(input) } };
}
