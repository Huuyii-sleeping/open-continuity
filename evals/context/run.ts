import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { hash, sourceEvidence } from "../baseline/evaluator.js";
import { mean, scoreRanking, latencySummary } from "../baseline/metrics.js";
import { actor, CONTEXT_CASES } from "./dataset.js";
import type { ContextSelectionMode } from "../../src/shared/types.js";

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, "report-dir": { type: "string" } }, strict: true });
  if (!values["report-dir"]) throw new Error("Explicit new report directory required");
  const source = resolve(values.source!), directory = resolve(values["report-dir"]);
  const evidence = sourceEvidence(source);
  const { ContextPackBuilder } = await import(pathToFileURL(join(source, "src/core/context-pack.ts")).href) as typeof import("../../src/core/context-pack.js");
  const { RetrievalPipeline } = await import(pathToFileURL(join(source, "src/core/retrieval.ts")).href) as typeof import("../../src/core/retrieval.js");
  const { InMemoryStore } = await import(pathToFileURL(join(source, "src/core/memory-store.ts")).href) as typeof import("../../src/core/memory-store.js");
  const modes: ContextSelectionMode[] = ["relevance_first", "relevance_only", "legacy_weighted"];
  const rows = modes.flatMap(mode => CONTEXT_CASES.map(scenario => {
    const candidates = structuredClone(scenario.candidates), unchanged = structuredClone(candidates);
    const pack = new ContextPackBuilder(new RetrievalPipeline(new InMemoryStore()), { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 1, selectionMode: mode });
    const input = { ...actor, query: "fictional-evidence", purpose: scenario.purpose, includePrivate: false };
    pack.buildFromMemories(input, candidates); // Independent warmup, not a capacity benchmark.
    const selections: string[][] = [], samples: number[] = [], receipts = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now(), result = pack.buildFromMemories(input, candidates);
      samples.push(performance.now() - started); selections.push(result.items.map(item => item.memoryId)); receipts.push(result.selection ?? null);
    }
    const selected = selections[0], ranking = scoreRanking(selected, { relevant: scenario.expected, forbidden: scenario.forbidden }, [1]);
    return { mode, id: scenario.id, rationale: scenario.rationale, judgment: { relevant: scenario.expected, forbidden: scenario.forbidden },
      selected, selections, ranking, receipts, stable: selections.every(list => isDeepStrictEqual(list, selected)),
      passed: isDeepStrictEqual(selected, scenario.expected), inputUnchanged: isDeepStrictEqual(unchanged, candidates), latency: latencySummary(samples) };
  }));
  if (!isDeepStrictEqual(evidence, sourceEvidence(source))) throw new Error("Source changed during evaluation");
  const metadata = { format: "open-continuity-context-mechanism-v1", evidence, node: process.version,
    evaluatorHash: hash(["evals/context/dataset.ts", "evals/context/run.ts", "evals/baseline/metrics.ts"].map(path => hash(readFileSync(path))).join("\n")),
    note: "Eight synthetic evidence matrices; five technical repeats are not independent problems. No semantic relevance, workspace, authentication, native PG quality, faithfulness or performance SLO claims." };
  const defaultRows = rows.filter(row => row.mode === "relevance_first");
  const gate = { passed: defaultRows.every(row => row.passed) && rows.every(row => row.stable && row.inputUnchanged), failures: defaultRows.filter(row => !row.passed).map(row => row.id) };
  const summaries = modes.map(mode => { const group = rows.filter(row => row.mode === mode); return { mode, passedCases: group.filter(row => row.passed).length, cases: group.length,
    recallAt1: mean(group.map(row => row.ranking.atK["1"].recall.value)), mrrAt1: mean(group.map(row => row.ranking.atK["1"].reciprocalRank)),
    falseSelection: group.reduce((sum, row) => sum + row.ranking.falseSelection.numerator, 0), selected: group.reduce((sum, row) => sum + row.selected.length, 0) }; });
  mkdirSync(directory, { mode: 0o700 });
  const reports = {
    "quality.json": { ...metadata, gate, summaries, rows: defaultRows },
    "ablation.json": { ...metadata, note: "All modes use identical candidates/judgments. Legacy failures and purpose-tie ablation failure remain visible; they are mechanism tradeoffs, not historical online defect counts.", rows },
    "stability.json": { ...metadata, rows: rows.map(({ mode, id, selections, stable, inputUnchanged }) => ({ mode, id, selections, stable, inputUnchanged })) },
    "latency.json": { ...metadata, rows: rows.map(({ mode, id, latency }) => ({ mode, id, latency })), note: "Small evidence matrices only; benchmark:lite separately measures synthetic SQLite workload." },
  };
  for (const [name, report] of Object.entries(reports)) writeFileSync(join(directory, name), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  process.stdout.write(JSON.stringify({ gate, summaries, sourceHash: evidence.sourceHash }) + "\n");
  if (!gate.passed) process.exitCode = 1;
} catch { process.stderr.write("Context mechanism evaluation failed; inspect the explicit fixture and report contract.\n"); process.exitCode = 1; }
