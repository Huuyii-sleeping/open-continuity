import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { BACKENDS, hash, sourceEvidence } from "../baseline/evaluator.js";
import { candidateRuntime } from "../candidates/runtime.js";
import { latencySummary, ratio, type Ratio } from "../baseline/metrics.js";
import { ANSWER_CASES } from "./dataset.js";
import { packingAblation } from "./packing.js";
import { answerCapacity } from "./capacity.js";

interface Observation {
  selected: string[]; actualStatus: string; packedCount: number; sufficiency: string;
  citationValid: boolean; faithful: boolean; unexpected: string[]; coverageValid: boolean; decisionValid: boolean;
  leaked: Record<string, Ratio>; citationIds: string[];
}

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, "report-dir": { type: "string" }, capacity: { type: "boolean", default: false } }, strict: true });
  if (!values["report-dir"]) throw new Error("New explicit report directory required");
  const source = resolve(values.source!), root = resolve(values["report-dir"]), evidence = sourceEvidence(source);
  const module = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/memory-service.js");
  const { ContextPackBuilder } = await import(pathToFileURL(join(source, "src/core/context-pack.ts")).href) as typeof import("../../src/core/context-pack.js");
  const { RetrievalPipeline } = await import(pathToFileURL(join(source, "src/core/retrieval.ts")).href) as typeof import("../../src/core/retrieval.js");
  const { InMemoryStore } = await import(pathToFileURL(join(source, "src/core/memory-store.ts")).href) as typeof import("../../src/core/memory-store.js");
  const packing = packingAblation(mode => new ContextPackBuilder(new RetrievalPipeline(new InMemoryStore()), { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, queryPacking: mode }));
  const rows = [];
  for (const backend of BACKENDS) for (const scenario of ANSWER_CASES) for (let round = 1; round <= 3; round++) {
    const rt = await candidateRuntime(source, backend);
    try {
      const service = new module.MemoryService(rt.store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, requireUserConfirmed: true });
      const labels = new Map<string, string>(), originals = new Map<string, unknown>();
      for (const spec of scenario.records) {
        const receipt = await service.remember(spec.input); labels.set(receipt.current.id, spec.label); originals.set(spec.label, receipt.current.value);
      }
      await service.query(scenario.query);
      const selections: string[][] = [], samples: number[] = [], observations: Observation[] = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const started = performance.now(), result = await service.query(scenario.query); samples.push(performance.now() - started);
        const answer = result.answer;
        const selected = answer?.citations.map(citation => labels.get(citation.memoryId) ?? "unknown") ?? [];
        selections.push(selected);
        const pack = result.contextPack.items;
        const citationValid = answer !== undefined && answer.citations.length === answer.statements.length && answer.citations.length === pack.length
          && answer.citations.every((citation, index) => citation.memoryId === pack[index].memoryId && citation.sourceEventId === pack[index].sourceEventId
            && citation.version === pack[index].version && answer.statements[index].citationId === citation.id
            && citation.contentHash === hash(JSON.stringify({ key: pack[index].key, value: pack[index].value, kind: pack[index].kind, scope: pack[index].scope,
              taskId: pack[index].taskId, fact: pack[index].fact, memoryId: pack[index].memoryId, sourceEventId: pack[index].sourceEventId,
              version: pack[index].version, sourceAgentId: pack[index].sourceAgentId })));
        const faithful = answer !== undefined && answer.statements.every((statement, index) => isDeepStrictEqual(statement.value, originals.get(selected[index])) && statement.key === selected[index]);
        const unexpected = selected.filter(label => !scenario.allowed.includes(label));
        const coverageValid = answer !== undefined && (scenario.uncoveredQueries === undefined || answer.coverage.totalQueries - answer.coverage.coveredQueries === scenario.uncoveredQueries);
        const decisionValid = answer?.status === scenario.status && answer.statements.length === scenario.statementCount
          && (scenario.limitation === undefined || answer.limitations.includes(scenario.limitation));
        const leaked = Object.fromEntries(Object.entries(scenario.boundaries ?? {}).map(([name, forbidden]) => [name, ratio(forbidden.filter(label => {
          const id = [...labels].find(([, value]) => value === label)?.[0]; return id !== undefined && JSON.stringify(result).includes(id);
        }).length, forbidden.length)]));
        observations.push({ selected, actualStatus: answer?.status ?? "not_implemented", packedCount: pack.length,
          sufficiency: result.sufficiency.status, citationValid, faithful, unexpected, coverageValid, decisionValid, leaked,
          citationIds: answer?.citations.map(citation => citation.id) ?? [] });
      }
      const stable = selections.every(list => isDeepStrictEqual(list, selections[0])) && observations.every(item => isDeepStrictEqual(item.citationIds, observations[0].citationIds));
      rows.push({ backend, id: scenario.id, round, rationale: scenario.rationale, expectedStatus: scenario.status, observations, stable,
        latency: latencySummary(samples), passed: stable && observations.every(item => item.citationValid && item.faithful && item.coverageValid && item.decisionValid && item.unexpected.length === 0 && Object.values(item.leaked).every(value => value.numerator === 0)) });
    } finally { await rt.close(); }
  }
  if (!isDeepStrictEqual(evidence, sourceEvidence(source))) throw new Error("Source changed during evaluation");
  const metadata = { version: "open-continuity-answer-contract-v1", evidence, node: process.version, distinctCases: ANSWER_CASES.length,
    evaluatorHash: hash(["evals/answer/dataset.ts", "evals/answer/run.ts", "evals/answer/packing.ts", "evals/answer/capacity.ts", "evals/baseline/metrics.ts", "evals/candidates/runtime.ts"].map(path => hash(readFileSync(path))).join("\n")),
    note: "Synthetic verbatim memory projection contract, not semantic model-answer quality or objective truth. Three rebuilds and five repeats are technical repetitions. Native PG and workspace/authentication/held-out quality are not covered." };
  const gate = { passed: rows.every(row => row.passed) && packing.filter(row => row.mode === "query_coverage").every(row => row.passed), failures: rows.filter(row => !row.passed).map(row => `${row.backend}/${row.id}@${row.round}`) };
  mkdirSync(root, { mode: 0o700 });
  const reports = {
    "raw-report.json": { ...metadata, gate, rows },
    "packing-ablation.json": { ...metadata, rows: packing, note: "Identical fictional candidate sets. Rank-only failures retained; greedy coverage is not globally optimal, and match coverage is not semantic answerability." },
    "quality.json": { ...metadata, gate, rows: rows.map(({ latency: _latency, ...row }) => row) },
    "citations.json": { ...metadata, rows: rows.map(row => ({ backend: row.backend, id: row.id, round: row.round, observations: row.observations.map(({ citationValid, faithful, citationIds }) => ({ citationValid, faithful, citationIds })) })), note: "Faithfulness means exact stored-value preservation only; semantic answer faithfulness is unimplemented." },
    "security.json": { ...metadata, rows: rows.filter(row => row.id === "scope-confirmation").map(row => ({ backend: row.backend, round: row.round, observations: row.observations.map(item => item.leaked) })) },
    "stability.json": { ...metadata, rows: rows.map(({ backend, id, round, stable }) => ({ backend, id, round, stable })) },
    "latency.json": { ...metadata, rows: rows.map(({ backend, id, round, latency }) => ({ backend, id, round, latency })), note: "Small fixtures: warmup 1, samples 5. Not a capacity/SLO test." },
  };
  for (const [name, report] of Object.entries(reports)) writeFileSync(join(root, name), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  if (values.capacity) {
    const capacity = await answerCapacity(source);
    writeFileSync(join(root, "capacity.json"), JSON.stringify({ ...metadata, ...capacity }, null, 2), { flag: "wx", mode: 0o600 });
    if (!capacity.valid) process.exitCode = 1;
    if (!isDeepStrictEqual(evidence, sourceEvidence(source))) throw new Error("Source changed during capacity evaluation");
  }
  process.stdout.write(JSON.stringify({ gate, rows: rows.length, cases: ANSWER_CASES.length, sourceHash: evidence.sourceHash }) + "\n");
  if (!gate.passed) process.exitCode = 1;
} catch { process.stderr.write("Answer contract evaluation failed; inspect explicit fixture contract.\n"); process.exitCode = 1; }
