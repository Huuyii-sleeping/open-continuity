import { describe, expect, it } from "vitest";
import { rankEvidence } from "../src/core/evidence-ranking.js";
import type { CandidateSearchResult, ScoredSearchHit } from "../src/core/candidate-search.js";
import type { ResolvedMemory, RetrievalChannel } from "../src/shared/types.js";

const memory = (id: string): ResolvedMemory => ({ id, key: id, value: "fictional evidence", kind: "decision", scope: "user", sensitivity: "public", userConfirmed: true, sourceEventId: `event-${id}`, sourceAgentId: "fictional-writer", updatedAt: "2031-01-01T00:00:00Z", version: 1 });
function batch(channel: RetrievalChannel, ids: string[], scored = false): CandidateSearchResult {
  return { channel, status: "ok", truncated: false, implementation: scored ? "sqlite_fts5_bm25" : "structured_lookup", ordering: scored ? "bm25_then_updated_at_id" : "updated_at_id",
    hits: ids.map((id,i): ScoredSearchHit => ({ memory: memory(id), channel, channelRank: i+1, rankMeaning: scored ? "relevance" : channel === "structured" ? "filter_order" : "match_order",
      score: scored ? { model: "fts5_bm25", value: -10+i, direction: "lower_is_better" } : { model: "none", value: null, direction: "not_applicable" },
      match: { type: channel === "exact" ? "exact_key" : channel === "structured" ? "structured_filter" : "lexical_terms", reason: channel === "exact" ? "key_equals" : channel === "structured" ? "explicit_filters" : "all_literal_terms", filters: [] } })) };
}
const policy = { rrfK: 60, exactPrecedence: true, fusion: "rrf" as const };
describe("evidence ranking contract", () => {
  it("preserves native order and raw scores for one channel, without claiming fusion", () => {
    const text = batch("full_text",["relevant","newer"],true); text.hits[1]!.memory.updatedAt = "2032-01-01T00:00:00Z";
    const ranked = rankEvidence([text],policy);
    expect(ranked.map(x=>x.memory.id)).toEqual(["relevant","newer"]);
    expect(ranked[0]!.retrieval).toMatchObject({ scoreModel: "rank_reciprocal", fusedScore: null, evidence: [{ score: { model: "fts5_bm25", value: -10 }, channelRank: 1 }] });
  });
  it("retains structured original positions but gives eligibility zero contribution and no new candidates", () => {
    const ranked = rankEvidence([batch("full_text",["target"],true),batch("structured",["unrelated","target"])],policy);
    expect(ranked.map(x=>x.memory.id)).toEqual(["target"]);
    expect(ranked[0]!.retrieval.ranks.structured).toBe(2);
    expect(ranked[0]!.retrieval.evidence?.find(x=>x.channel==="structured")?.contribution).toBe(0);
    expect(ranked[0]!.retrieval.score).toBeCloseTo(1/61);
    expect(rankEvidence([batch("structured",["unrelated"])],policy)).toEqual([]);
  });
  it("fuses actual ranks, deduplicates per channel and preserves all channel explanations", () => {
    const ranked = rankEvidence([batch("exact",["same","same"]),batch("full_text",["other","same"],true)],policy);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.retrieval).toMatchObject({ scoreModel: "rrf", ranks: { exact: 1, full_text: 2 }, score: 1/61+1/62 });
    expect(ranked[0]!.retrieval.evidence).toHaveLength(2);
  });
  it("separately ablates exact precedence without numeric boosts", () => {
    const exact = batch("exact",["user-key","task-key"]);
    const text = batch("full_text",["noise"]);
    const on = rankEvidence([exact,text],policy),off = rankEvidence([exact,text],{...policy,exactPrecedence:false});
    expect(on.at(-1)!.memory.id).toBe("noise");
    // Every exact match precedes a higher scoring text-only item; numeric scores are unchanged.
    expect(off.findIndex(x=>x.memory.id==="noise")).toBeLessThan(off.length-1);
    expect(on.find(x=>x.memory.id==="noise")!.score).toBe(off.find(x=>x.memory.id==="noise")!.score);
  });
  it("separately ablates rank fusion using the same candidates", () => {
    const exact=batch("exact",["corroborated"]),text=batch("full_text",["newer","filler","corroborated"]);
    text.hits[0]!.memory.updatedAt="2032-01-01T00:00:00Z";
    const on=rankEvidence([exact,text],{...policy,exactPrecedence:false});
    const off=rankEvidence([exact,text],{...policy,exactPrecedence:false,fusion:"best_rank"});
    expect(on[0]!.memory.id).toBe("corroborated");expect(off[0]!.memory.id).toBe("newer");
    expect(off[0]!.retrieval.fusedScore).toBeNull();
  });
  it("rejects mixed snapshots instead of choosing a fact by recency", () => {
    const exact=batch("exact",["same"]),text=batch("full_text",["same"]);
    text.hits[0]!.memory.version=2;
    expect(()=>rankEvidence([exact,text],policy)).toThrow(expect.objectContaining({ code:"STORAGE_ERROR" }));
  });
  it("rejects forged ranks, scores and duplicated channel batches", () => {
    const text=batch("full_text",["a","b"],true);text.hits[1]!.channelRank=1;
    expect(()=>rankEvidence([text],policy)).toThrow();
    text.hits[1]!.channelRank=2;text.hits[0]!.score={model:"fts5_bm25",value:Infinity,direction:"lower_is_better"};
    expect(()=>rankEvidence([text],policy)).toThrow();
    expect(()=>rankEvidence([batch("exact",["a"]),batch("exact",["b"])],policy)).toThrow();
  });
  it("retains distinct memory identities even when values are identical and breaks ties stably", () => {
    const ranked=rankEvidence([batch("exact",["z"]),batch("full_text",["a"])],{...policy,exactPrecedence:false,fusion:"best_rank"});
    expect(ranked.map(x=>x.memory.id)).toEqual(["z","a"]);
  });
});
