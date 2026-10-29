import type { AgenticQueryResult, ParsedAgenticQueryInput } from "../../shared/types.js";
import { ReadDeadline, ReadTimeoutError } from "../runtime/read-runtime.js";
import type { EvidenceAccumulator } from "./contracts.js";
import { type QueryEvidenceReader } from "./contracts.js";
export async function revalidateQueryFacts(reader: QueryEvidenceReader, budget: ReadDeadline, input: ParsedAgenticQueryInput, evidenceById: Map<string, EvidenceAccumulator>, requireUserConfirmed: boolean) {
  let stoppedReason: AgenticQueryResult["execution"]["stoppedReason"] = "completed";
  let factReview: AgenticQueryResult["factReview"];
  if ([...evidenceById.values()].some(item => item.memory.fact)) {
    try {
      const checked = await budget.wait(() => reader.reviewFacts({ ...input, limit: 100, cursor: undefined },
        [...evidenceById.values()].map(item => item.memory), requireUserConfirmed));
      factReview = checked.review;
      const accepted = new Map(checked.ranked.map(item => [item.memory.id, item.retrieval]));
      for (const [id, item] of evidenceById) {
        if (!accepted.has(id)) evidenceById.delete(id);
        else item.memory = { ...item.memory, retrieval: accepted.get(id) };
      }
    } catch (error) {
      if (!(error instanceof ReadTimeoutError)) throw error;
      // Never inject stale fact assessments when final validation runs out of budget.
      for (const [id, item] of evidenceById) if (item.memory.fact) evidenceById.delete(id);
      stoppedReason = "timeout";
    }
  }
  return { factReview, timedOut: stoppedReason === "timeout" };
}
