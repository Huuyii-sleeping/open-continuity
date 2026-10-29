import type { AgenticEvidence, AgenticQueryResult, AgenticQueryStepReceipt, MemoryEvent, ParsedAgenticQueryInput } from "../../shared/types.js";
import { composeEvidenceAnswer } from "../answer/evidence-answer.js";
import { contextCoverage } from "../context/coverage.js";
import type { ContextMemoryPacker, ResolvedContextPackPolicy } from "../context/contracts.js";
import { ReadDeadline } from "../runtime/read-runtime.js";
import { assessBudgetedQuery } from "./budgeted-sufficiency.js";
import type { PlannedQuery } from "./contracts.js";
import { assessQuerySufficiency } from "./sufficiency.js";
export function composeQueryResponse(contextPackBuilder: ContextMemoryPacker, contextPackPolicy: Readonly<ResolvedContextPackPolicy>, input: ParsedAgenticQueryInput, plan: PlannedQuery, evidence: AgenticEvidence[], historyEvents: MemoryEvent[], historyTruncated: boolean, candidateTruncated: boolean, steps: AgenticQueryStepReceipt[], budget: ReadDeadline, stoppedReason: AgenticQueryResult["execution"]["stoppedReason"]) {
  const syntheticMemories = evidence.map((item) => ({ ...item.memory, retrieval: { ...(item.memory.retrieval ?? { channels: [], ranks: {} }), score: item.score } }));
  const obligations = plan.requestedQueries.map((query, index) => ({
    id: `query-${index + 1}`, query,
    memoryIds: evidence.filter(item => item.matchedQueries.includes(query)).map(item => item.memory.id)
  }));
  let contextPack = contextPackBuilder.buildFromMemories(input, syntheticMemories, undefined, obligations);
  if (budget.expired()) {
    stoppedReason = "timeout";
    const empty = contextPackBuilder.buildFromMemories(input, []);
    contextPack = { ...empty, coverage: contextCoverage(obligations, new Set(), contextPack.omitted, contextPackPolicy.queryPacking, 0) };
    contextPack.coverage!.requirements = contextPack.coverage!.requirements.map(row => ({ ...row, reason: "execution_timeout" }));
  }
  const matchedQueries = new Set(evidence.flatMap((item) => item.matchedQueries)).size;
  const retrievalSufficiency = assessQuerySufficiency(input, plan, evidence, matchedQueries, stoppedReason, historyEvents.length, historyTruncated);
  const packedIds = new Set(contextPack.items.map(item => item.memoryId));
  const packed = evidence.filter(item => packedIds.has(item.memory.id));
  let sufficiency = assessBudgetedQuery(input, plan, evidence, packed, contextPack.coverage!.coveredQueries, stoppedReason, historyTruncated, candidateTruncated, steps);
  let answer = composeEvidenceAnswer(contextPack, evidence, sufficiency, plan.historyRequested);
  // Rendering/hashing is synchronous too; never publish an answer completed after the budget.
  if (budget.expired()) {
    stoppedReason = "timeout";
    contextPack = contextPackBuilder.buildFromMemories(input, []);
    contextPack.coverage = contextCoverage(obligations, new Set(), [], contextPackPolicy.queryPacking, 0);
    contextPack.coverage.requirements = contextPack.coverage.requirements.map(row => ({ ...row, reason: "execution_timeout" }));
    sufficiency = assessQuerySufficiency(input, plan, [], 0, "timeout", 0, historyTruncated);
    answer = composeEvidenceAnswer(contextPack, evidence, sufficiency, plan.historyRequested);
  }
  return { contextPack, sufficiency, retrievalSufficiency, answer, stoppedReason };
}
