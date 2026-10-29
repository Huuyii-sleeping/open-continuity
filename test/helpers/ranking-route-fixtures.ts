import type { CandidateSearchResult, ScoredSearchHit } from "../../src/core/retrieval/contracts.js";
import { routeMemory } from "./core-route-fixtures.js";
export function lexicalBatch(): CandidateSearchResult {
  const hit = (id: string, rank: number, score: number, updatedAt: string): ScoredSearchHit => ({ memory: routeMemory({ id, updatedAt }), channel: "full_text", channelRank: rank, rankMeaning: "relevance", score: { model: "fts5_bm25", value: score, direction: "lower_is_better" }, match: { type: "lexical_terms", reason: "all_literal_terms", filters: [], termCount: 1 } });
  return { channel: "full_text", status: "ok", hits: [hit("fictional-focused", 1, -2, "2031-01-01T00:00:00Z"), hit("fictional-newer", 2, -1, "2032-01-01T00:00:00Z")], truncated: false, ordering: "bm25_then_updated_at_id", implementation: "sqlite_fts5_bm25" };
}
