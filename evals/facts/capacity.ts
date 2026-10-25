import { performance } from "node:perf_hooks";
import { candidateRuntime } from "../candidates/runtime.js";
import { latencySummary } from "../baseline/metrics.js";

/** Annotated SQLite cost workload, not a quality or latency SLO gate. */
export async function measureFactCapacity(source: string) {
  const rows = [];
  const actor = { userId: "fictional-fact-capacity", agentId: "fictional-fact-capacity-reader" };
  for (const capacity of [1000, 10000]) for (let round = 1; round <= 3; round++) {
    const rt = await candidateRuntime(source, "sqlite");
    try {
      let supportsDeclarations = false;
      for (let index = 0; index < capacity; index++) {
        const saved = await rt.service.remember({ ...actor, key: `fictional-record-${index}`, value: "fictional evidence sqlite",
          kind: "decision", expectedVersion: 0, userConfirmed: true, idempotencyKey: `fictional-record-${index}`,
          fact: { group: `fictional-group-${index}` } });
        supportsDeclarations ||= Boolean(saved.current.fact);
      }
      for (const operation of ["single_group", "many_groups"] as const) {
        const query = operation === "single_group" ? `fictional-record-${capacity - 1}` : "fictional evidence";
        const call = async () => {
          const result = await rt.service.recall({ ...actor, query, limit: 100 });
          if (result.memories.length !== (operation === "single_group" ? 1 : 50)
            || result.memories.some(memory => memory.value !== "fictional evidence sqlite")
            || (supportsDeclarations && result.memories.some(memory => !memory.retrieval?.factAssessment?.usable))) {
            throw new Error("Invalid fictional annotated capacity response");
          }
        };
        for (let warmup = 0; warmup < 10; warmup++) await call();
        const samples = [];
        for (let sample = 0; sample < 200; sample++) { const start = performance.now(); await call(); samples.push(performance.now() - start); }
        rows.push({ capacity, round, operation, supportsDeclarations, warmups: 10, samples, latency: latencySummary(samples), responseErrors: 0 });
      }
    } finally { await rt.close(); }
  }
  return { source, rows, note: "Synthetic annotated cost, including response validation; three rounds, no statistical speedup or latency SLO. Old source has no fact declarations." };
}
