import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { memoryScopeSchema, sensitivitySchema } from "../../src/shared/types.js";
import { BACKENDS, type Backend } from "../baseline/evaluator.js";
import { candidateRuntime } from "../candidates/runtime.js";
import { latencySummary, scoreRanking } from "../baseline/metrics.js";
import { measureFactCapacity } from "./capacity.js";

const factSpec = z.object({ group: z.string().min(1).max(128), validFrom: z.iso.datetime({ offset: true }).optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(), replaceLabels: z.array(z.string()).default([]) }).strict();
const datasetSchema = z.object({ version: z.literal("fact-v1"), note: z.string(), cases: z.array(z.object({
  id: z.string(), query: z.string(), memories: z.array(z.object({ label: z.string(), value: z.unknown(),
    fact: factSpec.optional(), sensitivity: sensitivitySchema.optional(), scope: memoryScopeSchema.optional(),
    agentId: z.string().optional(), userId: z.string().optional(), taskId: z.string().optional(), userConfirmed: z.boolean().optional() })),
  relevant: z.array(z.string()), forbidden: z.array(z.string()), contextForbidden: z.array(z.string()).optional(), recallExtraRelevant: z.array(z.string()).optional(),
  expectedStatus: z.string().optional(), expectedOmission: z.string().optional(), boundaryLabels: z.record(z.string(), z.array(z.string())).optional(),
})) });
function files(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []).sort(); }
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
interface FactRow {
  backend: Backend; id: string; round: number; endpoint: "recall" | "context"; supportsDeclarations: boolean | null;
  judgment: { relevant: string[]; forbidden: string[] }; selected: string[]; selections: string[][]; statuses: string[][]; omissions: string[][];
  ranking: ReturnType<typeof scoreRanking>; receiptValid: boolean; stable: boolean;
  leakage: Record<string, { numerator: number; denominator: number }>; latency: ReturnType<typeof latencySummary>; samples: number[]; passed: boolean;
}

