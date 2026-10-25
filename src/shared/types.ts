import { z } from "zod";
import type { CandidateSearchResult, ScoredSearchHit } from "../core/candidate-search.js";

export const memoryKindSchema = z.enum(["user_preference", "user_fact", "task_state", "decision"]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export const memoryScopeSchema = z.enum(["user", "task", "agent"]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const sensitivitySchema = z.enum(["public", "private"]);
export type Sensitivity = z.infer<typeof sensitivitySchema>;
export const retrievalChannelSchema = z.enum(["exact", "structured", "full_text"]);
export type RetrievalChannel = z.infer<typeof retrievalChannelSchema>;
export const contextPurposeSchema = z.enum(["general", "coding", "research", "browser"]);
export type ContextPurpose = z.infer<typeof contextPurposeSchema>;
export const memoryWriteModeSchema = z.enum(["replace", "merge"]);
export type MemoryWriteMode = z.infer<typeof memoryWriteModeSchema>;
export const memoryConfidenceBasisSchema = z.enum(["user_asserted", "agent_inferred", "source_supported"]);
export type MemoryConfidenceBasis = z.infer<typeof memoryConfidenceBasisSchema>;
export interface MemoryConfidence { score: number; basis: MemoryConfidenceBasis; }
export const memoryFactSchema = z.object({
  group: z.string().trim().min(1).max(128).refine(value => !value.includes("\0"), "group cannot contain NUL"),
  validFrom: z.iso.datetime({ offset: true }).optional(),
  validUntil: z.iso.datetime({ offset: true }).optional(),
  supersedes: z.array(z.object({ memoryId: z.string().min(1).max(128), sourceEventId: z.string().min(1).max(128), version: z.number().int().min(1) }).strict()).max(16).default([]),
}).strict().superRefine((fact, context) => {
  if (fact.validFrom && fact.validUntil && Date.parse(fact.validFrom) >= Date.parse(fact.validUntil)) {
    context.addIssue({ code: "custom", path: ["validUntil"], message: "validUntil must be after validFrom" });
  }
  if (new Set(fact.supersedes.map(ref => ref.memoryId)).size !== fact.supersedes.length) {
    context.addIssue({ code: "custom", path: ["supersedes"], message: "replacement targets must be unique" });
  }
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;
export type FactStatus = "unannotated" | "active_assertion" | "consistent_assertions" | "not_yet_valid" | "expired" | "superseded" | "conflict" | "unresolved";
export interface FactAssessment {
  policy: "explicit-facts-v1"; evaluatedAt: string; status: FactStatus; usable: boolean;
  coverage: "visible_filtered_group" | "truncated" | "unsupported" | "not_applicable";
  reason: "legacy_unverified" | "single_visible_assertion" | "equal_visible_values" | "validity_start" | "validity_end" | "verified_replacement" | "different_visible_values" | "unverified_reference" | "replacement_cycle" | "group_budget" | "store_unsupported";
}
export type MemoryEvolutionAction = "created" | "replaced" | "merged";
export interface MemorySupersedes { eventId: string; version: number; }
export interface MemoryEvolutionReceipt {
  action: MemoryEvolutionAction; version: number; writeMode: MemoryWriteMode;
  concurrency: "last_write_wins" | "compare_and_set"; supersedes?: MemorySupersedes;
}
export const queryStrategySchema = z.enum(["auto", "direct", "multi_step"]);
export type QueryStrategy = z.infer<typeof queryStrategySchema>;
export type QueryComplexity = "L0" | "L1" | "L2" | "L3";
export const handoffStatusSchema = z.enum(["ready", "blocked", "in_progress"]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object") {
    if (ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && isJsonValue(value[index], ancestors)).every(Boolean);
      return Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, ancestors));
    } finally { ancestors.delete(value); }
  }
  return false;
}

export const jsonValueSchema = z.unknown().refine((value) => isJsonValue(value), "value must be JSON-serializable").transform((value) => JSON.parse(JSON.stringify(value)) as unknown);
export const jsonMetadataSchema = z.record(z.string(), z.unknown()).refine((value) => isJsonValue(value), "metadata must be JSON-serializable").transform((value) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>);

