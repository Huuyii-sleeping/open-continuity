import { z } from "zod";
import { recallInputSchema, retrievalChannelSchema, type ResolvedMemory, type RetrievalChannel } from "../shared/types.js";
import { OpenContinuityError } from "../shared/errors.js";

/** A bounded, single-channel candidate batch. Not a paginated list or a fused answer. */
export const candidateSearchInputSchema = recallInputSchema.safeExtend({
  channel: retrievalChannelSchema,
  query: z.string().max(2048).refine(value => !value.includes("\0"), "NUL is not allowed").optional(),
  cursor: z.never().optional(),
  requireUserConfirmed: z.boolean().default(false),
}).strict();
export type CandidateSearchRequest = z.input<typeof candidateSearchInputSchema>;
export type CandidateSearchInput = z.output<typeof candidateSearchInputSchema>;
export type CandidateMatchType = "exact_key" | "structured_filter" | "lexical_terms" | "literal_substring";
export interface ScoredSearchHit {
  memory: ResolvedMemory;
  channel: RetrievalChannel;
  /** One-based position within this bounded channel batch, not a global/fused rank. */
  channelRank: number;
  rankMeaning: "relevance" | "filter_order" | "match_order";
  score: { model: "fts5_bm25"; value: number; direction: "lower_is_better" }
    | { model: "none"; value: null; direction: "not_applicable" };
  match: { type: CandidateMatchType; reason: "key_equals" | "explicit_filters" | "all_literal_terms" | "literal_contains"; filters: Array<"key" | "kind" | "scope">; termCount?: number };
}
export interface CandidateSearchResult {
  channel: RetrievalChannel;
  status: "ok" | "skipped";
  skippedReason?: "missing_exact_key" | "key_query_mismatch" | "missing_structured_filter" | "empty_query";
  hits: ScoredSearchHit[];
  /** More eligible matches exist beyond this top-K batch; no total count is claimed. */
  truncated: boolean;
  ordering: "bm25_then_updated_at_id" | "updated_at_id";
  implementation: "sqlite_fts5_bm25" | "sqlite_literal_fallback" | "postgres_substring_fallback" | "inmemory_compatibility" | "json_compatibility" | "structured_lookup" | "not_run";
}
export interface CandidateSearchStore {
  searchCandidates(input: CandidateSearchRequest): CandidateSearchResult | Promise<CandidateSearchResult>;
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

/** Independent channels remain independent; deliberately no union, RRF, Context, or Answer. */
export class CandidateRetrieval {
  constructor(private readonly store: CandidateSearchStore) {}
  async retrieve(input: Omit<CandidateSearchRequest, "channel">, channels: readonly RetrievalChannel[] = ["exact", "structured", "full_text"]): Promise<CandidateSearchResult[]> {
    if (!channels.length || new Set(channels).size !== channels.length || channels.some(c => !retrievalChannelSchema.safeParse(c).success)) {
      throw new OpenContinuityError("VALIDATION_ERROR", "Specify unique candidate channels", 400);
    }
    // Bound each channel separately. A failed channel is an error, never an empty successful hit list.
    const request = parseCandidateSearch({ ...input, channel: channels[0]! });
    const results: CandidateSearchResult[] = [];
    for (const channel of channels) results.push(await this.store.searchCandidates({ ...request, channel }));
    return results;
  }
}
