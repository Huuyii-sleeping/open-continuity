import { isDeepStrictEqual } from "node:util";
import type { CandidateSearchResult, ScoredSearchHit } from "../../contracts.js";
import { OpenContinuityError } from "../../../../shared/errors.js";
const hash = /^[a-f0-9]{64}$/;
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Invalid Dense reranking evidence", 500); }
export function validateDenseReranking(batch: CandidateSearchResult): void {
  const receipt = batch.dense?.reranking;
  if (!receipt) return;
  const r = receipt.relevance;
  if (!["reranked", "baseline"].includes(receipt.chosenRoute)) invalid();
  for (const phase of [receipt.baselineVerification, receipt.rerankedVerification]) {
    if (!phase || !Number.isInteger(phase.limit) || phase.limit < 1 || phase.limit > 4 || phase.pairs.length > phase.limit
      || phase.reversePairs.length > phase.pairs.length || new Set(phase.pairs.map(pair => pair.memoryId)).size !== phase.pairs.length
      || new Set(phase.reversePairs.map(pair => pair.memoryId)).size !== phase.reversePairs.length
      || phase.pairs.some(pair => pair.reason === "verification_unavailable" || pair.direction === "query_to_memory")
      || phase.reversePairs.some(pair => pair.reason === "verification_unavailable" || pair.direction !== "query_to_memory")) invalid();
    for (const pair of [...phase.pairs, ...phase.reversePairs]) {
      const score = r.scores.find(score => score.memoryId === pair.memoryId);
      if (!score || pair.sourceEventId !== score.sourceEventId || pair.memoryVersion !== score.memoryVersion || pair.contentFingerprint !== score.contentFingerprint
        || pair.queryFingerprint !== r.queryFingerprint || pair.accessFingerprint !== r.accessFingerprint
        || pair.modelFingerprint !== batch.dense?.verificationModel?.model || pair.policyFingerprint !== batch.dense.verificationModel.policy) invalid();
    }
  }
  const chosen = receipt.chosenRoute === "baseline" ? receipt.baselineVerification : receipt.rerankedVerification;
  if (!isDeepStrictEqual(chosen.pairs, batch.dense?.pairs) || !isDeepStrictEqual(chosen.reversePairs, batch.dense?.reversePairs)
    || chosen.limit !== batch.dense?.verificationBudget?.limit) invalid();
  if (receipt.version !== "dense-cross-encoder-order-v1" || !Number.isInteger(receipt.candidateLimit) || receipt.candidateLimit < 1 || receipt.candidateLimit > 20
    || receipt.populationCount !== batch.dense?.ranking?.populationCount || receipt.sourceModelFingerprint !== batch.dense.modelFingerprint
    || receipt.sourceCandidates.length !== Math.min(receipt.populationCount, receipt.candidateLimit)
    || receipt.outsideWindow !== receipt.populationCount - receipt.sourceCandidates.length
    || new Set(receipt.sourceCandidates.map(candidate => candidate.memoryId)).size !== receipt.sourceCandidates.length
    || r.status !== "scored" || r.version !== "cross-encoder-relevance-v1" || r.meaning !== "relative_query_document_relevance_logit"
    || ![r.modelFingerprint, r.policyFingerprint, r.runtimeFingerprint, r.queryFingerprint, r.accessFingerprint].every(value => hash.test(value))
    || !["hit", "miss"].includes(r.cache) || r.scores.length !== receipt.sourceCandidates.length) invalid();
  receipt.sourceCandidates.forEach((candidate, i) => {
    const score = r.scores[i];
    if (!score || !candidate.memoryId || !candidate.sourceEventId || !Number.isInteger(candidate.memoryVersion) || candidate.memoryVersion < 1
      || candidate.cosineRank !== i + 1 || !Number.isFinite(candidate.cosineScore) || Math.abs(candidate.cosineScore) > 1.000001
      || score.memoryId !== candidate.memoryId || score.sourceEventId !== candidate.sourceEventId || score.memoryVersion !== candidate.memoryVersion
      || !hash.test(score.contentFingerprint) || !Number.isFinite(score.value)) invalid();
  });
}
export function validateRerankedHit(hit: ScoredSearchHit, batch: CandidateSearchResult): void {
  const r = batch.dense!.reranking!, evidence = hit.reranking;
  const source = r.sourceCandidates.find(candidate => candidate.memoryId === hit.memory.id), score = r.relevance.scores.find(candidate => candidate.memoryId === hit.memory.id);
  if (!evidence || !source || !score || evidence.applied !== (r.chosenRoute === "reranked")
    || (evidence.applied && (hit.score.model !== "cross_encoder_logit" || hit.score.value !== score.value || hit.score.modelFingerprint !== r.relevance.modelFingerprint))
    || evidence.modelFingerprint !== r.relevance.modelFingerprint
    || evidence.policyFingerprint !== r.relevance.policyFingerprint || evidence.runtimeFingerprint !== r.relevance.runtimeFingerprint
    || evidence.queryFingerprint !== r.relevance.queryFingerprint || evidence.accessFingerprint !== r.relevance.accessFingerprint
    || evidence.cosine.modelFingerprint !== r.sourceModelFingerprint || evidence.cosine.rank !== source.cosineRank || evidence.cosine.value !== source.cosineScore
    || evidence.score.memoryId !== score.memoryId || evidence.score.sourceEventId !== hit.memory.sourceEventId || evidence.score.memoryVersion !== hit.memory.version
    || evidence.score.contentFingerprint !== score.contentFingerprint || evidence.score.value !== score.value
    || hit.verification?.queryFingerprint !== evidence.queryFingerprint || hit.verification.accessFingerprint !== evidence.accessFingerprint
    || hit.verification.contentFingerprint !== score.contentFingerprint) invalid();
}
