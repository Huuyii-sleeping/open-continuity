import { OpenContinuityError } from "../../../shared/errors.js";
import type { CandidateSearchResult } from "../contracts.js";
import { isDeepStrictEqual } from "node:util";
import { decideDenseRescue } from "./rescue.js";
import { validateDenseReranking, validateRerankedHit } from "./reranking/validation.js";

function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid Dense evidence", 500); }
export function validateDenseEvidence(batch: CandidateSearchResult): void {
  const receipt = batch.dense;
  if (!receipt || receipt.version !== "dense-integration-v1" || !/^[a-f0-9]{64}$/.test(receipt.modelFingerprint)
    || !/^[a-f0-9]{64}$/.test(receipt.policyFingerprint) || !receipt.indexRevision
    || !["miss_only", "hybrid"].includes(receipt.mode) || !["none", "pair_model"].includes(receipt.verification)
    || batch.ordering !== (receipt.reranking?.chosenRoute === "reranked" ? "cross_encoder_then_cosine_updated_at_id" : "cosine_then_updated_at_id")
    || (batch.status === "ok" ? batch.implementation !== "sqlite_dense_experimental" : batch.implementation !== "not_run")) invalid();
  validateDenseReranking(batch);
  if (receipt.ranking && (!["vector_projection_v1", "legacy_stream"].includes(receipt.ranking.engine)
    || !["hit", "miss", "bypassed"].includes(receipt.ranking.cache)
    || !Number.isInteger(receipt.ranking.populationCount) || receipt.ranking.populationCount < 1 || receipt.ranking.populationCount > 20000
    || !Number.isInteger(receipt.ranking.hydratedCount) || receipt.ranking.hydratedCount < batch.hits.length || receipt.ranking.hydratedCount > 100
    || !Number.isInteger(receipt.ranking.vectorBytes) || receipt.ranking.vectorBytes < 0 || receipt.ranking.vectorBytes > 64 * 1024 * 1024)) invalid();
  if (receipt.pairs && receipt.pairs.length > 4) invalid();
  if (receipt.pairs?.some(pair => pair.direction === "query_to_memory")) invalid();
  if (receipt.reversePairs && (receipt.reversePairs.length > 4 || new Set(receipt.reversePairs.map(pair => pair.memoryId)).size !== receipt.reversePairs.length
    || receipt.verificationBudget?.reverseAttempted !== receipt.reversePairs.length
    || receipt.reversePairs.some(pair => pair.direction !== "query_to_memory" || !receipt.pairs?.some(forward => forward.memoryId === pair.memoryId
      && forward.accepted && forward.sourceEventId === pair.sourceEventId && forward.memoryVersion === pair.memoryVersion
      && forward.accessFingerprint === pair.accessFingerprint && forward.queryFingerprint === pair.queryFingerprint
      && forward.contentFingerprint === pair.contentFingerprint && forward.modelFingerprint === pair.modelFingerprint && forward.policyFingerprint === pair.policyFingerprint)))) invalid();
  if (receipt.verificationModel && (!/^[a-f0-9]{64}$/.test(receipt.verificationModel.model) || !/^[a-f0-9]{64}$/.test(receipt.verificationModel.policy)
    || !/^[a-f0-9]{64}$/.test(receipt.verificationModel.runtime))) invalid();
  if (receipt.verificationBudget && (!Number.isInteger(receipt.verificationBudget.limit) || receipt.verificationBudget.limit < 1 || receipt.verificationBudget.limit > 4
    || receipt.verificationBudget.attempted !== receipt.pairs?.length || receipt.verificationBudget.attempted > receipt.verificationBudget.limit
    || !Number.isInteger(receipt.verificationBudget.notVerified) || receipt.verificationBudget.notVerified < 0)) invalid();
  if (receipt.rescue) {
    const invalidated = batch.status === "skipped" && receipt.reason === "index_changed";
    const rescue = receipt.rescue, preserved = ["score_gate_preserved", "reranked_score_gate"].includes(rescue.reason), contradicted = rescue.reason === "top_contradiction";
    const mutual = receipt.pairs?.filter(pair => pair.accepted && receipt.reversePairs?.some(reverse => reverse.memoryId === pair.memoryId && reverse.accepted)).map(pair => pair.memoryId) ?? [];
    if (receipt.mode !== "hybrid" || !receipt.verificationModel || !receipt.pairs || !receipt.reversePairs || !receipt.ranking || !receipt.verificationBudget
      || receipt.pairs.some(pair => pair.reason === "verification_unavailable") || receipt.reversePairs.some(pair => pair.reason === "verification_unavailable")
      || (preserved || contradicted ? receipt.pairs.length !== 1 || receipt.reversePairs.length !== 0
        || (preserved ? !receipt.pairs[0]!.accepted : receipt.pairs[0]!.accepted || receipt.pairs[0]!.reason !== "contradictory_pair")
        : receipt.reversePairs.length !== receipt.pairs.filter(pair => pair.accepted).length)
      || !isDeepStrictEqual(rescue, decideDenseRescue(receipt.pairs.map(pair => pair.memoryId), mutual, receipt.ranking.populationCount, receipt.verificationBudget.limit,
        preserved ? "score_gate_preserved" : contradicted ? "top_contradiction" : undefined, receipt.reranking?.chosenRoute === "reranked" ? "reranked_vector_window" : "authorized_cosine_top_k"))
      || receipt.verificationBudget.notVerified !== rescue.outsideWindow
      || (!invalidated && (preserved || rescue.reason === "unique_mutual_support" ? batch.hits.length !== 1 || batch.hits[0]!.memory.id !== (preserved ? receipt.pairs[0]!.memoryId : mutual[0]) : batch.hits.length !== 0))) invalid();
  }
  batch.hits.forEach((hit, index) => {
    if (!Number.isFinite(hit.score.value) || hit.score.direction !== "higher_is_better" || hit.rankMeaning !== "relevance" || !hit.memory.userConfirmed
      || hit.match.type !== "semantic_similarity" || hit.match.reason !== "vector_neighbour") invalid();
    if (receipt.reranking) validateRerankedHit(hit, batch);
    if (receipt.reranking?.chosenRoute !== "reranked" && (hit.score.model !== "cosine_similarity" || Math.abs(hit.score.value) > 1.000001 || hit.score.modelFingerprint !== receipt.modelFingerprint)) invalid();
    if (!receipt.reranking && hit.reranking) invalid();
    if (receipt.verificationModel && !receipt.pairs?.some(pair => pair.accepted && pair.reason === "verified_pair" && pair.memoryId === hit.memory.id
      && pair.sourceEventId === hit.memory.sourceEventId && pair.memoryVersion === hit.memory.version
      && pair.modelFingerprint === receipt.verificationModel!.model && pair.policyFingerprint === receipt.verificationModel!.policy)) invalid();
    if (receipt.verificationModel && (!hit.verification?.accepted || hit.verification.direction === "query_to_memory" || hit.verification.memoryId !== hit.memory.id
      || hit.verification.sourceEventId !== hit.memory.sourceEventId || hit.verification.memoryVersion !== hit.memory.version
      || hit.verification.modelFingerprint !== receipt.verificationModel.model || hit.verification.policyFingerprint !== receipt.verificationModel.policy)) invalid();
    const previous = batch.hits[index - 1];
    if (previous && previous.score.model !== "none" && (previous.score.value < hit.score.value
      || (previous.score.value === hit.score.value && ((previous.reranking?.cosine.value ?? previous.score.value) < (hit.reranking?.cosine.value ?? hit.score.value)
        || ((previous.reranking?.cosine.value ?? previous.score.value) === (hit.reranking?.cosine.value ?? hit.score.value) && (previous.memory.updatedAt < hit.memory.updatedAt
        || (previous.memory.updatedAt === hit.memory.updatedAt && previous.memory.id < hit.memory.id))))))) invalid();
  });
}