export const rememberInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), key: z.string().min(1), value: jsonValueSchema,
  kind: memoryKindSchema, scope: memoryScopeSchema.default("user"), taskId: z.string().min(1).optional(),
  sensitivity: sensitivitySchema.default("public"), userConfirmed: z.boolean().default(false),
  idempotencyKey: z.string().min(1), metadata: jsonMetadataSchema.default({}),
  writeMode: memoryWriteModeSchema.default("replace"), expectedVersion: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(), confidenceBasis: memoryConfidenceBasisSchema.optional(),
  fact: memoryFactSchema.optional(),
}).superRefine((input, context) => {
  if (input.scope === "task" && !input.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is required when scope is task" });
  }
  if (input.scope !== "task" && input.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is only allowed when scope is task" });
  }
  if ((input.confidence === undefined) !== (input.confidenceBasis === undefined)) {
    context.addIssue({ code: "custom", path: [input.confidence === undefined ? "confidence" : "confidenceBasis"], message: "confidence and confidenceBasis must be provided together" });
  }
  if (input.confidenceBasis === "user_asserted" && !input.userConfirmed) {
    context.addIssue({ code: "custom", path: ["confidenceBasis"], message: "user_asserted confidence requires userConfirmed=true" });
  }
  if (input.fact && (!input.userConfirmed || input.expectedVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["fact"], message: "fact declarations require userConfirmed and expectedVersion" });
  }
});
export type RememberInput = z.input<typeof rememberInputSchema>;
export type ParsedRememberInput = z.output<typeof rememberInputSchema>;

export const recallInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), query: z.string().optional(), key: z.string().min(1).optional(),
  kind: memoryKindSchema.optional(), scope: memoryScopeSchema.optional(), taskId: z.string().min(1).optional(),
  includePrivate: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).optional(),
}).superRefine((input, context) => {
  if (input.scope === "task" && !input.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is required when filtering task-scoped memory" });
  }
});
export type RecallInput = z.input<typeof recallInputSchema>;
export type ParsedRecallInput = z.output<typeof recallInputSchema>;

export const contextPackInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), query: z.string().min(1),
  key: z.string().min(1).optional(), kind: memoryKindSchema.optional(), scope: memoryScopeSchema.optional(), taskId: z.string().min(1).optional(),
  includePrivate: z.boolean().default(false), purpose: contextPurposeSchema.default("general"),
  tokenBudget: z.number().int().min(64).max(32768).optional(), maxMemories: z.number().int().min(1).max(100).optional(),
}).superRefine((input, context) => {
  if (input.scope === "task" && !input.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is required when filtering task-scoped memory" });
  }
});
export type ContextPackInput = z.input<typeof contextPackInputSchema>;
export type ParsedContextPackInput = z.output<typeof contextPackInputSchema>;
export const agenticQueryInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), query: z.string().min(1),
  key: z.string().min(1).optional(), kind: memoryKindSchema.optional(), scope: memoryScopeSchema.optional(), taskId: z.string().min(1).optional(),
  includePrivate: z.boolean().default(false), purpose: contextPurposeSchema.default("general"),
  tokenBudget: z.number().int().min(64).max(32768).optional(), maxMemories: z.number().int().min(1).max(100).optional(),
  strategy: queryStrategySchema.default("auto"), subqueries: z.array(z.string().min(1)).min(1).max(8).optional(),
  includeHistory: z.boolean().default(false), maxSteps: z.number().int().min(1).max(8).optional(),
  timeoutMs: z.number().int().min(10).max(30000).optional(), minEvidence: z.number().int().min(1).max(20).default(1),
}).superRefine((input, context) => {
  if (input.scope === "task" && !input.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is required when filtering task-scoped memory" });
  }
  if (input.strategy === "direct" && input.subqueries && input.subqueries.length > 1) {
    context.addIssue({ code: "custom", path: ["subqueries"], message: "direct strategy accepts at most one subquery" });
  }
  if (input.strategy === "direct" && input.includeHistory) {
    context.addIssue({ code: "custom", path: ["includeHistory"], message: "direct strategy cannot include a history expansion step" });
  }
});
export type AgenticQueryInput = z.input<typeof agenticQueryInputSchema>;
export type ParsedAgenticQueryInput = z.output<typeof agenticQueryInputSchema>;
export const forgetInputSchema = z.object({ userId: z.string().min(1), agentId: z.string().min(1), memoryId: z.string().min(1), taskId: z.string().min(1).optional(), includePrivate: z.boolean().default(false) });
export type ForgetInput = z.input<typeof forgetInputSchema>;

export const historyInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), memoryId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(), includePrivate: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).optional(),
});
export type HistoryInput = z.input<typeof historyInputSchema>;
export type ParsedHistoryInput = z.output<typeof historyInputSchema>;

