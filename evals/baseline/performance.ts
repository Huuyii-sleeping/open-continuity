import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { latencySummary } from "./metrics.js";
import { runtime, sourceEvidence } from "./evaluator.js";

export function validCapacitySelection(operation: "exact" | "fts" | "context", selected: Array<{ key: string; value: unknown }>, record: number, topic: string) {
  return selected.length > 0 && selected.every((item) => operation === "exact" ? item.key === `fictional_record_${record}` : String(item.value).includes(topic));
}

export async function measureCapacity(sourceRoot: string, sizes: number[] = [1000, 10000], iterations = 200, runs = 3) {
  if (sizes.length === 0 || sizes.some((size) => !Number.isInteger(size) || size < 1 || size > 100000) || !Number.isInteger(iterations) || iterations < 1 || iterations > 10000 || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("Invalid capacity workload");
  const evidence = sourceEvidence(sourceRoot);
  const results = [];
  for (const size of sizes) for (let run = 1; run <= runs; run++) {
    const rt = await runtime(sourceRoot, "sqlite");
    try {
      const start = performance.now();
      for (let index = 0; index < size; index++) await rt.service.remember({
        userId: "baseline-capacity-user", agentId: "baseline-capacity-writer", key: `fictional_record_${index}`,
        value: `Fictional capacity Topic ${String(index % 250).padStart(6, "0")} record ${index}`,
        kind: "user_fact", userConfirmed: true, idempotencyKey: `fictional-capacity-${index}`,
      });
      const seedMs = performance.now() - start;
      const samples = [];
      for (const operation of ["exact", "fts", "context"] as const) {
        const durations: number[] = [];
        let invalidResponses = 0;
        for (let index = -10; index < iterations; index++) {
          const record = Math.abs(index) % size;
          const topic = `Topic ${String(Math.abs(index) % Math.min(size, 250)).padStart(6, "0")}`;
          const input = { userId: "baseline-capacity-user", agentId: "baseline-capacity-reader", includePrivate: false };
          const started = performance.now();
          const selected = operation === "context"
            ? (await rt.service.context({ ...input, query: topic, purpose: "general", tokenBudget: 1024, maxMemories: 10 })).items
            : (await rt.service.recall({ ...input, ...(operation === "exact" ? { key: `fictional_record_${record}` } : { query: topic }), limit: 10 })).memories;
          const duration = performance.now() - started;
          if (index >= 0) {
            durations.push(duration);
            if (!validCapacitySelection(operation, selected, record, topic)) invalidResponses++;
          }
        }
        samples.push({ operation, invalidResponses, ...latencySummary(durations) });
      }
      results.push({ size, run, seedMs, writesPerSecond: size / (seedMs / 1000), databaseBytes: statSync(rt.databasePath).size, samples });
    } finally { await rt.close(); }
  }
  if (!isDeepStrictEqual(evidence, sourceEvidence(sourceRoot))) throw new Error("Source changed during capacity benchmark");
  return { workload: "fictional-capacity-v1", settings: { sizes, iterations, runs, warmups: 10, topicCount: 250, userConfirmed: true }, evidence, results,
    validityPassed: results.every((result) => result.samples.every((sample) => sample.invalidResponses === 0)),
    note: "Serial single-process capacity benchmark. Retain each run and raw durations. P99 is descriptive, not an SLO. Concurrency, crashes and cold-start are separate workloads." };
}
