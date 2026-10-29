import type { MemoryRetrieval } from "../../../shared/types.js";
import type { EvidenceRankingPolicy, RankedEvidence } from "../contracts.js";
import { RANKING_VERSION, type GroupedCandidate } from "./contracts.js";
import { bestRankScore } from "./native.js";
import { fuseRanks, reciprocalRank } from "./rrf.js";
import { snapshot } from "./snapshot.js";
export function scoreCandidateEvidence(candidates: Map<string, GroupedCandidate>, policy: EvidenceRankingPolicy, queryBatchCount: number, fused: boolean): RankedEvidence[] {
  return [...candidates.values()].map(({ memory, hits }): RankedEvidence => {
    const order = ["exact", "structured", "full_text", "dense"];
    hits.sort((a, b) => order.indexOf(a.hit.channel) - order.indexOf(b.hit.channel));
    const rankHits = hits.filter(h => h.hit.channel !== "structured");
    const evidence = hits.map(({ hit, implementation }) => ({
      channel: hit.channel, channelRank: hit.channelRank, rankMeaning: hit.rankMeaning,
      ...(hit.verification ? { verification: hit.verification } : {}),
      score: hit.score, match: hit.match, implementation,
      contribution: hit.channel === "structured" ? 0 : reciprocalRank(hit.channelRank, policy.rrfK),
    }));
    const score = fused ? fuseRanks(evidence) : bestRankScore(evidence);
    const exactTier = Number(policy.exactPrecedence && rankHits.some(h => h.hit.channel === "exact"));
    const reasons: NonNullable<MemoryRetrieval["selectionReasons"]> = ["query_match"];
    if (exactTier) reasons.push("exact_key_precedence");
    if (fused) reasons.push("independent_rank_fusion");
    else if (queryBatchCount === 1) reasons.push("single_channel_order");
    else reasons.push("best_channel_rank");
    if (hits.some(h => h.hit.channel === "structured")) reasons.push("structured_eligibility");
    reasons.push("current_memory_snapshot");
    return {
      memory: snapshot(memory), score, exactTier, retrieval: {
        score, channels: hits.map(h => h.hit.channel), ranks: Object.fromEntries(hits.map(h => [h.hit.channel, h.hit.channelRank])),
        rankingVersion: RANKING_VERSION, scoreModel: fused ? "rrf" : "rank_reciprocal", fusedScore: fused ? score : null,
        exactTier, evidence, selectionReasons: reasons,
      }
    };
  }).sort((a, b) => b.exactTier - a.exactTier || b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt) || b.memory.id.localeCompare(a.memory.id));
}