export const handoffCreateInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1),
  summary: z.string().min(1), status: handoffStatusSchema.default("ready"),
  decisions: z.array(z.string().min(1)).max(50).default([]),
  nextActions: z.array(z.string().min(1)).max(50).default([]),
  artifacts: z.array(z.string().min(1)).max(100).default([]),
  blockedBy: z.array(z.string().min(1)).max(50).default([]),
  expiresAt: z.iso.datetime({ offset: true }).optional(), sensitivity: sensitivitySchema.default("public"),
  idempotencyKey: z.string().min(1), metadata: jsonMetadataSchema.default({}),
}).superRefine((input, context) => {
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be in the future" });
  }
});
export type HandoffCreateInput = z.input<typeof handoffCreateInputSchema>;
export type ParsedHandoffCreateInput = z.output<typeof handoffCreateInputSchema>;

export const handoffResumeInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), taskId: z.string().min(1),
  includePrivate: z.boolean().default(false),
});
export type HandoffResumeInput = z.input<typeof handoffResumeInputSchema>;

export const storedHandoffCapsuleSchema = z.object({
  schemaVersion: z.literal("1.0"), taskId: z.string().min(1), summary: z.string().min(1), status: handoffStatusSchema,
  decisions: z.array(z.string()), nextActions: z.array(z.string()), artifacts: z.array(z.string()), blockedBy: z.array(z.string()),
  sourceAgentId: z.string().min(1), expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type HandoffCapsule = z.infer<typeof storedHandoffCapsuleSchema> & { createdAt: string };
export interface HandoffCreateResult { capsule: HandoffCapsule; memory: MemoryReceipt; }
export interface HandoffResumeResult { capsule: HandoffCapsule | null; memory: ResolvedMemory | null; status: "ready" | "not_found" | "expired"; }

export interface MemoryEvent {
  id: string; userId: string; agentId: string; type: "memory_remembered" | "memory_forgotten"; memoryId: string; key: string; value?: unknown; inputValue?: unknown; kind: MemoryKind; scope: MemoryScope; taskId?: string; sensitivity: Sensitivity; userConfirmed: boolean; idempotencyKey: string; createdAt: string; metadata: Record<string, unknown>;
  memoryVersion?: number; evolutionAction?: MemoryEvolutionAction; writeMode?: MemoryWriteMode; expectedVersion?: number; supersedes?: MemorySupersedes; confidence?: MemoryConfidence;
  fact?: MemoryFact;
}
export const memoryEventSchema: z.ZodType<MemoryEvent> = z.object({
  id: z.string().min(1), userId: z.string().min(1), agentId: z.string().min(1),
  type: z.enum(["memory_remembered", "memory_forgotten"]), memoryId: z.string().min(1), key: z.string().min(1),
  value: jsonValueSchema.optional(), inputValue: jsonValueSchema.optional(), kind: memoryKindSchema, scope: memoryScopeSchema, taskId: z.string().min(1).optional(),
  sensitivity: sensitivitySchema, userConfirmed: z.boolean(), idempotencyKey: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }), metadata: jsonMetadataSchema, memoryVersion: z.number().int().min(1).optional(),
  evolutionAction: z.enum(["created", "replaced", "merged"]).optional(), writeMode: memoryWriteModeSchema.optional(),
  expectedVersion: z.number().int().min(0).optional(),
  supersedes: z.object({ eventId: z.string().min(1), version: z.number().int().min(1) }).optional(),
  confidence: z.object({ score: z.number().min(0).max(1), basis: memoryConfidenceBasisSchema }).optional(),
  fact: memoryFactSchema.optional(),
}).superRefine((event, context) => {
  if (event.type === "memory_remembered" && event.value === undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "value is required for memory_remembered events" });
  }
  if (event.type === "memory_forgotten" && event.value !== undefined) {
    context.addIssue({ code: "custom", path: ["value"], message: "value is not allowed for memory_forgotten events" });
  }
  if (event.scope === "task" && !event.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is required when scope is task" });
  }
  if (event.scope !== "task" && event.taskId) {
    context.addIssue({ code: "custom", path: ["taskId"], message: "taskId is only allowed when scope is task" });
  }
  if (event.type === "memory_forgotten" && (event.inputValue !== undefined || event.evolutionAction !== undefined || event.writeMode !== undefined || event.expectedVersion !== undefined || event.supersedes !== undefined || event.confidence !== undefined)) {
    context.addIssue({ code: "custom", path: ["evolutionAction"], message: "evolution fields are only allowed for memory_remembered events" });
  }
  if (event.fact && (event.type !== "memory_remembered" || !event.userConfirmed || event.expectedVersion === undefined)) {
    context.addIssue({ code: "custom", path: ["fact"], message: "fact declarations require a confirmed CAS remember event" });
  }
});
export interface ResolvedMemory {
  id: string; key: string; value: unknown; kind: MemoryKind; scope: MemoryScope; taskId?: string; ownerAgentId?: string; sensitivity: Sensitivity; userConfirmed: boolean; sourceEventId: string; sourceAgentId: string; updatedAt: string; version: number;
  supersedes?: MemorySupersedes; confidence?: MemoryConfidence;
  fact?: MemoryFact;
  retrieval?: MemoryRetrieval;
}
export interface MemoryRetrieval {
  /** Compatibility positional score, never a probability or the raw BM25 value. */
  score: number; channels: RetrievalChannel[]; ranks: Partial<Record<RetrievalChannel, number>>;
  rankingVersion?: "core-ranking-v2";
  scoreModel?: "rrf" | "rank_reciprocal" | "query_sum";
  fusedScore?: number | null;
  exactTier?: number;
  evidence?: Array<Omit<ScoredSearchHit, "memory"> & { implementation: CandidateSearchResult["implementation"]; contribution: number; query?: string; stepId?: string }>;
  selectionReasons?: Array<"query_match" | "exact_key_precedence" | "independent_rank_fusion" | "single_channel_order" | "best_channel_rank" | "structured_eligibility" | "current_memory_snapshot">;
  factAssessment?: FactAssessment;
}
export interface MemoryReceipt { event: MemoryEvent; duplicate: boolean; current: ResolvedMemory; evolution?: MemoryEvolutionReceipt; }
export interface RecallResult {
  memories: ResolvedMemory[];
  nextCursor: string | null;
  retrieval?: { mode: "hybrid"; channels: RetrievalChannel[]; candidateCount: number; candidateLimit: number;
    rankingVersion?: "core-ranking-v2"; path?: "scored_candidates"; truncated?: boolean;
    channelResults?: Array<Omit<CandidateSearchResult, "hits"> & { candidateCount: number }>;
    factReview?: { policy: "explicit-facts-v1"; evaluatedAt: string; groupLimit: number; reviewedGroups: number;
      omitted: Array<{ memoryId: string; assessment: FactAssessment }> } };
}
export interface HistoryResult { events: MemoryEvent[]; nextCursor: string | null; }
export type ContextSelectionReason = "retrieval_exact" | "retrieval_structured" | "retrieval_full_text" | "task_scope" | "agent_scope" | "user_confirmed" | `purpose_${ContextPurpose}`;
export interface ContextPackItem {
  memoryId: string; key: string; value: unknown; kind: MemoryKind; scope: MemoryScope; taskId?: string;
  estimatedTokens: number; priority: number; reasons: ContextSelectionReason[]; sourceEventId: string; sourceAgentId: string; updatedAt: string; version: number; supersedes?: MemorySupersedes; confidence?: MemoryConfidence;
  retrieval?: MemoryRetrieval;
  fact?: MemoryFact;
}
export interface ContextPackOmission { memoryId: string; key: string; estimatedTokens: number; reason: "token_budget" | "max_memories" | "fact_unresolved"; }
export interface ContextPackResult {
  context: string; items: ContextPackItem[]; omitted: ContextPackOmission[];
  budget: { requestedTokens: number; usedTokens: number; remainingTokens: number; maxMemories: number; estimation: "utf8_bytes_v1" };
  retrieval?: RecallResult["retrieval"];
}
export interface AgenticQueryPlanStep { id: string; type: "recall" | "history"; query?: string; reason: string; }
export interface AgenticQueryStepReceipt extends AgenticQueryPlanStep {
  status: "completed" | "skipped" | "timed_out"; candidateCount: number; durationMs: number; detail?: string;
  factReview?: NonNullable<RecallResult["retrieval"]>["factReview"];
}
export interface AgenticEvidence {
  memory: ResolvedMemory; matchedQueries: string[]; stepIds: string[]; score: number;
  history?: { eventCount: number; versions: number[]; eventIds: string[]; truncated: boolean };
}
export interface AgenticQueryResult {
  plan: { id: string; complexity: QueryComplexity; strategy: Exclude<QueryStrategy, "auto">; rationale: string[]; steps: AgenticQueryPlanStep[] };
  steps: AgenticQueryStepReceipt[]; evidence: AgenticEvidence[]; contextPack: ContextPackResult;
  sufficiency: { status: "sufficient" | "partial" | "insufficient"; matchedQueries: number; totalQueries: number; evidenceCount: number; reasons: string[] };
  execution: { maxSteps: number; completedSteps: number; timeoutMs: number; elapsedMs: number; stoppedReason: "completed" | "max_steps" | "timeout" };
  factReview?: NonNullable<RecallResult["retrieval"]>["factReview"];
  fallback: { used: boolean; reasons: Array<"unsupported_complexity" | "subquery_limit" | "history_limit" | "max_steps" | "timeout" | "insufficient_evidence">; mode: "deterministic" };
}
