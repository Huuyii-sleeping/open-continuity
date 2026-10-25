import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { beforeAll,describe,expect,it } from "vitest";
import { parseCandidateDataset } from "../evals/candidates/dataset.js";
import { evaluateCandidates,writeCandidateReports } from "../evals/candidates/evaluator.js";
import { measureCandidateCapacity } from "../evals/candidates/capacity.js";
import { compareCandidateCapacity,compareCandidateReports,validateCandidateCapacity,validateCandidateReport } from "../evals/candidates/compare.js";
import { scoreRanking } from "../evals/baseline/metrics.js";

describe("candidate evaluation evidence", () => {
  let fixture: Awaited<ReturnType<typeof evaluateCandidates>>;
  beforeAll(async () => { fixture = await evaluateCandidates(resolve("."),resolve("evals/datasets/core-baseline-v1.json"),resolve("evals/datasets/candidate-v1.json"),"native",["sqlite"]); });
  it("rejects unknown and contradictory judgments rather than silently passing them", () => {
    const raw = JSON.parse(readFileSync("evals/datasets/candidate-v1.json","utf8"));
    raw.cases[0].spec.expected.relevant = ["unknown"];
    expect(() => parseCandidateDataset(raw)).toThrow("Invalid judgment label");
    raw.cases[0].spec.expected.relevant = ["noise"];
    expect(() => parseCandidateDataset(raw)).toThrow("Contradictory judgment");
  });
  it("keeps original judgments, challenge failures, score ablations and separate reports", async () => {
    const report = fixture;
    expect(report.gate.passed).toBe(true);
    expect(report.rows.filter(r => r.dataset === "core-baseline-v1")).toHaveLength(60);
    const paraphrase = report.rows.find(r => r.id === "english-semantic-paraphrase")!;
    expect(paraphrase).toMatchObject({ status: "challenge",passed: false,selected: [] });
    expect(paraphrase.ranking.miss.numerator).toBe(1);
    const bm25 = report.rows.find(r => r.id === "candidate-bm25-not-recency")!;
    expect(bm25.selected).toEqual(["target"]);
    expect(bm25.ablation!.selected).toEqual(["noise"]);
    expect(bm25.ablation!.ranking.falseSelection.numerator).toBe(1);
    expect(report.summary["sqlite/core-baseline-v1/full_text"]!.leakage.userConfirmed.denominator).toBe(0);
    expect(report.summary["sqlite/core-baseline-v1/full_text"]!.leakage.userConfirmed.value).toBeNull();
    const root = mkdtempSync(join(tmpdir(),"oc-candidate-report-test-"));
    try {
      writeCandidateReports(root,report);
      const security = JSON.parse(readFileSync(join(root,"security/sqlite-core-baseline-v1-full_text.json"),"utf8"));
      expect(security.summary.user.numerator).toBe(0);
      expect(security.summary.userConfirmed.value).toBeNull();
      const quality = JSON.parse(readFileSync(join(root,"quality/sqlite-core-baseline-v1-full_text.json"),"utf8"));
      expect(quality.summary).not.toHaveProperty("latency");
      expect(quality.summary).not.toHaveProperty("leakage");
      expect(() => writeCandidateReports(root,report)).toThrow();
    } finally { rmSync(root,{ recursive: true,force: true }); }
  });
  it("checks candidate capacity responses and retains all samples", async () => {
    const report = await measureCandidateCapacity(resolve("."),"native",[20],3,1);
    expect(report.validityPassed).toBe(true);
    expect(report.results[0]!.operations).toHaveLength(4);
    for (const operation of report.results[0]!.operations) expect(operation.samplesMs).toHaveLength(3);
    expect(compareCandidateCapacity(report,report).latencyGate).toBe("NOT ESTABLISHED");
    const altered = structuredClone(report); altered.results[0]!.operations[0]!.p95 = 999;
    expect(() => validateCandidateCapacity(altered)).toThrow("Invalid capacity samples");
    const missing = structuredClone(report); missing.results[0]!.operations.pop();
    expect(() => validateCandidateCapacity(missing)).toThrow("Incomplete capacity operations");
    const otherNode = structuredClone(report); otherNode.environment.node = "fictional-other-runtime";
    expect(() => compareCandidateCapacity(report,otherNode)).toThrow("not comparable");
    await expect(measureCandidateCapacity(resolve("."),"native",[],3,1)).rejects.toThrow("Invalid candidate capacity workload");
  });
  it("recomputes outcomes and rejects missing/duplicate rows and falsified pass flags", () => {
    expect(validateCandidateReport(fixture).gate.passed).toBe(true);
    expect(compareCandidateReports(fixture,fixture)).toMatchObject({ passed: true,comparedRows: 105,regressions: [] });
    const missing = structuredClone(fixture); missing.rows.pop();
    expect(() => validateCandidateReport(missing)).toThrow("Incomplete comparison rows");
    const duplicate = structuredClone(fixture); duplicate.rows[1] = structuredClone(duplicate.rows[0]!);
    expect(() => validateCandidateReport(duplicate)).toThrow("Duplicate or unexpected");
    const tampered = structuredClone(fixture); tampered.rows.find(r => r.id === "english-semantic-paraphrase")!.passed = true;
    expect(() => validateCandidateReport(tampered)).toThrow("Stored outcome");
    const score = structuredClone(fixture); score.rows[0]!.ranking.miss.numerator++;
    expect(() => validateCandidateReport(score)).toThrow("Stored ranking");
  });
  it("refuses changed datasets, evaluator hashes, budgets and coverage", () => {
    for (const field of ["harnessHash","coreDatasetHash","candidateDatasetHash","lockHash"] as const) {
      const changed = structuredClone(fixture); changed.comparable[field] = "0".repeat(64);
      expect(() => compareCandidateReports(fixture,changed)).toThrow("not comparable");
    }
    const budget = structuredClone(fixture); budget.rows[0]!.limit++;
    expect(() => compareCandidateReports(fixture,budget)).toThrow("budget changed");
    const coverage = structuredClone(fixture); coverage.comparable.caseKeys.pop();
    expect(() => validateCandidateReport(coverage)).toThrow("Incomplete comparison rows");
  });
  it("flags newly introduced false selections even when the old denominator was zero", () => {
    const changed = structuredClone(fixture);
    for (const row of changed.rows.filter(r => r.id === "english-semantic-paraphrase")) {
      row.selected = ["unknown-fictional-result"];
      row.observed = [{ label: row.selected[0]!,value: "fictional noise",version: 1 }];
      row.repetitions = Array.from({length:5},() => [...row.selected]);
      row.ranking = scoreRanking(row.selected,row.judgment,changed.comparable.ks,row.grades);
    }
    const comparison = compareCandidateReports(fixture,changed);
    expect(comparison.passed).toBe(false);
    expect(comparison.regressions.filter(r => r.metric === "false-selection-count")).toHaveLength(3);
  });
  it("does not accept empty backend coverage as a successful evaluation", async () => {
    await expect(evaluateCandidates(resolve("."),resolve("evals/datasets/core-baseline-v1.json"),resolve("evals/datasets/candidate-v1.json"),"native",[])).rejects.toThrow("unique known backends");
  });
});
