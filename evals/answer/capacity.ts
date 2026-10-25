import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { candidateRuntime } from "../candidates/runtime.js";
import { latencySummary } from "../baseline/metrics.js";
import { actor } from "./dataset.js";

export async function answerCapacity(source: string) {
  const module = await import(pathToFileURL(join(source, "src/core/memory-service.ts")).href) as typeof import("../../src/core/memory-service.js");
  const results = [];
  for (const size of [1000, 10000]) for (let round = 1; round <= 3; round++) {
    const rt = await candidateRuntime(source, "sqlite");
    try {
      const service = new module.MemoryService(rt.store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 2, requireUserConfirmed: true });
      for (let index = 0; index < size; index++) await service.remember({ ...actor, key: `fictional-noise-${index}`, value: "fictional unrelated filler", kind: "decision", userConfirmed: true, idempotencyKey: `fictional-noise-${index}` });
      for (const topic of ["alpha", "beta"]) await service.remember({ ...actor, key: topic, value: `fictional ${topic} condition`, kind: "decision", userConfirmed: true, idempotencyKey: `fictional-${topic}` });
      const input = { ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"], maxMemories: 2 };
      for (let index = 0; index < 10; index++) await service.query(input);
      const samples: number[] = []; let invalidResponses = 0;
      for (let index = 0; index < 100; index++) {
        const started = performance.now(), result = await service.query(input); samples.push(performance.now() - started);
        if (result.answer?.status !== "evidence_ready" || result.contextPack.coverage?.coveredQueries !== 2 || result.answer.citations.length !== 2
          || result.answer.statements.map(item => item.key).sort().join(",") !== "alpha,beta" || result.contextPack.budget.usedTokens > result.contextPack.budget.requestedTokens) invalidResponses++;
      }
      results.push({ size, round, operation: "two-query-budgeted-answer", invalidResponses, latency: latencySummary(samples) });
    } finally { await rt.close(); }
  }
  return { workload: "fictional unrelated records plus two distinct query topics; two-item Context", warmups: 10, samples: 100,
    results, valid: results.every(row => row.invalidResponses === 0), note: "SQLite serial end-to-end Query with coverage and citations. All raw samples retained; no concurrency or performance SLO claim." };
}
