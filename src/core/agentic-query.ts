import { createHash } from "node:crypto";
import { OpenContinuityError } from "../shared/errors.js";
import type { AgenticEvidence, AgenticQueryPlanStep, AgenticQueryResult, AgenticQueryStepReceipt, MemoryEvent, ParsedAgenticQueryInput, QueryComplexity, ResolvedMemory, RetrievalChannel } from "../shared/types.js";
import { ContextPackBuilder, type ContextPackPolicy } from "./context-pack.js";
import type { MemoryStore } from "./memory-store.js";
import type { RetrievalPipeline } from "./retrieval.js";

export interface AgenticQueryPolicy {
  defaultMaxSteps: number; maxSteps: number; defaultTimeoutMs: number; maxTimeoutMs: number; maxSubqueries: number; historyLimit: number;
}

interface PlannedQuery {
  id: string; complexity: QueryComplexity; strategy: "direct" | "multi_step"; rationale: string[]; queries: string[];
  steps: AgenticQueryPlanStep[]; totalQueries: number; historyRequested: boolean; unsupportedComplexity: boolean; subqueryLimitApplied: boolean;
}

interface EvidenceAccumulator { memory: ResolvedMemory; matchedQueries: Set<string>; stepIds: Set<string>; score: number; }
interface HistoryExpansion { events: MemoryEvent[]; truncatedMemoryIds: Set<string>; truncated: boolean; }
class StepTimeoutError extends Error {}

const HISTORY_SIGNAL = /(?:history|historical|change|changed|evolution|previous|before|timeline|why|历史|变化|演化|之前|原因|决策过程)/i;
const MULTI_HOP_SIGNAL = /(?:relationship|related across|across projects|root cause|multi[- ]?hop|关系|跨项目|根因|多跳)/i;
const SPLIT_PATTERN = /(?:\s+&&\s+|\s+and\s+|\s+also\s+|\s+versus\s+|\s+vs\.?\s+|[;；]+|以及|并且|同时|对比|比较)/i;

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function stripPlanningWords(value: string): string {
  const stripped = value
    .replace(/\b(?:history|historical|change|changed|evolution|previous|before|timeline|why|relationship|related across|across projects|root cause|multi[- ]?hop)\b/gi, " " )
    .replace(/(?:历史|变化|演化|之前|原因|决策过程|关系|跨项目|根因|多跳)/g, " " )
    .replace(/\s+/g, " " ).trim();
  return stripped || value.trim();
}

function planId(input: ParsedAgenticQueryInput, queries: string[]): string {
  return createHash("sha256").update(JSON.stringify({ query: input.query, queries, strategy: input.strategy, includeHistory: input.includeHistory, key: input.key ?? null, kind: input.kind ?? null, scope: input.scope ?? null, taskId: input.taskId ?? null })).digest("base64url").slice(0, 16);
}

function combineRetrieval(left: ResolvedMemory["retrieval"], right: ResolvedMemory["retrieval"], score: number): ResolvedMemory["retrieval"] {
  const channels = [...new Set([...(left?.channels ?? []), ...(right?.channels ?? [])])];
  const ranks: Partial<Record<RetrievalChannel, number>> = { ...(left?.ranks ?? {}) };
  for (const [channel, rank] of Object.entries(right?.ranks ?? {}) as Array<[RetrievalChannel, number]>) ranks[channel] = Math.min(ranks[channel] ?? rank, rank);
  return { score: Number(score.toFixed(8)), channels, ranks };
}

export class AgenticQueryEngine {
  private readonly contextPack: ContextPackBuilder;

  constructor(private readonly store: MemoryStore, private readonly retrieval: RetrievalPipeline, contextPolicy: ContextPackPolicy, private readonly policy: AgenticQueryPolicy) {
    this.contextPack = new ContextPackBuilder(retrieval, contextPolicy);
  }

