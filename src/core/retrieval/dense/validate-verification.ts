import { OpenContinuityError } from "../../../shared/errors.js";
import type { BoundDensePairReceipt, BoundDensePairRequest, DensePairVerifier } from "./verification/contracts.js";
import { verifyDensePair } from "./pair-verification.js";
export function validateBoundVerification(request: BoundDensePairRequest, receipt: BoundDensePairReceipt, verifier: DensePairVerifier): void {
  const expected = verifyDensePair(request, receipt.reason === "verification_unavailable" ? null : {
    memoryId: receipt.memoryId, queryFingerprint: receipt.queryFingerprint, contentFingerprint: receipt.contentFingerprint,
    modelFingerprint: receipt.modelFingerprint, memoryToQuery: { contradiction: receipt.contradiction!, entailment: receipt.entailment!, neutral: Math.max(0, 1 - receipt.contradiction! - receipt.entailment!) },
    ...(request.direction === "query_to_memory" ? { queryToMemory: { contradiction: receipt.contradiction!, entailment: receipt.entailment!, neutral: Math.max(0, 1 - receipt.contradiction! - receipt.entailment!) } } : {})
  }, verifier.policy);
  if (verifier.fingerprint().policy !== expected.policyFingerprint || verifier.fingerprint().model !== expected.modelFingerprint
    || receipt.version !== expected.version || receipt.meaning !== expected.meaning || receipt.contradiction !== expected.contradiction || receipt.entailment !== expected.entailment
    || receipt.memoryId !== request.memoryId || receipt.sourceEventId !== request.sourceEventId || receipt.memoryVersion !== request.memoryVersion
    || receipt.accessFingerprint !== request.accessFingerprint || receipt.queryFingerprint !== request.queryFingerprint || receipt.contentFingerprint !== request.contentFingerprint
    || receipt.policyFingerprint !== expected.policyFingerprint || receipt.modelFingerprint !== expected.modelFingerprint
    || receipt.direction !== expected.direction || receipt.reason !== expected.reason || receipt.accepted !== expected.accepted || !["hit", "miss", "unavailable"].includes(receipt.cache))
    throw new OpenContinuityError("STORAGE_ERROR", "Unbound verifier receipt", 500);
}
