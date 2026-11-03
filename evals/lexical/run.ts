import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadDiagnosticCases } from "../diagnostics/dataset.js";
import { writeDiagnosticReports } from "../diagnostics/reports.js";
import { loadLexicalCases } from "./dataset.js";
import { evaluateAblation } from "./evaluator.js";
import { evaluateLexicalPerformance } from "./performance.js";

try {
  const { values } = parseArgs({ options: { "report-dir": { type: "string" }, source: { type: "string", default: "." } }, strict: true });
  if (!values["report-dir"]) throw new Error("Explicit new report directory required");
  const directory = resolve(values["report-dir"]), source = resolve(values.source!);
  mkdirSync(directory, { mode: 0o700 });
  const write = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const oldCases = loadDiagnosticCases("evals/datasets/core-baseline-v1.json", "evals/datasets/retrieval-diagnostics-v1.json"), newCases = loadLexicalCases();
  const old = await evaluateAblation(source, oldCases);
  writeDiagnosticReports(join(directory, "old-off"), old.off, oldCases); writeDiagnosticReports(join(directory, "old-on"), old.on, oldCases);
  write("old-ablation.json", old.comparison);
  const added = await evaluateAblation(source, newCases);
  writeDiagnosticReports(join(directory, "new-off"), added.off, newCases); writeDiagnosticReports(join(directory, "new-on"), added.on, newCases);
  write("new-ablation.json", added.comparison);
  const performance = await evaluateLexicalPerformance(source); write("performance.json", performance);
  const engineeringPassed = old.comparison.integrityAndSafetyPassed && added.comparison.integrityAndSafetyPassed;
  const defaultEnableAccepted = engineeringPassed && !old.comparison.regressions.length && !added.comparison.regressions.length
    && old.on.gate.passed && added.on.gate.passed && performance.gate.passed;
  const decision = { engineeringPassed, defaultEnableAccepted, activeDefault: "off", oldRegressions: old.comparison.regressions,
    newRegressions: added.comparison.regressions, performanceGate: performance.gate,
    interpretation: "Exit 0 validates the engineering experiment; it does not turn ON negative quality failures into passes. Default remains OFF. All raw ON failures are retained." };
  write("decision.json", decision);
  writeFileSync(join(directory, "README.md"), "# 6C开关消融\n\n原38题、新16题、性能与默认决策分开。各off/on目录保留逐层报告；ON门禁失败不代表报告无效，也不应隐藏。新题为已暴露虚构验收，不是盲测。\n\n- [决策](./decision.json)\n- [原题对照](./old-ablation.json)\n- [新题分组对照](./new-ablation.json)\n- [性能原始样本](./performance.json)\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify(decision) + "\n");
  if (!engineeringPassed) process.exitCode = 1;
} catch {
  process.stderr.write("Lexical acceptance failed: inspect fixed synthetic fixtures and report integrity; no driver payload is logged.\n"); process.exitCode = 1;
}
