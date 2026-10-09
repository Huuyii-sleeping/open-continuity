import { describe, expect, it } from "vitest";
import { evaluateSuite, loadSuiteDataset } from "../evals/runners/suite-evaluator.js";

describe("multi-round assessment suite", () => {
  it("passes every Capture, Injection, and governance case across all rounds", async () => {
    const dataset = loadSuiteDataset("evals/datasets/suite-v1.json");
    const result = await evaluateSuite(dataset);

    expect(result.rounds).toBe(5);
    expect(result.totals).toEqual({ capture: 90, injection: 65, governance: 30, all: 185 });
    expect(result.passRates.capture.value).toBe(1);
    expect(result.passRates.injection.value).toBe(1);
    expect(result.passRates.governance.value).toBe(1);
    expect(result.passRates.all.value).toBe(1);
    expect(result.security.leakageRate.value).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.latencyMs.p95).toBeLessThanOrEqual(dataset.thresholds.maxInjectionP95Ms);
    expect(result.passed).toBe(true);
  }, 30_000);
});
