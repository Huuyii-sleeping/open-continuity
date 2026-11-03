import { describe, expect, it } from "vitest";
import { admitDenseCandidates, densePolicyFingerprint } from "../../../src/core/retrieval/dense/admission.js";
import type { DenseAdmissionInput, DenseAdmissionPolicy } from "../../../src/core/retrieval/dense/contracts.js";

const modelFingerprint = "a".repeat(64);
const policy: DenseAdmissionPolicy = { version: "dense-admission-v1", modelFingerprint, minScore: 0.7, minMargin: 0.1, minimumCandidates: 2 };
const input = (scores: number[], lexicalMatches = 0): DenseAdmissionInput => ({
  lexicalMatches, modelReady: true, comparison: "complete",
  candidates: scores.map((score, index) => ({ memoryId: `fictional-memory-${index}`, modelFingerprint, score })),
});

describe("staged Dense admission", () => {
  it("does not expand a lexical hit with a stronger semantic neighbour", () => {
    const result = admitDenseCandidates(input([0.99, 0.8], 1), policy);
    expect(result.reason).toBe("lexical_preserved"); expect(result.admittedMemoryIds).toEqual([]);
  });
  it("admits only the strongest candidate with sufficient absolute and relative evidence", () => {
    const request = input([0.4, 0.9, 0.6]); const before = structuredClone(request);
    const result = admitDenseCandidates(request, policy);
    expect(result.admittedMemoryIds).toEqual(["fictional-memory-1"]);
    expect(result.topScore).toBe(0.9); expect(result.runnerUpScore).toBe(0.6);
    expect(request).toEqual(before);
  });
  it("does not treat the nearest unrelated vector as a match", () => {
    expect(admitDenseCandidates(input([0.4, 0.1]), policy).reason).toBe("below_similarity");
  });
  it("rejects high similarity with a close competitor and exact ties", () => {
    expect(admitDenseCandidates(input([0.95, 0.94]), policy).reason).toBe("ambiguous_candidates");
    const a = input([0.9, 0.9]);
    expect(admitDenseCandidates(a, policy)).toEqual(admitDenseCandidates({ ...a, candidates: [...a.candidates].reverse() }, policy));
    expect(admitDenseCandidates(a, policy).admittedMemoryIds).toEqual([]);
  });
  it("cannot infer relevance from a single candidate or an incomplete comparison", () => {
    expect(admitDenseCandidates(input([0.99]), policy).reason).toBe("insufficient_comparison");
    expect(admitDenseCandidates(input([]), policy).reason).toBe("no_candidates");
    expect(admitDenseCandidates({ ...input([0.99, 0.1]), comparison: "truncated" }, policy).reason).toBe("comparison_incomplete");
    expect(admitDenseCandidates({ ...input([0.99, 0.1]), modelReady: false }, policy).reason).toBe("model_not_ready");
  });
  it("binds decisions to model space and threshold policy", () => {
    const result = admitDenseCandidates(input([0.9, 0.2]), policy);
    expect(result.policyFingerprint).toBe(densePolicyFingerprint(policy));
    expect(densePolicyFingerprint({ ...policy, minScore: 0.8 })).not.toBe(result.policyFingerprint);
    expect(densePolicyFingerprint({ ...policy, modelFingerprint: "b".repeat(64) })).not.toBe(result.policyFingerprint);
    const broken = input([0.9, 0.2]); broken.candidates[0]!.modelFingerprint = "b".repeat(64);
    expect(() => admitDenseCandidates(broken, policy)).toThrow("incompatible Dense");
  });
  it.each([NaN, Infinity, -Infinity, 1.1, -1.1])("rejects invalid cosine %s", score => {
    expect(() => admitDenseCandidates(input([score, 0.1]), policy)).toThrow("Dense score evidence");
  });
  it("rejects duplicates and invalid policy/request shape", () => {
    const duplicate = input([0.9, 0.2]); duplicate.candidates[1]!.memoryId = duplicate.candidates[0]!.memoryId;
    expect(() => admitDenseCandidates(duplicate, policy)).toThrow();
    for (const patch of [{ minScore: NaN }, { minMargin: 0 }, { minimumCandidates: 1 }, { modelFingerprint: "unknown" }]) {
      expect(() => admitDenseCandidates(input([0.9, 0.2]), { ...policy, ...patch })).toThrow();
    }
    expect(() => admitDenseCandidates({ ...input([]), lexicalMatches: -1 }, policy)).toThrow();
  });
});
