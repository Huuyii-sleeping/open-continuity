import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKENDS, type Backend } from "../baseline/evaluator.js";
import { loadDiagnosticCases } from "./dataset.js";
import { compareDiagnostics, evaluateDiagnostics, validateReport } from "./evaluator.js";
import { writeDiagnosticReports } from "./reports.js";

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, "report-dir": { type: "string" },
    backends: { type: "string", default: BACKENDS.join(",") }, compare: { type: "string" } }, strict: true });
  if (!values["report-dir"]) throw new Error("Explicit new report directory required");
  const names = values.backends!.split(",");
  if (names.some(name => !BACKENDS.includes(name as Backend))) throw new Error("Unknown backend");
  const cases = loadDiagnosticCases("evals/datasets/core-baseline-v1.json", "evals/datasets/retrieval-diagnostics-v1.json");
  const before = values.compare ? validateReport(JSON.parse(readFileSync(resolve(values.compare), "utf8")), cases) : null;
  const report = await evaluateDiagnostics(resolve(values.source!), cases, names as Backend[]);
  const comparison = before ? compareDiagnostics(before, report, cases) : null;
  writeDiagnosticReports(resolve(values["report-dir"]), report, cases, comparison);
  process.stdout.write(JSON.stringify({ gate: report.gate, distinctCases: cases.length, rebuiltRows: report.rows.length,
    technicalResponses: report.rows.length * report.comparable.settings.repeats, heldout: false, comparison,
    groups: Object.keys(report.summary).length }) + "\n");
  if (!report.gate.passed || comparison?.passed === false) process.exitCode = 1;
} catch {
  process.stderr.write("Diagnostic evaluation failed: inspect the synthetic fixture and report integrity contract. No driver payload is logged.\n");
  process.exitCode = 1;
}
