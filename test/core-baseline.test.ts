import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { compareReports } from "../evals/baseline/compare.js";
import { loadDataset, parseDataset } from "../evals/baseline/dataset.js";
import { evaluateBaseline } from "../evals/baseline/evaluator.js";
import { ratio, scoreRanking } from "../evals/baseline/metrics.js";
import { measureCapacity, validCapacitySelection } from "../evals/baseline/performance.js";
import { writeSplitReports } from "../evals/baseline/reports.js";

describe("Core baseline measurement integrity", () => {
  it("computes ranks from known judgments and counts forbidden/unknown distractors", () => {
    const score = scoreRanking(["forbidden", "support", "target", "unknown"], { relevant: ["target", "support"], forbidden: ["forbidden"] }, [1, 3, 5], { target: 2, support: 1 });
    expect(score.atK["1"]!.recall.value).toBe(0);
    expect(score.atK["3"]!.recall.value).toBe(1);
    expect(score.atK["3"]!.reciprocalRank).toBe(0.5);
    expect(score.atK["3"]!.ndcg).toBeCloseTo((1 / Math.log2(3) + 3 / Math.log2(4)) / (3 + 1 / Math.log2(3)));
    expect(score.falseSelection).toEqual(ratio(2, 4));
    expect(score.forbiddenSelected).toEqual(["forbidden"]);
  });

  it("does not inflate metrics with duplicates or fabricate scores for empty denominators", () => {
    const score = scoreRanking(["target", "target"], { relevant: ["target", "missing"], forbidden: [] }, [3]);
    expect(score.atK["3"]!.recall.value).toBe(0.5);
    expect(score.atK["3"]!.ndcg).toBeCloseTo(1 / (1 + 1 / Math.log2(3)));
    expect(score.duplicates).toBe(1);
    const empty = scoreRanking([], { relevant: [], forbidden: [] }, [1]);
    expect(empty.atK["1"]!.reciprocalRank).toBeNull();
    expect(empty.falseSelection.value).toBeNull();
  });

  it("rejects ambiguous fixture identifiers and contradictory judgments", () => {
    const dataset = loadDataset("evals/datasets/core-baseline-v1.json");
    const contradictory = structuredClone(dataset);
    contradictory.cases[0]!.expected.forbidden.push(contradictory.cases[0]!.expected.relevant[0]!);
    expect(() => parseDataset(contradictory)).toThrow("Contradictory");
    const duplicate = structuredClone(dataset);
    duplicate.cases.push(duplicate.cases[0]!);
    expect(() => parseDataset(duplicate)).toThrow("Duplicate case");
  });

  it("checks capacity responses so an empty or wrong retrieval cannot look fast", async () => {
    const result = await measureCapacity(resolve("."), [10], 5, 1);
    expect(validCapacitySelection("fts", [], 0, "Topic 000000")).toBe(false);
    const wrongRecord = {
      key: "noise",
      value: "Topic 000001",
    };
    const matchingRecord = {
      key: "target",
      value: "Topic 000000",
    };
    expect(validCapacitySelection("fts", [wrongRecord], 0, "Topic 000000")).toBe(false);
    expect(validCapacitySelection("fts", [matchingRecord], 0, "Topic 000000")).toBe(true);
    expect(result.results[0]!.samples.every((sample) => sample.count === 5)).toBe(true);
    await expect(measureCapacity(resolve("."), [0])).rejects.toThrow("Invalid");
  });

  it("runs isolated SQLite measurements and catches regressions without hiding failed challenges", async () => {
    const report = await evaluateBaseline(resolve("."), resolve("evals/datasets/core-baseline-v1.json"), ["sqlite"]);
    expect(report.gate).toMatchObject({ errors: [], leakageObservations: 0 });
    expect(report.gate.requiredFailures).toHaveLength(report.rows.filter((row) => row.status === "required" && !row.passed).length);
    expect(report.gate.passed).toBe(report.gate.requiredFailures.length === 0);
    expect(report.rows).toHaveLength(20 * 3 * 2);
    expect(report.rows.filter((row) => row.status === "challenge" && !row.passed).length).toBeGreaterThan(0);
    const temporary = mkdtempSync(resolve(tmpdir(), "open-continuity-report-test-"));
    try {
      const root = resolve(temporary, "evidence");
      writeSplitReports(root, report, null, null);
      const recall = JSON.parse(readFileSync(resolve(root, "recall/sqlite.json"), "utf8"));
      expect(Object.keys(recall.groups)).toEqual(["required", "challenge"]);
      expect(recall.observations[0]).not.toHaveProperty("leakage");
      expect(recall.observations[0]).not.toHaveProperty("latency");
      expect(readFileSync(resolve(root, "security/sqlite.md"), "utf8")).toContain("未覆盖");
      expect(readFileSync(resolve(root, "engineering/README.md"), "utf8")).toContain("未运行");
      expect(() => writeSplitReports(root, report, null, null)).toThrow();
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    expect(compareReports(report, report)).toMatchObject({ passed: report.gate.passed, regressions: [] });
    const changedDataset = structuredClone(report);
    changedDataset.comparable.datasetHash = "different";
    expect(() => compareReports(report, changedDataset)).toThrow("Incomparable");
    const missing = structuredClone(report);
    missing.rows.pop();
    expect(() => compareReports(report, missing)).toThrow("Missing");
    const regression = structuredClone(report);
    const row = regression.rows.find((item) => item.status === "required" && item.ranking.atK["1"]!.recall.value === 1)!;
    row.ranking.atK["1"]!.recall = ratio(0, 1);
    expect(compareReports(report, regression)).toMatchObject({ passed: false, regressions: expect.arrayContaining([expect.objectContaining({ signal: "recall@1" })]) });
    const leak = structuredClone(report);
    leak.rows.find((item) => item.leakage.private!.denominator > 0)!.leakage.private!.numerator = 1;
    expect(compareReports(report, leak).passed).toBe(false);
  }, 60_000);
});
