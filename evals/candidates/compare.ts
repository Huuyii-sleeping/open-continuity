import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { latencySummary, ratio, scoreRanking } from "../baseline/metrics.js";

const strings = z.array(z.string());
const rowSchema = z.object({
  backend: z.enum(["sqlite","inmemory","json","postgres-pg-mem"]),channel: z.enum(["exact","structured","full_text"]),dataset: z.enum(["core-baseline-v1","candidate-v1"]),
  id: z.string().min(1),category: z.string(),status: z.enum(["required","challenge"]),round: z.number().int().positive(),requirementApplies: z.boolean(),limit: z.number().int().min(1).max(100),
  selected: strings,passed: z.boolean(),stable: z.boolean(),valuesMatch: z.boolean(),error: z.boolean(),ranking: z.unknown(),
  judgment: z.object({ relevant: strings,forbidden: strings,ordered: strings.optional(),values: z.array(z.object({ label: z.string(),value: z.unknown(),version: z.number().int().positive().optional() })).optional() }),
  grades: z.record(z.string(),z.number().int().min(1).max(3)),observed: z.array(z.object({ label: z.string(),value: z.unknown(),version: z.number().int().positive() })),repetitions: z.array(strings),
  boundaryLabels: z.object({ user: strings,agent: strings,task: strings,private: strings,userConfirmed: strings }),leakage: z.unknown(),
}).passthrough();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.object({
  format: z.literal("open-continuity-candidates-v2"),mode: z.enum(["legacy","native"]),
  evidence: z.object({ sourceHash: digest,lockHash: digest,commit: z.string().min(1) }).passthrough(),
  comparable: z.object({ harnessHash: digest,coreDatasetHash: digest,candidateDatasetHash: digest,lockHash: digest,node: z.string().min(1),rounds: z.number().int().min(1).max(20),repeats: z.number().int().min(1).max(20),ks: z.array(z.number().int().positive()).min(1),backends: strings.min(1),caseKeys: strings.min(1) }).strict(),
  rows: z.array(rowSchema).min(1),gate: z.object({ passed: z.boolean(),failures: strings,rebuildUnstable: strings }),
}).passthrough();

const key = (row: z.infer<typeof rowSchema>) => JSON.stringify([row.backend,row.dataset,row.id,row.channel,row.round]);
/** Recompute judgments/ratios from observations; summaries and stored pass flags are not authority. */
export function validateCandidateReport(raw: unknown) {
  const report = schema.parse(raw),c = report.comparable;
  for (const list of [c.backends,c.caseKeys,c.ks]) if (new Set<string|number>(list).size !== list.length) throw new Error("Duplicate comparison coverage");
  const expected = new Set(c.backends.flatMap(backend => c.caseKeys.flatMap(caseKey => Array.from({ length: c.rounds },(_,index) => {
    const tuple: unknown = JSON.parse(caseKey);
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple.some(v => typeof v !== "string")) throw new Error("Invalid case coverage");
    return JSON.stringify([backend,tuple[0],tuple[1],tuple[2],index+1]);
  }))));
  if (report.rows.length !== expected.size) throw new Error("Incomplete comparison rows");
  const rows = report.rows.map(row => {
    if (!expected.delete(key(row))) throw new Error("Duplicate or unexpected comparison row");
    if (row.selected.length > row.limit || !isDeepStrictEqual(row.observed.map(o => o.label),row.selected)) throw new Error("Invalid selected observations");
    const j = row.judgment;
    if (j.relevant.some(label => j.forbidden.includes(label)) || new Set(j.relevant).size !== j.relevant.length || new Set(j.forbidden).size !== j.forbidden.length) throw new Error("Invalid comparison judgment");
    const ranking = scoreRanking(row.selected,j,c.ks,row.grades);
    if (!isDeepStrictEqual(ranking,row.ranking)) throw new Error("Stored ranking does not match observations");
    const valuesMatch = (j.values ?? []).every(v => { const item = row.observed.find(o => o.label === v.label); return item && isDeepStrictEqual(item.value,v.value) && (v.version === undefined || item.version === v.version); });
    const stable = !row.error && row.repetitions.length === c.repeats && row.repetitions.every(selected => isDeepStrictEqual(selected,row.selected));
    const passed = !row.error && valuesMatch && ranking.miss.numerator === 0 && ranking.falseSelection.numerator === 0 && ranking.duplicates === 0 && (!j.ordered || isDeepStrictEqual(row.selected.slice(0,j.ordered.length),j.ordered));
    const leakage = Object.fromEntries(Object.entries(row.boundaryLabels).map(([boundary,forbidden]) => {
      if (new Set(forbidden).size !== forbidden.length) throw new Error("Duplicate boundary judgment");
      return [boundary,ratio(row.selected.filter(label => forbidden.includes(label)).length,forbidden.length)];
    }));
    if (row.valuesMatch !== valuesMatch || row.passed !== passed || row.stable !== stable || !isDeepStrictEqual(leakage,row.leakage)) throw new Error("Stored outcome does not match observations");
    return { ...row,ranking,leakage };
  });
  if (expected.size) throw new Error("Missing comparison rows");
  const group = (row: typeof rows[number]) => `${row.backend}/${row.dataset}/${row.channel}`;
  const groups = [...new Set(rows.map(group))];
  const rebuildUnstable = groups.filter(g => {
    const scoped = rows.filter(row => group(row) === g);
    return [...new Set(scoped.map(row => row.id))].some(id => new Set(scoped.filter(row => row.id === id).map(row => JSON.stringify(row.selected))).size !== 1);
  });
  const failures = rows.filter(row => (row.requirementApplies && !row.passed) || row.error || row.ranking.duplicates > 0 || !row.stable || Object.values(row.leakage).some(v => v.numerator)).map(row => `${row.backend}/${row.dataset}/${row.channel}/${row.id}@${row.round}`);
  const gate = { passed: !failures.length && !rebuildUnstable.length,failures,rebuildUnstable };
  if (!isDeepStrictEqual(gate,report.gate)) throw new Error("Stored gate does not match observations");
  return { ...report,rows,gate };
}

