import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { candidateRuntime } from "../candidates/runtime.js";
import { sourceEvidence } from "../baseline/evaluator.js";
import { latencySummary } from "../baseline/metrics.js";

export const PERF_SETTINGS = { sizes: [1000, 10000], rounds: 3, warmups: 20, iterations: 100,
  workloads: ["literal_hit", "typo_hit", "absent", "broad_probe"], multiplier: 2, allowanceMs: 2 } as const;
const QUERIES = { literal_hit: "nebula observatory", typo_hit: "nebulra observatory", absent: "quasar missing", broad_probe: "nebulra checkpoint" } as const;
type Workload = keyof typeof QUERIES;
interface PerformanceRow { size: number; round: number; workload: Workload; policy: "off" | "latin_one_edit"; latency: ReturnType<typeof latencySummary>; }
export function performanceGate(rows: PerformanceRow[], sizes: readonly number[] = PERF_SETTINGS.sizes, iterations: number = PERF_SETTINGS.iterations) {
  if (!sizes.length || new Set(sizes).size !== sizes.length || sizes.some(size => !Number.isInteger(size) || size < 100 || size > 10000)
    || !Number.isInteger(iterations) || iterations < 1) throw new Error("Invalid lexical performance settings");
  const keys = sizes.flatMap(size => [1, 2, 3].flatMap(round => PERF_SETTINGS.workloads.flatMap(workload => ["off", "latin_one_edit"].map(policy => `${size}/${round}/${workload}/${policy}`))));
  const key = (row: PerformanceRow) => `${row.size}/${row.round}/${row.workload}/${row.policy}`;
  if (rows.length !== keys.length || new Set(rows.map(key)).size !== keys.length || rows.some(row => !keys.includes(key(row))
    || row.latency.samplesMs.length !== iterations || row.latency.samplesMs.some(sample => !Number.isFinite(sample) || sample < 0)
    || !isDeepStrictEqual(row.latency, latencySummary(row.latency.samplesMs)))) throw new Error("Invalid lexical performance grid");
  const median = (values: number[]) => values.sort((a, b) => a - b)[1]!;
  const comparisons = sizes.flatMap(size => PERF_SETTINGS.workloads.map(workload => {
    const measure = (policy: PerformanceRow["policy"]) => median(rows.filter(row => row.size === size && row.workload === workload && row.policy === policy).map(row => row.latency.p95!));
    const offP95 = measure("off"), onP95 = measure("latin_one_edit"), thresholdMs = offP95 * PERF_SETTINGS.multiplier + PERF_SETTINGS.allowanceMs;
    return { size, workload, offP95MedianMs: offP95, onP95MedianMs: onP95, thresholdMs, passed: onP95 <= thresholdMs };
  }));
  return { passed: comparisons.every(row => row.passed), comparisons, note: "same-host engineering budget, not production SLO; literal hits also observed separately" };
}
export async function evaluateLexicalPerformance(source: string, sizes: readonly number[] = PERF_SETTINGS.sizes, iterations: number = PERF_SETTINGS.iterations, warmups: number = PERF_SETTINGS.warmups) {
  if (!sizes.length || new Set(sizes).size !== sizes.length || sizes.some(size => !Number.isInteger(size) || size < 100 || size > 10000)
    || !Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(warmups) || warmups < 0) throw new Error("Invalid performance fixture");
  const evidence = sourceEvidence(source), rows: PerformanceRow[] = [];
  const module = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/application/memory-service.js");
  const actor = { userId: "fictional-lexical-performance-user", agentId: "fictional-lexical-performance-reader" };
  for (const size of sizes) for (let round = 1; round <= 3; round++) {
    const runtime = await candidateRuntime(source, "sqlite");
    const services = { off: new module.MemoryService(runtime.store, { channels: ["full_text"], lexicalFallback: "off" }),
      latin_one_edit: new module.MemoryService(runtime.store, { channels: ["full_text"], lexicalFallback: "latin_one_edit" }) };
    try {
      for (let n = 0; n < size; n++) await runtime.service.remember({ ...actor, key: `fictional-record-${n}`, value: n < 10 ? "nebula observatory" : n % 10 === 0 ? "nebulous checkpoint" : `fictional filler record ${n}`,
        kind: "decision", userConfirmed: true, idempotencyKey: `fictional-perf-${n}` });
      for (const workload of PERF_SETTINGS.workloads) {
        const samples = { off: [] as number[], latin_one_edit: [] as number[] };
        for (let n = -warmups; n < iterations; n++) {
          const order = (n + round) % 2 ? ["off", "latin_one_edit"] as const : ["latin_one_edit", "off"] as const;
          for (const policy of order) {
            const start = performance.now(); const result = await services[policy].recall({ ...actor, query: QUERIES[workload], limit: 5 });
            const elapsed = performance.now() - start;
            if ((workload === "literal_hit" || (workload === "typo_hit" && policy === "latin_one_edit")) && result.memories.length !== 5) throw new Error("Invalid expected performance hit");
            if (workload !== "literal_hit" && (policy === "off" || workload !== "typo_hit") && result.memories.length) throw new Error("Invalid expected performance miss");
            if (n >= 0) samples[policy].push(elapsed);
          }
        }
        for (const policy of ["off", "latin_one_edit"] as const) rows.push({ size, round, workload, policy, latency: latencySummary(samples[policy]) });
      }
    } finally { await runtime.close(); }
  }
  if (!isDeepStrictEqual(evidence, sourceEvidence(source))) throw new Error("Source changed during performance evaluation");
  return { format: "lexical-performance-v1", evidence, settings: { ...PERF_SETTINGS, sizes, iterations, warmups },
    rows, gate: performanceGate(rows, sizes, iterations), note: "Fictional SQLite-only data; one machine; read operations exclude seeding, no hard SQL deadline claim." };
}
