import { OpenContinuityError } from "../../shared/errors.js";
import type { CandidateSearchResult, EvidenceRankingPolicy, RankedEvidence } from "./contracts.js";
import { groupCandidateEvidence } from "./ranking/candidates.js";
import { scoreCandidateEvidence } from "./ranking/scoring.js";
import { validateCandidateBatches } from "./validation.js";
export type { EvidenceRankingPolicy, RankedEvidence } from "./contracts.js";

export { RANKING_VERSION } from "./ranking/contracts.js";


/** Batches are independent; structured eligibility contributes zero query relevance. */
export function rankEvidence(batches: CandidateSearchResult[], policy: EvidenceRankingPolicy): RankedEvidence[] {
  if (!Number.isFinite(policy.rrfK) || policy.rrfK < 1 || typeof policy.exactPrecedence !== "boolean" || !["rrf", "best_rank"].includes(policy.fusion)) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid evidence ranking policy", 400);
  }

  validateCandidateBatches(batches);
  const queryBatches = batches.filter(b => b.channel !== "structured" && b.hits.length);
  const fused = queryBatches.length > 1 && policy.fusion === "rrf";
  const candidates = groupCandidateEvidence(batches, queryBatches);
  return scoreCandidateEvidence(candidates, policy, queryBatches.length, fused);
}