try {
  const { values } = parseArgs({ options: { source: { type: "string", default: "." }, "report-dir": { type: "string" }, compare: { type: "string" }, capacity: { type: "boolean", default: false } }, strict: true });
  if (!values["report-dir"]) throw new Error("A new explicit report directory is required");
  const directory = resolve(values["report-dir"]), source = resolve(values.source!);
  mkdirSync(directory, { recursive: false });
  const datasetText = readFileSync(resolve("evals/datasets/fact-v1.json"), "utf8"), dataset = datasetSchema.parse(JSON.parse(datasetText));
  const datasetHash = fingerprint(datasetText), evaluatorHash = fingerprint([...files(resolve("evals/facts")), resolve("evals/candidates/runtime.ts"), resolve("evals/baseline/metrics.ts")]
    .sort().map(file => `${relative(resolve("."), file)}:${fingerprint(readFileSync(file, "utf8"))}`).join("\n"));
  const sourceHash = fingerprint(files(join(source, "src")).map(file => `${relative(source, file)}:${fingerprint(readFileSync(file, "utf8"))}`).join("\n"));
  const actor = { userId: "fictional-fact-eval-user", agentId: "fictional-fact-eval-reader" };
  const rows: FactRow[] = [];
  for (const backend of BACKENDS) for (const scenario of dataset.cases) for (let round = 1; round <= 3; round++) {
    const rt = await candidateRuntime(source, backend);
    try {
      const labels = new Map<string, string>(), memories = new Map<string, Awaited<ReturnType<typeof rt.service.remember>>>();
      let supportsDeclarations: boolean | null = null;
      for (const spec of scenario.memories) {
        const { replaceLabels = [], ...fact } = spec.fact ?? {};
        const supersedes = replaceLabels.map(label => {
          const target = memories.get(label)?.current;
          if (!target) throw new Error("Replacement labels must refer to earlier fixture writes");
          return { memoryId: target.id, sourceEventId: target.sourceEventId, version: target.version };
        });
        const saved = await rt.service.remember({ ...actor, userId: spec.userId ?? actor.userId, agentId: spec.agentId ?? actor.agentId,
          key: `fictional-${spec.label}`, value: spec.value, kind: "decision", scope: spec.scope, taskId: spec.taskId,
          sensitivity: spec.sensitivity, userConfirmed: spec.userConfirmed ?? true, expectedVersion: 0,
          idempotencyKey: `fictional-${spec.label}`, ...(spec.fact ? { fact: { ...fact, group: spec.fact.group, supersedes } } : {}) });
        memories.set(spec.label, saved); labels.set(saved.current.id, spec.label);
        if (spec.fact) supportsDeclarations = (supportsDeclarations ?? true) && saved.current.fact?.group === spec.fact.group;
      }
      for (const endpoint of ["recall", "context"] as const) {
        const call = () => endpoint === "recall" ? rt.service.recall({ ...actor, query: scenario.query, limit: 5 })
          : new (rt.service.constructor as typeof import("../../src/core/memory-service.js").MemoryService)(rt.store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, requireUserConfirmed: true }).context({ ...actor, query: scenario.query });
        await call(); // One warmup; five samples are descriptive, not production latency evidence.
        const samples: number[] = [], selections: string[][] = [], statuses: string[][] = [], omissions: string[][] = [];
        let exposed = "";
        for (let repeat = 0; repeat < 5; repeat++) {
          const started = performance.now(), result = await call(); samples.push(performance.now() - started);
          const selected = "memories" in result ? result.memories.map(memory => ({ id: memory.id, assessment: memory.retrieval?.factAssessment }))
            : result.items.map(item => ({ id: item.memoryId, assessment: item.retrieval?.factAssessment }));
          selections.push(selected.map(item => labels.get(item.id) ?? "unknown"));
          statuses.push(selected.map(item => item.assessment?.status ?? "missing"));
          omissions.push(result.retrieval?.factReview?.omitted.map(item => item.assessment.status) ?? []);
          exposed = JSON.stringify(result);
        }
        const selected = selections[0]!;
        const relevant = [...scenario.relevant, ...(endpoint === "recall" ? scenario.recallExtraRelevant ?? [] : [])];
        const forbidden = endpoint === "context" ? scenario.contextForbidden ?? scenario.forbidden : scenario.forbidden;
        const ranking = scoreRanking(selected, { relevant, forbidden }, [1, 3, 5]);
        const receiptValid = scenario.expectedOmission ? omissions.every(list => list.includes(scenario.expectedOmission!))
          : scenario.expectedStatus ? statuses.every((list, repeat) => list.every((status, index) => status === scenario.expectedStatus
            || (scenario.expectedStatus === "unannotated" && status === "missing")
            || (!scenario.memories.find(spec => spec.label === selections[repeat]![index])?.fact && ["unannotated", "missing"].includes(status)))) : true;
        const stable = selections.every(list => JSON.stringify(list) === JSON.stringify(selected));
        const leakage = Object.fromEntries(Object.entries(scenario.boundaryLabels ?? {}).map(([boundary, targets]) => [boundary,
          { numerator: boundary === "userConfirmed" && endpoint === "recall" ? 0 : targets.filter(label => exposed.includes(memories.get(label)!.current.id)).length,
            denominator: boundary === "userConfirmed" && endpoint === "recall" ? 0 : targets.length }]));
        rows.push({ backend, id: scenario.id, round, endpoint, supportsDeclarations, judgment: { relevant, forbidden }, selected, selections, statuses, omissions,
          ranking, receiptValid, stable, leakage, latency: latencySummary(samples), samples,
          passed: ranking.miss.numerator === 0 && ranking.falseSelection.numerator === 0 && receiptValid && stable && Object.values(leakage).every(ratio => ratio.numerator === 0) });
      }
    } finally { await rt.close(); }
  }
  const metadata = { version: "open-continuity-facts-v1", datasetHash, evaluatorHash, sourceHash, lockHash: fingerprint(readFileSync(resolve("package-lock.json"), "utf8")), node: process.version, rounds: 3, repeats: 5 };
  const raw = { ...metadata, rows };
  const passed = rows.every(row => row.passed);
  const reports: Record<string, unknown> = {
    "raw-report": raw,
    quality: { ...metadata, passed, note: "Explicit declaration engineering fixtures, not semantic accuracy or held-out quality. Original quality-v1/core-baseline-v1 unchanged.", rows: rows.map(({ samples: _samples, latency: _latency, leakage: _leakage, ...row }) => row) },
    security: { ...metadata, rows: rows.filter(row => Object.keys(row.leakage).length).map(row => ({ backend: row.backend, id: row.id, round: row.round, endpoint: row.endpoint, leakage: row.leakage })), note: "Zero denominators are uncovered. Workspace and entry authentication are outside this fixture." },
    stability: { ...metadata, rows: rows.map(row => ({ backend: row.backend, id: row.id, round: row.round, endpoint: row.endpoint, selected: row.selected, stable: row.stable })),
      rebuild: BACKENDS.flatMap(backend => dataset.cases.flatMap(scenario => ["recall", "context"].map(endpoint => { const group = rows.filter(row => row.backend === backend && row.id === scenario.id && row.endpoint === endpoint); return { backend, id: scenario.id, endpoint, stable: group.every(row => JSON.stringify([...row.selected].sort()) === JSON.stringify([...group[0]!.selected].sort())) }; }))), note: "Rebuild equality compares membership; same-value IDs with equal timestamps can swap. Order repeatability is separately checked within each live database." },
    latency: { ...metadata, rows: rows.map(row => ({ backend: row.backend, id: row.id, round: row.round, endpoint: row.endpoint, latency: row.latency, samples: row.samples })), note: "Small fixtures, five samples; descriptive only, not a capacity workload or latency SLO." },
  };
  if (values.compare) {
    const previous = JSON.parse(readFileSync(resolve(values.compare), "utf8")) as typeof raw;
    if (previous.version !== metadata.version || previous.datasetHash !== datasetHash || previous.evaluatorHash !== evaluatorHash || previous.lockHash !== metadata.lockHash || previous.node !== process.version || previous.rows.length !== rows.length) throw new Error("Incomparable fact reports");
    const key = (row: typeof rows[number]) => JSON.stringify([row.backend, row.id, row.round, row.endpoint]);
    const index = new Map(previous.rows.map(row => [key(row), row]));
    if (index.size !== rows.length || rows.some(row => !index.has(key(row)))) throw new Error("Incomplete fact report grid");
    for (const row of rows) {
      const old = index.get(key(row))!;
      if (JSON.stringify(old.judgment) !== JSON.stringify(row.judgment) || old.selections.length !== 5 || old.statuses.length !== 5 || old.omissions.length !== 5
        || old.selections.some(list => JSON.stringify(list) !== JSON.stringify(old.selected))
        || JSON.stringify(scoreRanking(old.selected, old.judgment, [1, 3, 5])) !== JSON.stringify(old.ranking)) throw new Error("Invalid fact reference observations or judgments");
    }
    reports.comparison = { ...metadata, referenceSourceHash: previous.sourceHash, changes: rows.filter(row => JSON.stringify(row.selected) !== JSON.stringify(index.get(key(row))!.selected) || row.receiptValid !== index.get(key(row))!.receiptValid).map(row => ({ backend: row.backend, id: row.id, round: row.round, endpoint: row.endpoint, before: index.get(key(row))!.selected, after: row.selected,
      previousDeclarationSupport: index.get(key(row))!.supportsDeclarations, previousReceiptValid: index.get(key(row))!.receiptValid, currentReceiptValid: row.receiptValid })), note: "Old-source declaration absence is new-contract coverage, not a historical production defect count. Original public baseline is compared separately." };
  }
  if (values.capacity) reports.capacity = { ...metadata, ...await measureFactCapacity(source) };
  for (const [name, report] of Object.entries(reports)) writeFileSync(join(directory, `${name}.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed, rows: rows.length, reportDirectory: directory, datasetHash, sourceHash }) + "\n");
  if (!passed) process.exitCode = 1;
} catch (error) { console.error(`Fact evaluation failed: ${error instanceof Error ? error.message : "unknown"}`); process.exitCode = 1; }
