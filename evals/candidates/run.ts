import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKENDS, type Backend } from "../baseline/evaluator.js";
import { evaluateCandidates, writeCandidateReports } from "./evaluator.js";
import { measureCandidateCapacity } from "./capacity.js";
import { compareCandidateCapacity, compareCandidateReports, validateCandidateCapacity, validateCandidateReport } from "./compare.js";

try {
  const { values } = parseArgs({ options: { source: { type: "string",default: "." },mode: { type: "string",default: "native" },"report-dir": { type: "string" },backends: { type: "string",default: BACKENDS.join(",") },dataset: { type: "string",default: "evals/datasets/candidate-v1.json" },capacity: { type: "boolean",default: false },compare: { type: "string" } },strict: true });
  if (!values["report-dir"] || !["native","legacy"].includes(values.mode!)) throw new Error("Specify report-dir and native/legacy mode");
  const backends = values.backends!.split(",") as Backend[];
  if (backends.some(b => !BACKENDS.includes(b)) || new Set(backends).size !== backends.length) throw new Error("Specify unique known backends");
  const previous = values.compare ? validateCandidateReport(JSON.parse(readFileSync(resolve(values.compare),"utf8"))) : null;
  const previousCapacity = values.compare && values.capacity ? validateCandidateCapacity(JSON.parse(readFileSync(join(dirname(resolve(values.compare)),"capacity.json"),"utf8"))) : null;
  if (previous && previousCapacity && (previous.mode !== previousCapacity.mode || previous.comparable.harnessHash !== previousCapacity.harnessHash || previous.evidence.sourceHash !== previousCapacity.evidence.sourceHash)) throw new Error("Capacity and quality reference do not match");
  const report = await evaluateCandidates(resolve(values.source!),resolve("evals/datasets/core-baseline-v1.json"),resolve(values.dataset!),values.mode as "native"|"legacy",backends);
  const comparison = previous ? compareCandidateReports(previous,report) : null;
  writeCandidateReports(resolve(values["report-dir"]),report);
  if (comparison) writeFileSync(join(resolve(values["report-dir"]),"comparison.json"),JSON.stringify(comparison,null,2),{ flag: "wx",mode: 0o600 });
  const capacity = values.capacity ? await measureCandidateCapacity(resolve(values.source!),values.mode as "native"|"legacy") : null;
  if (capacity) writeFileSync(join(resolve(values["report-dir"]),"capacity.json"),JSON.stringify(capacity,null,2),{ flag: "wx",mode: 0o600 });
  const capacityComparison = previousCapacity && capacity ? compareCandidateCapacity(previousCapacity,capacity) : null;
  if (capacityComparison) writeFileSync(join(resolve(values["report-dir"]),"capacity-comparison.json"),JSON.stringify(capacityComparison,null,2),{ flag: "wx",mode: 0o600 });
  appendFileSync(join(resolve(values["report-dir"]),"README.md"),"\n## Comparison and capacity\n"+
    (comparison ? `- [Per-case comparison](comparison.json): ${comparison.passed ? "PASS" : "FAIL"}; ${comparison.regressions.length} regression signals.\n` : "- Per-case comparison: NOT RUN.\n")+
    (capacity ? "- [Raw capacity samples](capacity.json); response validity only, no latency gate.\n" : "- Capacity: NOT RUN.\n")+
    (capacityComparison ? "- [Capacity comparison](capacity-comparison.json); all runs retained.\n" : "- Capacity comparison: NOT RUN.\n"));
  process.stdout.write(`Independent candidate reports written. Required/safety/stability: ${report.gate.passed ? "PASS" : "FAIL"}\n`);
  if (capacity) process.stdout.write(`Candidate capacity response validity: ${capacity.validityPassed ? "PASS" : "FAIL"}; no latency SLO.\n`);
  if (comparison) process.stdout.write(`Per-case comparison: ${comparison.passed ? "PASS" : "FAIL"}; regressions ${comparison.regressions.length}.\n`);
  if (!report.gate.passed || comparison?.passed === false || capacity?.validityPassed === false) process.exitCode = 1;
} catch { process.stderr.write("Candidate evaluation failed; no driver/request details logged.\n");process.exitCode = 1; }