export function compareCandidateReports(beforeRaw: unknown,afterRaw: unknown) {
  const before = validateCandidateReport(beforeRaw),after = validateCandidateReport(afterRaw);
  if (!isDeepStrictEqual(before.comparable,after.comparable)) throw new Error("Candidate reports are not comparable");
  const previous = new Map(before.rows.map(row => [key(row),row]));
  const changes: Array<{ case: string; metric: string; before: number; after: number; direction: "improved"|"regressed" }> = [];
  for (const row of after.rows) {
    const old = previous.get(key(row))!;
    for (const field of ["judgment","grades","boundaryLabels","status","category","limit","requirementApplies"] as const) if (!isDeepStrictEqual(old[field],row[field])) throw new Error("Case judgment or budget changed");
    const check = (metric: string,a: number | null,b: number | null,higherBetter: boolean) => {
      if (a === null || b === null || Math.abs(a-b) < 1e-12) return;
      changes.push({ case: key(row),metric,before: a,after: b,direction: (b>a) === higherBetter ? "improved" : "regressed" });
    };
    for (const k of after.comparable.ks) {
      check(`recall@${k}`,old.ranking.atK[k]!.recall.value,row.ranking.atK[k]!.recall.value,true);
      check(`mrr@${k}`,old.ranking.atK[k]!.reciprocalRank,row.ranking.atK[k]!.reciprocalRank,true);
      check(`ndcg@${k}`,old.ranking.atK[k]!.ndcg,row.ranking.atK[k]!.ndcg,true);
    }
    check("miss-count",old.ranking.miss.numerator,row.ranking.miss.numerator,false);
    // Counts also catch new false selections when the old denominator was zero.
    check("false-selection-count",old.ranking.falseSelection.numerator,row.ranking.falseSelection.numerator,false);
    check("case-pass",Number(old.passed),Number(row.passed),true);
    for (const boundary of Object.keys(row.leakage)) check(`leakage:${boundary}`,old.leakage[boundary]!.numerator,row.leakage[boundary]!.numerator,false);
  }
  return { format: "open-continuity-candidate-comparison-v1",referenceMode: before.mode,currentMode: after.mode,comparable: after.comparable,comparedRows: after.rows.length,
    referenceSource: before.evidence.sourceHash,currentSource: after.evidence.sourceHash,sameSource: before.evidence.sourceHash === after.evidence.sourceHash,
    passed: after.gate.passed && !changes.some(c => c.direction === "regressed"),changes,regressions: changes.filter(c => c.direction === "regressed"),
    note: "Per-case checks include challenges; counts/signals are not independent production defects. Latency is reported separately, not a quality gate." };
}

