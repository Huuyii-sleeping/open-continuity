import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLexicalCases } from "../../../evals/lexical/dataset.js";
import { compareAblation, evaluateAblation } from "../../../evals/lexical/evaluator.js";
import { evaluateLexicalPerformance, performanceGate } from "../../../evals/lexical/performance.js";
import { validateReport } from "../../../evals/diagnostics/evaluator.js";
import { latencySummary } from "../../../evals/baseline/metrics.js";

describe("6C honest acceptance", () => {
  it("keeps gains and real-word false selections separate without weakening negative judgments", async () => {
    const all = loadLexicalCases(); expect(all).toHaveLength(16);
    const cases = all.filter(item => ["spell-delete", "negative-real-word", "negative-real-word-deletion", "literal-no-expansion"].includes(item.id));
    const { off, on, comparison } = await evaluateAblation(resolve("."), cases);
    expect(off.gate.passed).toBe(true); expect(on.gate.passed).toBe(false);
    expect(comparison.integrityAndSafetyPassed).toBe(true);
    expect(comparison.regressions).toHaveLength(6); // Two distinct negatives × three public endpoints; rebuilds do not inflate cases.
    expect(comparison.groups.find(group => group.category === "single_edit" && group.endpoint === "context")?.improvedCases).toEqual(["spell-delete"]);
    expect(comparison.groups.find(group => group.category === "real_word_ambiguity" && group.endpoint === "context")?.regressedCases).toEqual(["negative-real-word", "negative-real-word-deletion"]);
    const forged = structuredClone(on); forged.gate.passed = true;
    expect(() => validateReport(forged, cases)).toThrow("Forged");
    const wrongCorrection = structuredClone(on);
    wrongCorrection.rows.find(row => row.id === "spell-delete")!.observations[0]!.traces[2]!.hits[0]!.correction!.edit = "insert";
    expect(() => validateReport(wrongCorrection, cases)).toThrow("correction");
    const mismatched = structuredClone(on); mismatched.comparable.node = "fictional-other-runtime";
    expect(() => compareAblation(off, mismatched, cases)).toThrow("Incomparable");
  });
  it("validates every performance cell, sample count and derived percentile", async () => {
    // Small engineering contract test, not the formal 1k/10k/100 acceptance workload.
    const report = await evaluateLexicalPerformance(resolve("."), [100], 3, 0);
    expect(report.rows).toHaveLength(24);
    expect(performanceGate(report.rows, [100], 3)).toEqual(report.gate);
    const missing = structuredClone(report.rows); missing.pop(); expect(() => performanceGate(missing, [100], 3)).toThrow("grid");
    const forged = structuredClone(report.rows); forged[0]!.latency.p95 = 0; expect(() => performanceGate(forged, [100], 3)).toThrow("grid");
    const invalid = structuredClone(report.rows); invalid[0]!.latency.samplesMs[0] = -1; expect(() => performanceGate(invalid, [100], 3)).toThrow("grid");
  });
  it("rejects empty or invalid measurement settings before accepting a performance grid", () => {
    for (const sizes of [[], [100, 100], [99], [10001], [100.5], [NaN], [Infinity]]) {
      expect(() => performanceGate([], sizes, 100)).toThrow("settings");
    }
    for (const iterations of [0, -1, 0.5, NaN, Infinity]) {
      expect(() => performanceGate([], [100], iterations)).toThrow("settings");
    }
    expect(() => performanceGate([], [100], 100)).toThrow("grid");
  });
  it("rejects zero-sample cells and still fails complete over-budget measurements", () => {
    const rows = [1, 2, 3].flatMap(round => (["literal_hit", "typo_hit", "absent", "broad_probe"] as const).flatMap(workload => (["off", "latin_one_edit"] as const).map(policy => ({
      size: 100, round, workload, policy, latency: latencySummary([]),
    }))));
    expect(() => performanceGate(rows, [100], 0)).toThrow("settings");
    expect(() => performanceGate(rows, [100], 1)).toThrow("grid");
    const measured = rows.map(row => ({ ...row, latency: latencySummary([row.policy === "latin_one_edit" && row.workload === "broad_probe" ? 10 : 1]) }));
    expect(performanceGate(measured, [100], 1)).toMatchObject({ passed: false, comparisons: expect.arrayContaining([
      expect.objectContaining({ workload: "broad_probe", offP95MedianMs: 1, onP95MedianMs: 10, thresholdMs: 4, passed: false }),
    ]) });
    expect(() => performanceGate([...measured.slice(0, -1), measured[0]!], [100], 1)).toThrow("grid");
  });
});
