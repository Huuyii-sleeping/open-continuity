import { createHash } from "node:crypto";
import type { CandidateReranker, RelevanceReceipt, RelevanceRequest } from "./contracts.js";
import { OpenContinuityError } from "../../../shared/errors.js";
export const relevanceHash = (value: string) => createHash("sha256").update(value).digest("hex");
const hash = /^[a-f0-9]{64}$/;
function invalid(): never { throw new OpenContinuityError("STORAGE_ERROR", "Unbound relevance evidence", 500); }

export function validateRelevanceRequest(request: RelevanceRequest): void {
  if (typeof request.query !== "string" || !request.query.trim() || Buffer.byteLength(request.query) > 8192
    || request.queryFingerprint !== relevanceHash(request.query) || !hash.test(request.accessFingerprint)
    || !Array.isArray(request.candidates) || !request.candidates.length || request.candidates.length > 20
    || new Set(request.candidates.map(candidate => candidate.memoryId)).size !== request.candidates.length) invalid();
  for (const candidate of request.candidates) {
    if (!candidate || typeof candidate.memoryId !== "string" || !candidate.memoryId.trim() || candidate.memoryId.length > 256
      || typeof candidate.sourceEventId !== "string" || !candidate.sourceEventId.trim() || candidate.sourceEventId.length > 256
      || !Number.isInteger(candidate.memoryVersion) || candidate.memoryVersion < 1 || typeof candidate.text !== "string"
      || !candidate.text.trim() || Buffer.byteLength(candidate.text) > 65536 || candidate.contentFingerprint !== relevanceHash(candidate.text)) invalid();
  }
}

export function validateRelevanceReceipt(request: RelevanceRequest, receipt: RelevanceReceipt, reranker: CandidateReranker): void {
  validateRelevanceRequest(request);
  const identity = reranker.fingerprint();
  if (!receipt || receipt.version !== "cross-encoder-relevance-v1" || receipt.meaning !== "relative_query_document_relevance_logit"
    || receipt.modelFingerprint !== identity.model || receipt.policyFingerprint !== identity.policy || receipt.runtimeFingerprint !== identity.runtime
    || ![identity.model, identity.policy, identity.runtime].every(value => hash.test(value))
    || receipt.queryFingerprint !== request.queryFingerprint || receipt.accessFingerprint !== request.accessFingerprint
    || !["scored", "unavailable"].includes(receipt.status) || !["hit", "miss", "unavailable"].includes(receipt.cache)
    || !Array.isArray(receipt.scores) || (receipt.status === "unavailable" ? receipt.scores.length !== 0 || receipt.cache !== "unavailable"
      : receipt.scores.length !== request.candidates.length || receipt.cache === "unavailable")) invalid();
  receipt.scores.forEach((score, index) => {
    const expected = request.candidates[index]!;
    if (!score || score.memoryId !== expected.memoryId || score.sourceEventId !== expected.sourceEventId || score.memoryVersion !== expected.memoryVersion
      || score.contentFingerprint !== expected.contentFingerprint || !Number.isFinite(score.value)) invalid();
  });
}
