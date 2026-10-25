import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { compareReports, parseReport } from "./compare.js";
import { BACKENDS, evaluateBaseline, type Backend } from "./evaluator.js";
import { measureCapacity } from "./performance.js";
import { writeSplitReports } from "./reports.js";

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, dataset: { type: "string", default: "evals/datasets/core-baseline-v1.json" }, backends: { type: "string", default: BACKENDS.join(",") }, compare: { type: "string" }, output: { type: "string" }, "report-dir": { type: "string" }, capacity: { type: "boolean", default: false } }, strict: true });
  if (values.output && values["report-dir"]) throw new Error("Choose --output or --report-dir");
  const backends = values.backends!.split(",");
  if (backends.some((name) => !BACKENDS.includes(name as Backend))) throw new Error("Unknown backend");
  // Validate comparison input before running expensive measurements.
  const previous = values.compare ? parseReport(JSON.parse(readFileSync(resolve(values.compare), "utf8"))) : null;
  const result = await evaluateBaseline(resolve(values.source!), resolve(values.dataset!), backends as Backend[]);
  const comparison = previous ? compareReports(previous, result) : null;
  const capacity = values.capacity ? await measureCapacity(resolve(values.source!)) : null;
  if (values["report-dir"]) {
    writeSplitReports(resolve(values["report-dir"]), result, comparison, capacity);
    process.stdout.write(`Split reports: ${resolve(values["report-dir"], "README.md")}\nQuality/safety/stability gate: ${result.gate.passed ? "PASS" : "FAIL"}\nComparison: ${comparison ? (comparison.passed ? "PASS" : "FAIL") : "NOT RUN"}\nCapacity response validity: ${capacity ? (capacity.validityPassed ? "PASS" : "FAIL") : "NOT RUN"}\n`);
  } else if (values.output) {
    // Reports are generated artifacts. Refuse to overwrite an existing baseline.
    writeFileSync(resolve(values.output), JSON.stringify({ ...result, comparison, capacity }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const compactSummary = Object.fromEntries(Object.entries(result.summary).map(([name, summary]) => {
      const { samplesMs: _samples, ...latency } = summary.latency;
      return [name, { ...summary, latency }];
    }));
    process.stdout.write(JSON.stringify({ evidence: result.evidence, summary: compactSummary, gate: result.gate, comparison: comparison ? { passed: comparison.passed, regressions: comparison.regressions } : null, capacity: capacity ? { validityPassed: capacity.validityPassed, runs: capacity.results.length } : null }, null, 2) + "\n");
  } else process.stdout.write(JSON.stringify({ ...result, comparison, capacity }, null, 2) + "\n");
  if (!result.gate.passed || comparison?.passed === false || capacity?.validityPassed === false) process.exitCode = 1;
} catch (error) {
  // Do not print driver errors or user-supplied paths from exception payloads.
  process.stderr.write(`Core baseline failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}\n`);
  process.exitCode = 1;
}
