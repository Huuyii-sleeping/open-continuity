import { OpenContinuityError } from "../../../shared/errors.js";
import type { CandidateSearchResult } from "../contracts.js";

function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid Dense evidence", 500); }
export function validateDenseEvidence(batch: CandidateSearchResult): void {
  const receipt = batch.dense;
  if (!receipt || receipt.version !== "dense-integration-v1" || !/^[a-f0-9]{64}$/.test(receipt.modelFingerprint)
    || !/^[a-f0-9]{64}$/.test(receipt.policyFingerprint) || !receipt.indexRevision
    || !["miss_only", "hybrid"].includes(receipt.mode) || !["none", "pair_model"].includes(receipt.verification)
    || batch.ordering !== "cosine_then_updated_at_id"
    || (batch.status === "ok" ? batch.implementation !== "sqlite_dense_experimental" : batch.implementation !== "not_run")) invalid();
  if (receipt.ranking && (!["vector_projection_v1", "legacy_stream"].includes(receipt.ranking.engine)
    || !["hit", "miss", "bypassed"].includes(receipt.ranking.cache)
    || !Number.isInteger(receipt.ranking.populationCount) || receipt.ranking.populationCount < 1 || receipt.ranking.populationCount > 20000
    || !Number.isInteger(receipt.ranking.hydratedCount) || receipt.ranking.hydratedCount < batch.hits.length || receipt.ranking.hydratedCount > 100
    || !Number.isInteger(receipt.ranking.vectorBytes) || receipt.ranking.vectorBytes < 0 || receipt.ranking.vectorBytes > 64 * 1024 * 1024)) invalid();
  if (receipt.pairs && receipt.pairs.length > 4) invalid();
  if (receipt.verificationModel && (!/^[a-f0-9]{64}$/.test(receipt.verificationModel.model) || !/^[a-f0-9]{64}$/.test(receipt.verificationModel.policy)
    || !/^[a-f0-9]{64}$/.test(receipt.verificationModel.runtime))) invalid();
  if (receipt.verificationBudget && (!Number.isInteger(receipt.verificationBudget.limit) || receipt.verificationBudget.limit < 1 || receipt.verificationBudget.limit > 4
    || receipt.verificationBudget.attempted !== receipt.pairs?.length || receipt.verificationBudget.attempted > receipt.verificationBudget.limit
    || !Number.isInteger(receipt.verificationBudget.notVerified) || receipt.verificationBudget.notVerified < 0)) invalid();
  batch.hits.forEach((hit, index) => {
    if (hit.score.model !== "cosine_similarity" || !Number.isFinite(hit.score.value) || Math.abs(hit.score.value) > 1.000001
      || hit.score.direction !== "higher_is_better" || hit.score.modelFingerprint !== receipt.modelFingerprint
      || hit.rankMeaning !== "relevance" || !hit.memory.userConfirmed || hit.match.type !== "semantic_similarity"
      || hit.match.reason !== "vector_neighbour") invalid();
    if (receipt.verificationModel && !receipt.pairs?.some(pair => pair.accepted && pair.reason === "verified_pair" && pair.memoryId === hit.memory.id
      && pair.sourceEventId === hit.memory.sourceEventId && pair.memoryVersion === hit.memory.version
      && pair.modelFingerprint === receipt.verificationModel!.model && pair.policyFingerprint === receipt.verificationModel!.policy)) invalid();
    if (receipt.verificationModel && (!hit.verification?.accepted || hit.verification.memoryId !== hit.memory.id
      || hit.verification.sourceEventId !== hit.memory.sourceEventId || hit.verification.memoryVersion !== hit.memory.version
      || hit.verification.modelFingerprint !== receipt.verificationModel.model || hit.verification.policyFingerprint !== receipt.verificationModel.policy)) invalid();
    const previous = batch.hits[index - 1];
    if (previous?.score.model === "cosine_similarity" && (previous.score.value < hit.score.value
      || (previous.score.value === hit.score.value && (previous.memory.updatedAt < hit.memory.updatedAt
        || (previous.memory.updatedAt === hit.memory.updatedAt && previous.memory.id < hit.memory.id))))) invalid();
  });
}
