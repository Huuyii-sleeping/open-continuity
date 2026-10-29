import { describe, expect, it } from "vitest";
import { verifyDensePair } from "../../../src/core/retrieval/dense/pair-verification.js";
import type { DensePairEvidence, DensePairPolicy } from "../../../src/core/retrieval/dense/pair-contracts.js";

const modelFingerprint = "a".repeat(64), queryFingerprint = "b".repeat(64), contentFingerprint = "c".repeat(64);
const request = { memoryId: "fictional-memory", queryFingerprint, contentFingerprint };
const policy: DensePairPolicy = { version: "dense-pair-v1", modelFingerprint, maxContradiction: .5, minEntailment: .5 };
const evidence: DensePairEvidence = { ...request, modelFingerprint,
  memoryToQuery: { entailment: .8, neutral: .15, contradiction: .05 }, queryToMemory: { entailment: .6, neutral: .3, contradiction: .1 } };

describe("staged Dense text-pair verification", () => {
  it("accepts supported noncontradictory text pairs with bound receipts", () => {
    const result = verifyDensePair(request, evidence, policy);
    expect(result.accepted).toBe(true); expect(result.memoryId).toBe(request.memoryId);
    expect(result.entailment).toBe(.8); expect(result.contradiction).toBe(.05);
    expect(result.meaning).toBe("text_pair_model_support");
  });
  it("vetoes contradictory candidate premises despite reverse support", () => {
    const opposite = { entailment: .05, neutral: .05, contradiction: .9 };
    const result = verifyDensePair(request, { ...evidence, memoryToQuery: opposite }, policy);
    expect(result.accepted).toBe(false); expect(result.reason).toBe("contradictory_pair");
  });
  it("does not reverse the asymmetric premise/hypothesis relationship", () => {
    const reverse = { entailment: .05, neutral: .05, contradiction: .9 };
    expect(verifyDensePair(request, { ...evidence, queryToMemory: reverse }, policy).accepted).toBe(true);
    const { queryToMemory: _diagnostic, ...forwardOnly } = evidence;
    expect(verifyDensePair(request, forwardOnly, policy).accepted).toBe(true);
  });
  it("does not turn neutral model output into an approved candidate", () => {
    const neutral = { entailment: .1, neutral: .8, contradiction: .1 };
    expect(verifyDensePair(request, { ...evidence, memoryToQuery: neutral, queryToMemory: neutral }, policy).reason).toBe("insufficient_pair_support");
  });
  it("abstains when the verifier is unavailable", () => {
    expect(verifyDensePair(request, null, policy)).toMatchObject({ accepted: false, reason: "verification_unavailable", contradiction: null });
  });
  it.each(["memoryId", "queryFingerprint", "contentFingerprint", "modelFingerprint"] as const)("rejects stale or substituted %s", field => {
    expect(() => verifyDensePair(request, { ...evidence, [field]: "d".repeat(64) }, policy)).toThrow("Unbound");
  });
  it("rejects invalid, nonnormalised, NaN and out-of-range probabilities", () => {
    for (const invalid of [{ entailment: NaN, neutral: .2, contradiction: .8 }, { entailment: .8, neutral: .8, contradiction: .8 },
      { entailment: -1, neutral: 1, contradiction: 1 }]) {
      expect(() => verifyDensePair(request, { ...evidence, memoryToQuery: invalid }, policy)).toThrow("invalid Dense");
    }
  });
  it("binds policy receipts to thresholds and validates their range", () => {
    expect(verifyDensePair(request, evidence, { ...policy, minEntailment: .7 }).policyFingerprint).not.toBe(verifyDensePair(request, evidence, policy).policyFingerprint);
    for (const patch of [{ maxContradiction: NaN }, { minEntailment: -1 }, { modelFingerprint: "unknown" }]) {
      expect(() => verifyDensePair(request, evidence, { ...policy, ...patch })).toThrow("policy");
    }
  });
});
