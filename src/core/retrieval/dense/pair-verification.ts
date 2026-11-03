import { createHash } from "node:crypto";
import { OpenContinuityError } from "../../../shared/errors.js";
import type { DensePairEvidence, DensePairPolicy, DensePairReceipt, DensePairRequest, PairProbabilities } from "./pair-contracts.js";

const fingerprint = /^[a-f0-9]{64}$/;
function probabilities(value: PairProbabilities): boolean {
  return value !== null && typeof value === "object"
    && [value.entailment, value.neutral, value.contradiction].every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    && Math.abs(value.entailment + value.neutral + value.contradiction - 1) <= 0.00001;
}

/** Only consumes a bound, already-authorized candidate. It cannot expand or rerank a population. */
export function verifyDensePair(request: DensePairRequest, evidence: DensePairEvidence | null, policy: DensePairPolicy): DensePairReceipt {
  if (policy.version !== "dense-pair-v1" || !fingerprint.test(policy.modelFingerprint)
    || !Number.isFinite(policy.maxContradiction) || policy.maxContradiction < 0 || policy.maxContradiction > 1
    || !Number.isFinite(policy.minEntailment) || policy.minEntailment < 0 || policy.minEntailment > 1
    || typeof request.memoryId !== "string" || !request.memoryId.trim()
    || !fingerprint.test(request.queryFingerprint) || !fingerprint.test(request.contentFingerprint)
    || !["memory_to_query", "query_to_memory"].includes(request.direction ?? "memory_to_query")) {
    throw new OpenContinuityError("VALIDATION_ERROR", "Invalid Dense text-pair verification policy or request", 400);
  }
  const policyFingerprint = createHash("sha256").update(JSON.stringify({
    version: policy.version, modelFingerprint: policy.modelFingerprint,
    maxContradiction: policy.maxContradiction, minEntailment: policy.minEntailment, directionalPolicy: "memory_premise_query_hypothesis",
  })).digest("hex");
  const receipt: DensePairReceipt = {
    version: policy.version, accepted: false, reason: "verification_unavailable", policyFingerprint,
    modelFingerprint: policy.modelFingerprint, memoryId: request.memoryId,
    queryFingerprint: request.queryFingerprint, contentFingerprint: request.contentFingerprint,
    contradiction: null, entailment: null, meaning: "text_pair_model_support",
    ...(request.direction ? { direction: request.direction } : {}),
  };
  if (evidence === null) return receipt;
  if (evidence.memoryId !== request.memoryId || evidence.modelFingerprint !== policy.modelFingerprint
    || evidence.queryFingerprint !== request.queryFingerprint || evidence.contentFingerprint !== request.contentFingerprint
    || !probabilities(evidence.memoryToQuery) || (evidence.queryToMemory !== undefined && !probabilities(evidence.queryToMemory))) {
    throw new OpenContinuityError("STORAGE_ERROR", "Unbound or invalid Dense text-pair evidence", 500);
  }
  const evaluated = request.direction === "query_to_memory" ? evidence.queryToMemory : evidence.memoryToQuery;
  if (!evaluated) throw new OpenContinuityError("STORAGE_ERROR", "Missing reverse Dense support evidence", 500);
  const contradiction = evaluated.contradiction;
  const entailment = evaluated.entailment;
  const result = { ...receipt, contradiction, entailment };
  if (contradiction >= policy.maxContradiction) return { ...result, reason: "contradictory_pair" };
  if (entailment < policy.minEntailment) return { ...result, reason: "insufficient_pair_support" };
  return { ...result, accepted: true, reason: "verified_pair" };
}