  async query(input: ParsedAgenticQueryInput): Promise<AgenticQueryResult> {
    const maxSteps = input.maxSteps ?? this.policy.defaultMaxSteps;
    const timeoutMs = input.timeoutMs ?? this.policy.defaultTimeoutMs;
    if (maxSteps > this.policy.maxSteps) throw new OpenContinuityError("VALIDATION_ERROR", "maxSteps exceeds the active profile limit", 400, { maxSteps, profileMaxSteps: this.policy.maxSteps });
    if (timeoutMs > this.policy.maxTimeoutMs) throw new OpenContinuityError("VALIDATION_ERROR", "timeoutMs exceeds the active profile limit", 400, { timeoutMs, profileMaxTimeoutMs: this.policy.maxTimeoutMs });
    if (input.subqueries && input.subqueries.length > this.policy.maxSubqueries) throw new OpenContinuityError("VALIDATION_ERROR", "subqueries exceed the active profile limit", 400, { subqueries: input.subqueries.length, profileMaxSubqueries: this.policy.maxSubqueries });

    const plan = this.plan(input);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const steps: AgenticQueryStepReceipt[] = [];
    const evidenceById = new Map<string, EvidenceAccumulator>();
    let historyEvents: MemoryEvent[] = [];
    let historyTruncatedMemoryIds = new Set<string>();
    let historyTruncated = false;
    let stoppedReason: AgenticQueryResult["execution"]["stoppedReason"] = "completed";

    for (const step of plan.steps) {
      if (steps.filter((item) => item.status !== "skipped").length >= maxSteps) {
        steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: 0, detail: "max_steps" });
        if (stoppedReason !== "timeout") stoppedReason = "max_steps";
        continue;
      }
      if (Date.now() >= deadline) {
        steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: 0, detail: "timeout" });
        stoppedReason = "timeout";
        continue;
      }

      const stepStartedAt = Date.now();
      try {
        if (step.type === "recall") {
          const recall = await this.withDeadline(this.retrieval.recall({
            userId: input.userId, agentId: input.agentId, query: step.query!, key: input.key, kind: input.kind, scope: input.scope, taskId: input.taskId,
            includePrivate: input.includePrivate, limit: 100, cursor: undefined,
          }), deadline);
          recall.memories.forEach((memory, index) => {
            const current = evidenceById.get(memory.id) ?? { memory, matchedQueries: new Set<string>(), stepIds: new Set<string>(), score: 0 };
            current.score += memory.retrieval?.score ?? 1 / (60 + index + 1);
            current.memory = { ...current.memory, ...memory, retrieval: combineRetrieval(current.memory.retrieval, memory.retrieval, current.score) };
            current.matchedQueries.add(step.query!); current.stepIds.add(step.id); evidenceById.set(memory.id, current);
          });
          steps.push({ ...step, status: "completed", candidateCount: recall.memories.length, durationMs: Date.now() - stepStartedAt });
        } else if (evidenceById.size === 0) {
          steps.push({ ...step, status: "skipped", candidateCount: 0, durationMs: Date.now() - stepStartedAt, detail: "no_candidates" });
        } else {
          const history = await this.withDeadline(this.loadHistory(input, evidenceById), deadline);
          historyEvents = history.events;
          historyTruncatedMemoryIds = history.truncatedMemoryIds;
          historyTruncated = history.truncated;
          steps.push({ ...step, status: "completed", candidateCount: historyEvents.length, durationMs: Date.now() - stepStartedAt, ...(history.truncated ? { detail: "history_limit" } : {}) });
        }
      } catch (error) {
        if (!(error instanceof StepTimeoutError)) throw error;
        steps.push({ ...step, status: "timed_out", candidateCount: 0, durationMs: Date.now() - stepStartedAt, detail: "timeout" });
        stoppedReason = "timeout";
      }
    }

    const evidence = this.materializeEvidence(evidenceById, historyEvents, plan.historyRequested, historyTruncatedMemoryIds);
    const syntheticMemories = evidence.map((item) => ({ ...item.memory, retrieval: { ...(item.memory.retrieval ?? { channels: [], ranks: {} }), score: item.score } }));
    const contextPack = this.contextPack.buildFromMemories(input, syntheticMemories);
    const matchedQueries = new Set(evidence.flatMap((item) => item.matchedQueries)).size;
    const sufficiency = this.sufficiency(input, plan, evidence, matchedQueries, stoppedReason, historyEvents.length, historyTruncated);
    const fallbackReasons: AgenticQueryResult["fallback"]["reasons"] = [];
    if (plan.unsupportedComplexity) fallbackReasons.push("unsupported_complexity");
    if (plan.subqueryLimitApplied) fallbackReasons.push("subquery_limit");
    if (historyTruncated) fallbackReasons.push("history_limit");
    if (stoppedReason === "max_steps") fallbackReasons.push("max_steps");
    if (stoppedReason === "timeout") fallbackReasons.push("timeout");
    if (sufficiency.status !== "sufficient") fallbackReasons.push("insufficient_evidence");

    return {
      plan: { id: plan.id, complexity: plan.complexity, strategy: plan.strategy, rationale: plan.rationale, steps: plan.steps }, steps, evidence, contextPack, sufficiency,
      execution: { maxSteps, completedSteps: steps.filter((step) => step.status === "completed").length, timeoutMs, elapsedMs: Date.now() - startedAt, stoppedReason },
      fallback: { used: fallbackReasons.length > 0, reasons: [...new Set(fallbackReasons)], mode: "deterministic" },
    };
  }

  private plan(input: ParsedAgenticQueryInput): PlannedQuery {
    const split = unique((input.subqueries ?? (input.key ? [input.key] : input.query.split(SPLIT_PATTERN))).map(stripPlanningWords));
    const requestedQueries = input.strategy === "direct" ? [split[0] ?? input.query] : split;
    const queries = requestedQueries.slice(0, this.policy.maxSubqueries);
    const subqueryLimitApplied = requestedQueries.length > queries.length;
    const requestedHistory = input.includeHistory || HISTORY_SIGNAL.test(input.query);
    const historySignal = input.strategy !== "direct" && requestedHistory;
    const unsupportedComplexity = MULTI_HOP_SIGNAL.test(input.query);
    const complexity: QueryComplexity = unsupportedComplexity ? "L3" : historySignal || queries.length > 1 ? "L2" : input.key ? "L0" : "L1";
    const strategy = input.strategy === "direct" ? "direct" : input.strategy === "multi_step" || complexity === "L2" || complexity === "L3" ? "multi_step" : "direct";
    const rationale = [input.key ? "explicit_key" : "text_query"];
    if (queries.length > 1) rationale.push("query_decomposed");
    if (subqueryLimitApplied) rationale.push("subquery_limit_applied");
    if (historySignal) rationale.push("history_signal");
    if (requestedHistory && input.strategy === "direct") rationale.push("history_signal_ignored_by_direct_strategy");
    if (unsupportedComplexity) rationale.push("graph_or_semantic_reasoning_unavailable");
    const steps: AgenticQueryPlanStep[] = queries.map((query, index) => ({ id: `recall-${index + 1}`, type: "recall", query, reason: index === 0 ? "primary_query" : "subquery_coverage" }));
    if (strategy === "multi_step" && historySignal) steps.push({ id: "history-1", type: "history", reason: "evolution_evidence" });
    return { id: planId(input, queries), complexity, strategy, rationale, queries, steps, totalQueries: requestedQueries.length, historyRequested: strategy === "multi_step" && historySignal, unsupportedComplexity, subqueryLimitApplied };
  }

  private materializeEvidence(accumulators: Map<string, EvidenceAccumulator>, events: MemoryEvent[], historyRequested: boolean, truncatedMemoryIds: Set<string>): AgenticEvidence[] {
    const historyByMemory = new Map<string, MemoryEvent[]>();
    for (const event of events) historyByMemory.set(event.memoryId, [...(historyByMemory.get(event.memoryId) ?? []), event]);
    return [...accumulators.values()].sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id)).map((item) => {
      const history = historyByMemory.get(item.memory.id) ?? [];
      return { memory: item.memory, matchedQueries: [...item.matchedQueries], stepIds: [...item.stepIds], score: Number(item.score.toFixed(8)), ...(historyRequested ? { history: { eventCount: history.length, versions: [...new Set(history.map((event) => event.memoryVersion).filter((value): value is number => value !== undefined))].sort((a, b) => a - b), eventIds: history.map((event) => event.id), truncated: truncatedMemoryIds.has(item.memory.id) } } : {}) };
    });
  }

  private sufficiency(input: ParsedAgenticQueryInput, plan: PlannedQuery, evidence: AgenticEvidence[], matchedQueries: number, stoppedReason: AgenticQueryResult["execution"]["stoppedReason"], historyCount: number, historyTruncated: boolean): AgenticQueryResult["sufficiency"] {
    const reasons: string[] = [];
    if (evidence.length === 0) reasons.push("no_evidence");
    if (evidence.length < input.minEvidence) reasons.push("below_min_evidence");
    if (matchedQueries < plan.totalQueries) reasons.push("partial_query_coverage");
    if (plan.historyRequested && historyCount === 0) reasons.push("missing_history_evidence");
    if (historyTruncated) reasons.push("history_limit");
    if (plan.unsupportedComplexity) reasons.push("unsupported_complexity");
    if (stoppedReason !== "completed") reasons.push(stoppedReason);
    const sufficient = !plan.unsupportedComplexity && !plan.subqueryLimitApplied && !historyTruncated && evidence.length >= input.minEvidence && matchedQueries === plan.totalQueries && (!plan.historyRequested || historyCount > 0) && stoppedReason === "completed";
    return { status: sufficient ? "sufficient" : evidence.length > 0 ? "partial" : "insufficient", matchedQueries, totalQueries: plan.totalQueries, evidenceCount: evidence.length, reasons };
  }

  private async loadHistory(input: ParsedAgenticQueryInput, accumulators: Map<string, EvidenceAccumulator>): Promise<HistoryExpansion> {
    const ranked = [...accumulators.values()].sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt) || right.memory.id.localeCompare(left.memory.id));
    const targets = ranked.slice(0, Math.min(this.policy.maxSubqueries, this.policy.historyLimit));
    const truncatedMemoryIds = new Set(ranked.slice(targets.length).map((item) => item.memory.id));
    const baseLimit = Math.floor(this.policy.historyLimit / targets.length);
    const remainder = this.policy.historyLimit % targets.length;
    const pages = await Promise.all(targets.map((item, index) => Promise.resolve(this.store.history({
      userId: input.userId, agentId: input.agentId, memoryId: item.memory.id, taskId: input.taskId, includePrivate: input.includePrivate,
      limit: baseLimit + (index < remainder ? 1 : 0), cursor: undefined,
    }))));
    pages.forEach((page, index) => { if (page.nextCursor) truncatedMemoryIds.add(targets[index]!.memory.id); });
    const events = pages.flatMap((page) => page.events).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return { events, truncatedMemoryIds, truncated: truncatedMemoryIds.size > 0 };
  }

  private async withDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new StepTimeoutError();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new StepTimeoutError()), remaining); timer.unref?.(); })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
