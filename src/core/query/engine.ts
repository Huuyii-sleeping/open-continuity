import { performance } from "node:perf_hooks";
import { OpenContinuityError } from "../../shared/errors.js";
import type { AgenticQueryResult, AgenticQueryStepReceipt, MemoryEvent, ParsedAgenticQueryInput } from "../../shared/types.js";
import { ContextPackBuilder, type ContextPackPolicy } from "../context/pack.js";
import type { ResolvedContextPackPolicy } from "../context/selection.js";
import type { MemoryHistoryReader } from "../memory/storage-contract.js";
import { ReadDeadline, ReadTimeoutError } from "../runtime/read-runtime.js";
import type { EvidenceAccumulator } from "./contracts.js";
import { resolveAgenticQueryPolicy, type AgenticQueryPolicy, type QueryEvidenceReader } from "./contracts.js";
import { materializeEvidence, mergeQueryEvidence } from "./evidence.js";
import { revalidateQueryFacts } from "./fact-review.js";
import { queryFallback } from "./fallback.js";
import { loadQueryHistory } from "./history.js";
import { createQueryPlan } from "./planner.js";
import { recallQueryStep } from "./recall.js";
import { composeQueryResponse } from "./response.js";
export { resolveAgenticQueryPolicy, type AgenticQueryPolicy } from "./contracts.js";


export class AgenticQueryEngine {
  private readonly contextPack: ContextPackBuilder;
  private readonly contextPackPolicy: Readonly<ResolvedContextPackPolicy>;

  constructor(private readonly store: MemoryHistoryReader, private readonly retrieval: QueryEvidenceReader, contextPackPolicy: ContextPackPolicy, private readonly policy: AgenticQueryPolicy) {
    this.policy = resolveAgenticQueryPolicy(policy);
    this.contextPack = new ContextPackBuilder(retrieval, contextPackPolicy);
    this.contextPackPolicy = Object.freeze(this.contextPack.capabilityPolicy());
  }

  async query(input: ParsedAgenticQueryInput, executionBudget?: ReadDeadline): Promise<AgenticQueryResult> {
    const maxSteps = input.maxSteps ?? this.policy.defaultMaxSteps;
    const timeoutMs = input.timeoutMs ?? this.policy.defaultTimeoutMs;
    if (maxSteps > this.policy.maxSteps) throw new OpenContinuityError("VALIDATION_ERROR", "maxSteps exceeds the active profile limit", 400, { maxSteps, profileMaxSteps: this.policy.maxSteps });
    if (timeoutMs > this.policy.maxTimeoutMs) throw new OpenContinuityError("VALIDATION_ERROR", "timeoutMs exceeds the active profile limit", 400, { timeoutMs, profileMaxTimeoutMs: this.policy.maxTimeoutMs });
    if (input.subqueries && input.subqueries.length > this.policy.maxSubqueries) throw new OpenContinuityError("VALIDATION_ERROR", "subqueries exceed the active profile limit", 400, { subqueries: input.subqueries.length, profileMaxSubqueries: this.policy.maxSubqueries });

    const plan = createQueryPlan(input, this.policy);
    const startedAt = performance.now();
    const budget = executionBudget ?? new ReadDeadline(timeoutMs);
    const steps: AgenticQueryStepReceipt[] = [];
    const evidenceById = new Map<string, EvidenceAccumulator>();
    let historyEvents: MemoryEvent[] = [];
    let historyTruncatedMemoryIds = new Set<string>();
    let historyTruncated = false;
    let stoppedReason: AgenticQueryResult["execution"]["stoppedReason"] = "completed";
    let candidateTruncated = false;

    for (const step of plan.steps) {
      if (steps.filter((item) => item.status !== "skipped").length >= maxSteps) {
        steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: 0, detail: "max_steps" });
        if (stoppedReason !== "timeout") stoppedReason = "max_steps";
        continue;
      }
      if (budget.expired()) {
        steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: 0, detail: "timeout" });
        stoppedReason = "timeout";
        continue;
      }

      const stepStartedAt = performance.now();
      try {
        if (step.type === "recall") {
          const recall = await budget.wait(() => recallQueryStep(this.retrieval, input, step.query!, this.contextPackPolicy.requireUserConfirmed));
          candidateTruncated ||= recall.retrieval?.truncated ?? false;
          mergeQueryEvidence(evidenceById, recall.memories, step.query!, step.id);
          steps.push({
            ...step, status: "completed", candidateCount: recall.memories.length, durationMs: performance.now() - stepStartedAt,
            ...(recall.retrieval?.factReview ? { factReview: recall.retrieval.factReview } : {})
          });
        } else if (evidenceById.size === 0) {
          steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: performance.now() - stepStartedAt, detail: "no_candidates" });
        } else {
          const history = await budget.wait(() => loadQueryHistory(this.store, this.policy, input, evidenceById));
          historyEvents = history.events;
          historyTruncatedMemoryIds = history.truncatedMemoryIds;
          historyTruncated = history.truncated;
          steps.push({ ...step, status: "completed", candidateCount: historyEvents.length, durationMs: performance.now() - stepStartedAt, ...(history.truncated ? { detail: "history_limit" } : {}) });
        }
      } catch (error) {
        if (!(error instanceof ReadTimeoutError)) throw error;
        steps.push({ ...step, status: "timed_out", candidateCount: 0, durationMs: performance.now() - stepStartedAt, detail: "timeout" });
        stoppedReason = "timeout";
      }
    }

    let factReview: AgenticQueryResult["factReview"];
    if ([...evidenceById.values()].some(item => item.memory.fact)) {
      const checkedFacts = await revalidateQueryFacts(this.retrieval, budget, input, evidenceById, this.contextPackPolicy.requireUserConfirmed);
      factReview = checkedFacts.factReview;
      if (checkedFacts.timedOut) stoppedReason = "timeout";
    }
    const evidence = materializeEvidence(evidenceById, historyEvents, plan.historyRequested, historyTruncatedMemoryIds);
    const response = composeQueryResponse(this.contextPack, this.contextPackPolicy, input, plan, evidence, historyEvents, historyTruncated, candidateTruncated, steps, budget, stoppedReason);
    const { contextPack, sufficiency, retrievalSufficiency, answer } = response;
    stoppedReason = response.stoppedReason;
    const fallback = queryFallback(plan, historyTruncated, stoppedReason, sufficiency);

    return {
      plan: { id: plan.id, complexity: plan.complexity, strategy: plan.strategy, rationale: plan.rationale, steps: plan.steps }, steps, evidence, contextPack, sufficiency,
      retrievalSufficiency, sufficiencyVersion: "budgeted-context-v1", answer,
      ...(factReview ? { factReview } : {}),
      execution: { maxSteps, completedSteps: steps.filter((step) => step.status === "completed").length, timeoutMs, elapsedMs: performance.now() - startedAt, stoppedReason },
      fallback,
    };
  }


}
