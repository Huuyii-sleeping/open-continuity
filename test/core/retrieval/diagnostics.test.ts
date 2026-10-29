import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertObservation, diagnose, valueHash, type Observation } from "../../../evals/diagnostics/analysis.js";
import { diagnosticCaseSchema, loadDiagnosticCases, validateCases } from "../../../evals/diagnostics/dataset.js";
import { compareDiagnostics, deriveReport, evaluateDiagnostics, validateReport } from "../../../evals/diagnostics/evaluator.js";
import { writeDiagnosticReports } from "../../../evals/diagnostics/reports.js";
import { loadDataset } from "../../../evals/baseline/dataset.js";
import { BACKENDS } from "../../../evals/baseline/evaluator.js";

const load = () => loadDiagnosticCases("evals/datasets/core-baseline-v1.json", "evals/datasets/retrieval-diagnostics-v1.json");
describe("6A diagnostics integrity", () => {
  it("keeps every legacy judgment unchanged and declares exposed acceptance honestly", () => {
    const cases = load(), legacy = loadDataset("evals/datasets/core-baseline-v1.json");
    expect(cases).toHaveLength(38);
    for (const item of legacy.cases) {
      const adapted = cases.find(candidate => candidate.id === item.id)!;
      expect(adapted.expected).toEqual(item.expected); expect(adapted.recallExpected).toEqual(item.recallExpected);
      expect(adapted.grades).toEqual(item.grades);
    }
    expect(cases.filter(item => item.partition === "acceptance_exposed")).toHaveLength(10);
    const bad = structuredClone(cases); bad[0]!.expected.forbidden.push(bad[0]!.expected.relevant[0]!);
    expect(() => validateCases(bad)).toThrow("Contradictory");
    expect(() => validateCases([...cases, cases[0]!])).toThrow("identities");
    expect(valueHash({ a: 1, b: { c: 2 } })).toBe(valueHash({ b: { c: 2 }, a: 1 }));
  });
  it("runs four stores with whole-value, confirmation and explicit-conflict observations", async () => {
    const cases = load().filter(item => ["dev-budget-whole-value", "dev-candidate-window", "dev-confirmation-gate", "dev-explicit-conflict", "accept-whole-object"].includes(item.id));
    const report = await evaluateDiagnostics(resolve("."), cases, BACKENDS);
    expect(report.gate).toMatchObject({ passed: true, requiredFailures: [], errors: [], leaks: [] });
    expect(report.rows).toHaveLength(5 * 4 * 3 * 3);
    expect(validateReport(report, cases)).toEqual(report);
    expect(compareDiagnostics(report, report, cases)).toEqual({ passed: true, regressions: [] });
    const regressed = structuredClone(report);
    const changed = regressed.rows.find(row => row.id === "dev-confirmation-gate" && row.endpoint === "context")!;
    changed.observations[0]!.selected = []; changed.observations[0]!.budget!.used = 0;
    changed.observations[0]!.contextBytes = 0;
    Object.assign(regressed, deriveReport(regressed.rows, cases));
    expect(compareDiagnostics(report, regressed, cases).passed).toBe(false);
    const budget = report.rows.find(row => row.id === "dev-budget-whole-value" && row.endpoint === "query")!;
    expect(diagnose(cases.find(item => item.id === budget.id)!, budget.endpoint, budget.observations[0]!).issues).toContainEqual(expect.objectContaining({ stage: "context", reason: "token_budget" }));
    const conflict = report.rows.find(row => row.id === "dev-explicit-conflict" && row.endpoint === "query")!;
    expect(conflict.observations[0]!.answer?.status).toBe("abstain");
    expect(conflict.observations[0]!.factOmissions).toHaveLength(2);
    const confirmation = report.rows.find(row => row.id === "dev-confirmation-gate" && row.endpoint === "context")!;
    const confirmed = diagnose(cases.find(item => item.id === confirmation.id)!, confirmation.endpoint, confirmation.observations[0]!);
    expect(confirmed.issues).toEqual([]);
    expect(confirmed.policyIneligibleUnexposed).toContainEqual({ label: "pending", boundary: "userConfirmed" });
    const window = report.rows.find(row => row.id === "dev-candidate-window" && row.backend === "sqlite" && row.endpoint === "context")!;
    expect(diagnose(cases.find(item => item.id === window.id)!, window.endpoint, window.observations[0]!).issues).toContainEqual(expect.objectContaining({ stage: "retrieval", reason: "candidate_window" }));
    for (const mutate of [
      (r: typeof report) => { r.rows.pop(); },
      (r: typeof report) => { r.rows.push(r.rows[0]!); },
      (r: typeof report) => { r.gate.passed = false; },
      (r: typeof report) => { r.rows[0]!.observations[0]!.probes.pop(); },
      (r: typeof report) => { r.rows[0]!.observations[0]!.traces[2]!.hits[0]!.rank = 9; },
      (r: typeof report) => { r.comparable.datasetHash = "changed"; },
      (r: typeof report) => { r.coverage.heldout = true; },
      (r: typeof report) => { r.rows[0]!.fixture[0]!.valueHash = valueHash("invented fixture"); },
      (r: typeof report) => { r.summary[Object.keys(r.summary)[0]!]!.miss.denominator++; },
      (r: typeof report) => { const row = r.rows.find(row => row.id === "accept-whole-object" && row.endpoint === "query")!; row.observations[0]!.answer!.citations[0]!.version = 0; },
      (r: typeof report) => { const row = r.rows.find(row => row.id === "accept-whole-object" && row.endpoint === "query")!; row.observations[0]!.answer!.statements[0]!.valueHash = valueHash("invented"); },
      (r: typeof report) => { const row = r.rows.find(row => row.id === "accept-whole-object" && row.endpoint === "query")!; row.observations[0]!.answer!.coveredQueries = 0; row.observations[0]!.answer!.totalQueries = 0; },
      (r: typeof report) => { const row = r.rows.find(row => row.id === "accept-whole-object" && row.endpoint === "context")!; row.observations[0]!.budget!.used = 0; },
    ]) {
      const broken = structuredClone(report); mutate(broken); expect(() => validateReport(broken, cases)).toThrow();
    }
    const root = mkdtempSync(join(tmpdir(), "oc-fictional-diagnostic-report-"));
    try {
      const directory = join(root, "new-report"); writeDiagnosticReports(directory, report, cases);
      expect(readFileSync(join(directory, "README.md"), "utf8")).toContain("不是盲测held-out");
      expect(readFileSync(join(directory, "security/sqlite/development/context.json"), "utf8")).not.toContain("baseline-fictional-user");
      expect(() => writeDiagnosticReports(directory, report, cases)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60000);
  it("does not count filter-only candidates or call a truncated unseen probe an absence", async () => {
    const item = diagnosticCaseSchema.parse({ id: "fictional-unseen", partition: "development", status: "challenge", category: "lexical", rationale: "fictional negative attribution counterexample", query: "fictional absent",
      memories: [{ label: "target", key: "fictional", value: "fictional target" }], expected: { relevant: ["target"], forbidden: [], ordered: ["target"] } });
    const report = await evaluateDiagnostics(resolve("."), [item], ["inmemory"]);
    const row = report.rows.find(row => row.endpoint === "context")!;
    const absent = diagnose(item, "context", row.observations[0]!);
    expect(absent.orderMatches).toBe(false);
    expect(absent.issues.every(issue => issue.stage !== "ranking")).toBe(true);
    const observation: Observation = structuredClone(row.observations[0]!);
    observation.traces[1]!.hits = [{ memory: row.fixture[0]!, rank: 1, rankMeaning: "filter_order", score: { model: "none", value: null, direction: "not_applicable" }, matchType: "structured_filter", matchReason: "explicit_filters" }];
    expect(diagnose(item, "context", observation).candidateRecall.value).toBe(0);
    observation.probes[2]!.truncated = true;
    expect(diagnose(item, "context", observation).issues[0]!.reason).toBe("unobserved_beyond_probe");
    const wrong = structuredClone(row.observations[0]!); wrong.selected = [row.fixture[0]!];
    expect(() => assertObservation(item, "context", row.fixture, wrong)).toThrow("query candidates");
  });
  it("keeps replay leaks separate from actual output and does not call ineligible nonmatches a proven filter", async () => {
    const item = load().find(item => item.id === "dev-confirmation-gate")!;
    const report = await evaluateDiagnostics(resolve("."), [item], ["inmemory"]);
    const row = report.rows.find(row => row.endpoint === "context")!;
    const observation = structuredClone(row.observations[0]!);
    const pending = row.fixture.find(record => record.label === "pending")!;
    observation.probes[2]!.hits.push({ memory: pending, rank: 2, rankMeaning: "match_order", score: { model: "none", value: null, direction: "not_applicable" }, matchType: "literal_substring", matchReason: "literal_contains" });
    const result = diagnose(item, "context", observation);
    expect(result.security.userConfirmed!.numerator).toBe(0);
    expect(result.candidateSecurity.userConfirmed!.numerator).toBe(0);
    expect(result.replaySecurity.userConfirmed!.numerator).toBe(1);
    expect(result.passed).toBe(false);
  });
});
