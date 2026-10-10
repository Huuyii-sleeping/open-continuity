import { describe, expect, it } from "vitest";
import { evaluateGoldenDataset, loadGoldenDataset } from "../evals/runners/golden-evaluator.js";

describe("Golden Dataset evaluation", () => {
  it("meets the deterministic capture and injection safety gates", async () => {
    const result = await evaluateGoldenDataset(loadGoldenDataset("evals/datasets/golden-v1.json"));
    expect(result.capture.candidatePrecision.value).toBe(1);
    expect(result.capture.candidateRecall.value).toBe(1);
    expect(result.capture.sensitiveBlockRate.value).toBe(1);
    expect(result.injection.precisionAtK.value).toBe(1);
    expect(result.injection.recallAtK.value).toBe(1);
    expect(result.injection.falseInjectionRate.value).toBe(0);
    expect(result.injection.missRate.value).toBe(0);
    expect(result.injection.securityLeakageRate.value).toBe(0);
  }, 15_000);
});
