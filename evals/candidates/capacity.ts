import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { recallInputSchema } from "../../src/shared/types.js";
import type { CandidateSearchRequest } from "../../src/core/candidate-search.js";
import { sourceEvidence } from "../baseline/evaluator.js";
import { latencySummary } from "../baseline/metrics.js";
import { candidateRuntime } from "./runtime.js";
import { candidateHarnessHash, type CandidateMode } from "./evaluator.js";

export async function measureCandidateCapacity(source: string,mode: CandidateMode,sizes = [1000,10000],iterations = 200,runs = 3) {
  if (!sizes.length || sizes.some(s => !Number.isInteger(s) || s<1 || s>100000) || !Number.isInteger(iterations) || iterations<1 || iterations>10000 || !Number.isInteger(runs) || runs<1 || runs>10) throw new Error("Invalid candidate capacity workload");
  const evidence = sourceEvidence(source),harnessHash = candidateHarnessHash(),results = [];
  for (const size of sizes) for (let run=1;run<=runs;run++) {
    const rt = await candidateRuntime(source,"sqlite");
    try {
      for (let index=0;index<size;index++) await rt.service.remember({ userId: "fictional-capacity-user",agentId: "fictional-writer",key: `fictional_record_${index}`,value: `Fictional Topic ${String(index%250).padStart(6,"0")} record ${index} xy`,kind: index%10 === 0 ? "decision" : "user_fact",userConfirmed: true,idempotencyKey: `fictional:${index}` });
      const operations = [];
      for (const operation of ["exact","structured","full_text","short"] as const) {
        const durations: number[] = []; let invalidResponses = 0;
        for (let index=-10;index<iterations;index++) {
          const record = Math.abs(index)%size,topic = `Topic ${String(record%250).padStart(6,"0")}`;
          const input: CandidateSearchRequest = { userId: "fictional-capacity-user",agentId: "fictional-reader",channel: operation === "short" ? "full_text" : operation,limit: 10,
            ...(operation === "exact" ? { key: `fictional_record_${record}` } : operation === "structured" ? { kind: "decision" } : { query: operation === "short" ? "xy" : topic }) };
          const start = performance.now();
          const memories = mode === "native" ? (await rt.store.searchCandidates!(input)).hits.map(h => h.memory)
            : (await (operation === "structured" && rt.store.list ? rt.store.list({ ...recallInputSchema.parse(input), query: undefined }) : rt.store.recall(recallInputSchema.parse(input)))).memories;
          const elapsed = performance.now()-start;
          if (index>=0) {
            durations.push(elapsed);
            if (!memories.length || !memories.every(memory => operation === "exact" ? memory.key === `fictional_record_${record}` : operation === "structured" ? memory.kind === "decision" : String(memory.value).includes(operation === "short" ? "xy" : topic))) invalidResponses++;
          }
        }
        operations.push({ operation,invalidResponses,...latencySummary(durations) });
      }
      results.push({ size,run,operations });
    } finally { await rt.close(); }
  }
  if (!isDeepStrictEqual(evidence,sourceEvidence(source)) || harnessHash !== candidateHarnessHash()) throw new Error("Source or evaluator changed during candidate capacity benchmark");
  return { workload: "candidate-capacity-v1",mode,evidence,harnessHash,environment: { node: process.version,platform: process.platform,architecture: process.arch },settings: { sizes,iterations,runs,warmups: 10 },results,validityPassed: results.every(r => r.operations.every(o => o.invalidResponses === 0)),note: "Serial single-process; retain P50/P95/P99 and all slow samples. No latency SLO or concurrency/crash claim." };
}
