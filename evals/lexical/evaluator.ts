import { isDeepStrictEqual } from "node:util";
import { diagnose, valueHash } from "../diagnostics/analysis.js";
import { type DiagnosticCase, ENDPOINTS } from "../diagnostics/dataset.js";
import { evaluateDiagnostics, validateReport, type DiagnosticReport } from "../diagnostics/evaluator.js";

/** Only the explicitly changed policy may differ. Labels, budgets, source and report integrity cannot. */
export function compareAblation(off: DiagnosticReport, on: DiagnosticReport, cases: DiagnosticCase[]) {
  validateReport(off, cases); validateReport(on, cases);
  const { lexicalFallback: left, ...a } = off.comparable, { lexicalFallback: right, ...b } = on.comparable;
  if (left !== "off" || right !== "latin_one_edit" || !isDeepStrictEqual(a, b) || !isDeepStrictEqual(off.evidence, on.evidence)) throw new Error("Incomparable lexical ablation");
  const comparisons = on.rows.map(row => {
    const item = cases.find(item => item.id === row.id)!;
    const previous = off.rows.find(old => old.id === row.id && old.endpoint === row.endpoint && old.backend === row.backend && old.round === row.round)!;
    const before = diagnose(item, row.endpoint, previous.observations[0]!), after = diagnose(item, row.endpoint, row.observations[0]!);
    const regressed = (before.passed && !after.passed) || after.score.falseSelection.numerator > before.score.falseSelection.numerator
      || after.score.miss.numerator > before.score.miss.numerator || [1, 3, 5].some(k => {
        const a = before.score.atK[String(k)]!, b = after.score.atK[String(k)]!;
        return (b.recall.value ?? 0) < (a.recall.value ?? 0) || (b.reciprocalRank ?? 0) < (a.reciprocalRank ?? 0) || (b.ndcg ?? 0) < (a.ndcg ?? 0);
      });
    return { id: row.id, endpoint: row.endpoint, backend: row.backend, round: row.round, category: item.category,
      off: { passed: before.passed, labels: previous.observations[0]!.selected.map(memory => memory.label), score: before.score },
      on: { passed: after.passed, labels: row.observations[0]!.selected.map(memory => memory.label), score: after.score }, regressed };
  });
  const groups = [...new Set(cases.map(item => item.category))].flatMap(category => ENDPOINTS.map(endpoint => {
    const rows = comparisons.filter(row => row.category === category && row.endpoint === endpoint);
    return { category, endpoint, distinctCases: new Set(rows.map(row => row.id)).size,
      improvedCases: [...new Set(rows.filter(row => !row.off.passed && row.on.passed).map(row => row.id))],
      regressedCases: [...new Set(rows.filter(row => row.regressed).map(row => row.id))] };
  }));
  const sound = (report: DiagnosticReport) => !report.gate.errors.length && !report.gate.leaks.length && !report.gate.semanticValueFailures.length
    && !report.gate.policyContradictions.length && report.stable.every(row => row.stable) && report.rebuild.every(row => row.stable);
  return { integrityAndSafetyPassed: sound(off) && sound(on), offQualityGate: off.gate, onQualityGate: on.gate,
    regressions: [...new Set(comparisons.filter(row => row.regressed).map(row => `${row.backend}/${row.endpoint}/${row.id}`))], groups, comparisons };
}
export async function evaluateAblation(source: string, cases: DiagnosticCase[]) {
  const off = await evaluateDiagnostics(source, cases, ["sqlite"], "off");
  const on = await evaluateDiagnostics(source, cases, ["sqlite"], "latin_one_edit");
  return { off, on, comparison: compareAblation(off, on, cases), datasetHash: valueHash(cases) };
}
