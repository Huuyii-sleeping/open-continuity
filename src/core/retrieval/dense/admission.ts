import { createHash } from "node:crypto";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { DenseAdmissionInput, DenseAdmissionPolicy, DenseAdmissionReason, DenseAdmissionReceipt } from "./contracts.js";

const fingerprintPattern = /^[a-f0-9]{64}$/;

export function densePolicyFingerprint(policy: DenseAdmissionPolicy): string {
  if (policy.version !== "dense-admission-v1" || !fingerprintPattern.test(policy.modelFingerprint)
    || !Number.isFinite(policy.minScore) || policy.minScore < -1 || policy.minScore > 1
    || !Number.isFinite(policy.minMargin) || policy.minMargin <= 0 || policy.minMargin > 2
    || !Number.isInteger(policy.minimumCandidates) || policy.minimumCandidates < 2 || policy.minimumCandidates > 100) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense admission policy", 400);
  }
  return createHash("sha256").update(JSON.stringify({
    version: policy.version, modelFingerprint: policy.modelFingerprint,
    minScore: policy.minScore, minMargin: policy.minMargin, minimumCandidates: policy.minimumCandidates,
    mode: "lexical_miss_only", maximumResults: 1,
  })).digest("hex");
}

/** A staged, query-agnostic decision over already authorized scores; no IO or model calls. */
export function admitDenseCandidates(input: DenseAdmissionInput, policy: DenseAdmissionPolicy): DenseAdmissionReceipt {
  const policyFingerprint = densePolicyFingerprint(policy);
  if (!Number.isInteger(input.lexicalMatches) || input.lexicalMatches < 0 || typeof input.modelReady !== "boolean"
    || !["complete", "truncated", "unavailable"].includes(input.comparison)
    || !Array.isArray(input.candidates) || input.candidates.length > 100) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense admission request", 400);
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate.memoryId !== "string" || !candidate.memoryId.trim() || candidate.memoryId.length > 256
      || ids.has(candidate.memoryId) || candidate.modelFingerprint !== policy.modelFingerprint
      || !Number.isFinite(candidate.score) || candidate.score < -1.000001 || candidate.score > 1.000001) {
      throw new OpenContinuityError("STORAGE_ERROR", "Invalid or incompatible Dense score evidence", 500);
    }
    ids.add(candidate.memoryId);
  }
  const receipt = (reason: DenseAdmissionReason): DenseAdmissionReceipt => ({
    version: policy.version, policyFingerprint, modelFingerprint: policy.modelFingerprint,
    reason, admittedMemoryIds: [], topScore: null, runnerUpScore: null, margin: null, scoreMeaning: "cosine_similarity",
  });
  if (input.lexicalMatches > 0) return receipt("lexical_preserved");
  if (!input.modelReady) return receipt("model_not_ready");
  if (input.comparison !== "complete") return receipt("comparison_incomplete");
  if (!input.candidates.length) return receipt("no_candidates");
  if (input.candidates.length < policy.minimumCandidates) return receipt("insufficient_comparison");
  const ranked = [...input.candidates].sort((a, b) => b.score - a.score || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0));
  const first = ranked[0]!, second = ranked[1]!;
  const margin = first.score - second.score;
  const result = { ...receipt("admitted"), topScore: first.score, runnerUpScore: second.score, margin };
  if (first.score < policy.minScore) return { ...result, reason: "below_similarity" };
  if (margin < policy.minMargin) return { ...result, reason: "ambiguous_candidates" };
  return { ...result, admittedMemoryIds: [first.memoryId] };
}
