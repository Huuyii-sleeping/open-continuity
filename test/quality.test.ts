import { describe, expect, it } from "vitest";
import { evaluateQuality, loadQualityDataset } from "../evals/runners/quality-evaluator.js";

describe("retrieval quality challenge suite", () => {
  it("keeps required similarity, evolution, and security cases green", async () => {
    const dataset = loadQualityDataset("evals/datasets/quality-v1.json");
    const result = await evaluateQuality(dataset);

    expect(result.rounds).toBe(3);
    expect(result.totals).toEqual({ capture: 15, retrieval: 42, all: 57, required: 15, challenge: 42 });
    expect(result.passRates.required.value).toBe(1);
    expect(result.security.leakageRate.value).toBe(0);
    expect(result.requiredFailures).toEqual([]);
    expect(result.passed).toBe(true);
  }, 30_000);
});