const duration = z.number().finite().nonnegative();
const capacitySchema = z.object({ workload: z.literal("candidate-capacity-v1"),mode: z.enum(["legacy","native"]),harnessHash: digest,
  evidence: z.object({ sourceHash: digest,lockHash: digest,commit: z.string() }).passthrough(),
  environment: z.object({ node: z.string(),platform: z.string(),architecture: z.string() }).strict(),
  settings: z.object({ sizes: z.array(z.number().int().positive()).min(1),iterations: z.number().int().positive(),runs: z.number().int().positive(),warmups: z.number().int().nonnegative() }).strict(),
  results: z.array(z.object({ size: z.number().int().positive(),run: z.number().int().positive(),operations: z.array(z.object({
    operation: z.enum(["exact","structured","full_text","short"]),invalidResponses: z.number().int().nonnegative(),samplesMs: z.array(duration),count: z.number().int().nonnegative(),p50: duration.nullable(),p95: duration.nullable(),p99: duration.nullable(),max: duration.nullable(),
  }).strict()) })),validityPassed: z.boolean(),
}).passthrough();
export function validateCandidateCapacity(raw: unknown) {
  const report = capacitySchema.parse(raw),s = report.settings;
  if (new Set(s.sizes).size !== s.sizes.length || s.sizes.some(n => n>100000) || s.iterations>10000 || s.runs>10 || s.warmups !== 10) throw new Error("Invalid capacity coverage");
  const remaining = new Set(s.sizes.flatMap(size => Array.from({length:s.runs},(_,i) => `${size}/${i+1}`)));
  for (const row of report.results) {
    if (!remaining.delete(`${row.size}/${row.run}`) || row.operations.length !== 4 || new Set(row.operations.map(o => o.operation)).size !== 4) throw new Error("Incomplete capacity operations");
    for (const operation of row.operations) {
      const {operation: _name,invalidResponses,...stored} = operation;
      if (operation.samplesMs.length !== s.iterations || invalidResponses>s.iterations || !isDeepStrictEqual(stored,latencySummary(operation.samplesMs))) throw new Error("Invalid capacity samples or percentiles");
    }
  }
  if (remaining.size || report.validityPassed !== report.results.every(r => r.operations.every(o => o.invalidResponses === 0))) throw new Error("Incomplete capacity evidence");
  return report;
}
export function compareCandidateCapacity(beforeRaw: unknown,afterRaw: unknown) {
  const before = validateCandidateCapacity(beforeRaw),after = validateCandidateCapacity(afterRaw);
  for (const field of ["settings","environment","harnessHash"] as const) if (!isDeepStrictEqual(before[field],after[field])) throw new Error("Capacity reports are not comparable");
  const summarize = (report: typeof before,size: number,operation: string) => {
    const rows = report.results.filter(r => r.size === size).flatMap(r => r.operations.filter(o => o.operation === operation));
    const range = (field: "p50"|"p95"|"p99") => { const values = rows.map(r => r[field]).filter((v):v is number => v!==null); return [Math.min(...values),Math.max(...values)]; };
    return { p50Range: range("p50"),p95Range: range("p95"),p99Range: range("p99"),invalidResponses: rows.reduce((n,r) => n+r.invalidResponses,0),samples: rows.reduce((n,r) => n+r.count,0) };
  };
  return { format: "open-continuity-candidate-capacity-comparison-v1",responseValidityPassed: before.validityPassed && after.validityPassed,latencyGate: "NOT ESTABLISHED",
    measurements: after.settings.sizes.flatMap(size => ["exact","structured","full_text","short"].map(operation => ({ size,operation,before: summarize(before,size,operation),after: summarize(after,size,operation) }))),
    note: "Ranges retain every run. Correct responses or lower latency in a sample do not establish a production SLO or statistical speedup." };
}
