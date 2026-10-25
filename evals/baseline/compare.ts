import { z } from "zod";
import type { BaselineReport } from "./evaluator.js";

const ratioSchema = z.object({ numerator: z.number().finite().nonnegative(), denominator: z.number().finite().nonnegative(), value: z.number().finite().nullable() });
const rowSchema = z.object({
  backend: z.string(), id: z.string(), endpoint: z.enum(["recall", "context"]), round: z.number().int().positive(),
  status: z.enum(["required", "challenge"]), selected: z.array(z.string()), passed: z.boolean(), stable: z.boolean(), valuesMatch: z.boolean(), error: z.string().nullable(),
  leakage: z.record(z.string(), ratioSchema),
  ranking: z.object({ atK: z.record(z.string(), z.object({ recall: ratioSchema, reciprocalRank: z.number().finite().nullable(), ndcg: z.number().finite().nullable() })), miss: ratioSchema, falseSelection: ratioSchema, duplicates: z.number().int().nonnegative() }),
});
const reportSchema = z.object({
  format: z.literal("open-continuity-core-baseline-report-v1"),
  comparable: z.object({ datasetHash: z.string(), harnessHash: z.string(), sourceLockHash: z.string(), harnessLockHash: z.string(), node: z.string(), settings: z.object({ rounds: z.number(), ks: z.array(z.number()), backends: z.array(z.string()), repeatQueries: z.number(), warmupQueries: z.number(), candidateLimit: z.number(), tokenBudget: z.number(), writeSpacingMs: z.number() }) }),
  gate: z.object({ passed: z.boolean() }), rows: z.array(rowSchema).min(1),
});
type ComparableReport = z.infer<typeof reportSchema>;
export function parseReport(raw: unknown) { return reportSchema.parse(raw); }
export function compareReports(beforeRaw: BaselineReport | ComparableReport, afterRaw: BaselineReport | ComparableReport) {
  const before = parseReport(beforeRaw);
  const after = parseReport(afterRaw);
  if (JSON.stringify(before.comparable) !== JSON.stringify(after.comparable)) throw new Error("Incomparable reports: dataset, evaluator, settings, lockfile or Node changed");
  const key = (row: ComparableReport["rows"][number]) => `${row.backend}/${row.endpoint}/${row.id}@${row.round}`;
  const original = new Map(before.rows.map((row) => [key(row), row]));
  const updated = new Map(after.rows.map((row) => [key(row), row]));
  if (original.size !== before.rows.length || updated.size !== after.rows.length || original.size !== updated.size || [...original.keys()].some((id) => !updated.has(id))) throw new Error("Missing or duplicated observations");
  const regressions: Array<{ observation: string; signal: string; before: number | boolean; after: number | boolean }> = [];
  const deltas: Array<{ observation: string; k: string; recall: number | null; mrr: number | null; ndcg: number | null }> = [];
  const lower = (id: string, signal: string, a: number | null, b: number | null) => {
    if ((a === null) !== (b === null)) throw new Error("Metric coverage changed");
    if (a !== null && b !== null && b + 1e-12 < a) regressions.push({ observation: id, signal, before: a, after: b });
  };
  for (const [id, a] of original) {
    const b = updated.get(id)!;
    if (a.status !== b.status) throw new Error("Case status changed");
    for (const signal of ["passed", "stable", "valuesMatch"] as const) if (a[signal] && !b[signal]) regressions.push({ observation: id, signal, before: true, after: false });
    for (const name of Object.keys(a.leakage)) {
      if (a.leakage[name]!.denominator !== b.leakage[name]?.denominator) throw new Error("Security coverage changed");
      if (b.leakage[name]!.numerator > a.leakage[name]!.numerator) regressions.push({ observation: id, signal: `leakage.${name}`, before: a.leakage[name]!.numerator, after: b.leakage[name]!.numerator });
    }
    lower(id, "selectionPrecision", a.ranking.falseSelection.value === null ? 1 : 1 - a.ranking.falseSelection.value, b.ranking.falseSelection.value === null ? 1 : 1 - b.ranking.falseSelection.value);
    if (b.ranking.duplicates > a.ranking.duplicates) regressions.push({ observation: id, signal: "duplicates", before: a.ranking.duplicates, after: b.ranking.duplicates });
    for (const k of before.comparable.settings.ks.map(String)) {
      const first = a.ranking.atK[k]!;
      const second = b.ranking.atK[k]!;
      if (!first || !second || first.recall.denominator !== second.recall.denominator) throw new Error("Ranking coverage changed");
      lower(id, `recall@${k}`, first.recall.value, second.recall.value);
      lower(id, `mrr@${k}`, first.reciprocalRank, second.reciprocalRank);
      lower(id, `ndcg@${k}`, first.ndcg, second.ndcg);
      deltas.push({ observation: id, k, recall: first.recall.value === null ? null : second.recall.value! - first.recall.value, mrr: first.reciprocalRank === null ? null : second.reciprocalRank! - first.reciprocalRank, ndcg: first.ndcg === null ? null : second.ndcg! - first.ndcg });
    }
  }
  const observedSafe = after.rows.every((row) => !row.error && row.stable && (row.status !== "required" || row.passed) && Object.values(row.leakage).every((value) => value.numerator === 0));
  return { passed: observedSafe && after.gate.passed && regressions.length === 0, regressions, deltas, performanceGate: "not evaluated; hardware and capacity workload require a separate controlled benchmark", independentUnits: new Set(before.rows.map((row) => row.id)).size, note: "Repeated rounds are technical repeats, not independent queries. This gate checks per-case regression; it does not establish statistical generalization." };
}
