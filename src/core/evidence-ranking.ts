import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import type { MemoryRetrieval, ResolvedMemory, RetrievalChannel } from "../shared/types.js";
import type { CandidateSearchResult, ScoredSearchHit } from "./candidate-search.js";

export const RANKING_VERSION = "core-ranking-v2" as const;
export interface EvidenceRankingPolicy { rrfK: number; exactPrecedence: boolean; fusion: "rrf" | "best_rank"; }
export interface RankedEvidence { memory: ResolvedMemory; score: number; exactTier: number; retrieval: MemoryRetrieval; }

function snapshot(memory: ResolvedMemory) { const { retrieval: _retrieval, ...current } = memory; return current; }
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Inconsistent candidate evidence", 500); }

/** Batches are independent; structured eligibility contributes zero query relevance. */
export function rankEvidence(batches: CandidateSearchResult[], policy: EvidenceRankingPolicy): RankedEvidence[] {
  if (!Number.isFinite(policy.rrfK) || policy.rrfK < 1 || typeof policy.exactPrecedence !== "boolean" || !["rrf", "best_rank"].includes(policy.fusion)) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid evidence ranking policy", 400);
  }
  const channels = new Set<RetrievalChannel>();
  for (const batch of batches) {
    if (channels.has(batch.channel) || !["exact", "structured", "full_text"].includes(batch.channel) || batch.hits.length > 100
      || (batch.status === "skipped" && batch.hits.length)) invalid();
    channels.add(batch.channel);
    batch.hits.forEach((hit, i) => {
      if (hit.channel !== batch.channel || hit.channelRank !== i + 1 || !hit.memory.id) invalid();
      if (hit.score.model === "fts5_bm25") {
        if (batch.channel !== "full_text" || hit.rankMeaning !== "relevance" || !Number.isFinite(hit.score.value) || hit.score.direction !== "lower_is_better") invalid();
        const previous = batch.hits[i-1];
        if (previous?.score.model === "fts5_bm25" && previous.score.value > hit.score.value) invalid();
      } else if (hit.score.value !== null || hit.rankMeaning === "relevance") invalid();
    });
  }
  const queryBatches = batches.filter(b => b.channel !== "structured" && b.hits.length);
  const fused = queryBatches.length > 1 && policy.fusion === "rrf";
  const candidates = new Map<string, { memory: ResolvedMemory; hits: Array<{ hit: ScoredSearchHit; implementation: CandidateSearchResult["implementation"] }> }>();
  for (const batch of [...queryBatches, ...batches.filter(b => b.channel === "structured")]) {
    const seen = new Set<string>();
    for (const hit of batch.hits) {
      const previous = candidates.get(hit.memory.id);
      if (previous && !isDeepStrictEqual(snapshot(previous.memory), snapshot(hit.memory))) invalid();
      if (seen.has(hit.memory.id)) continue;
      seen.add(hit.memory.id);
      // A filter-only match cannot create an answer candidate.
      if (batch.channel === "structured" && !previous) continue;
      const item = previous ?? { memory: hit.memory, hits: [] };
      item.hits.push({ hit, implementation: batch.implementation });
      candidates.set(hit.memory.id, item);
    }
  }
  return [...candidates.values()].map(({ memory, hits }): RankedEvidence => {
    const order = ["exact", "structured", "full_text"];
    hits.sort((a,b) => order.indexOf(a.hit.channel) - order.indexOf(b.hit.channel));
    const rankHits = hits.filter(h => h.hit.channel !== "structured");
    const evidence = hits.map(({ hit, implementation }) => ({
      channel: hit.channel, channelRank: hit.channelRank, rankMeaning: hit.rankMeaning,
      score: hit.score, match: hit.match, implementation,
      contribution: hit.channel === "structured" ? 0 : 1 / (policy.rrfK + hit.channelRank),
    }));
    const score = fused ? evidence.reduce((n, e) => n + e.contribution, 0) : Math.max(...evidence.map(e => e.contribution));
    const exactTier = Number(policy.exactPrecedence && rankHits.some(h => h.hit.channel === "exact"));
    const reasons: NonNullable<MemoryRetrieval["selectionReasons"]> = ["query_match"];
    if (exactTier) reasons.push("exact_key_precedence");
    if (fused) reasons.push("independent_rank_fusion");
    else if (queryBatches.length === 1) reasons.push("single_channel_order");
    else reasons.push("best_channel_rank");
    if (hits.some(h => h.hit.channel === "structured")) reasons.push("structured_eligibility");
    reasons.push("current_memory_snapshot");
    return { memory: snapshot(memory), score, exactTier, retrieval: {
      score, channels: hits.map(h => h.hit.channel), ranks: Object.fromEntries(hits.map(h => [h.hit.channel, h.hit.channelRank])),
      rankingVersion: RANKING_VERSION, scoreModel: fused ? "rrf" : "rank_reciprocal", fusedScore: fused ? score : null,
      exactTier, evidence, selectionReasons: reasons,
    } };
  }).sort((a,b) => b.exactTier - a.exactTier || b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id));
}
