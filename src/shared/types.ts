import { z } from "zod";

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

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object") return Object.getPrototypeOf(value) === Object.prototype && Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}

export const jsonValueSchema = z.unknown().refine(isJsonValue, "value must be JSON-serializable");
export const jsonMetadataSchema = z.record(z.string(), z.unknown()).refine(isJsonValue, "metadata must be JSON-serializable");

export const rememberInputSchema = z.object({
  userId: z.string().min(1), agentId: z.string().min(1), key: z.string().min(1), value: jsonValueSchema,
  kind: memoryKindSchema, scope: memoryScopeSchema.default("user"), taskId: z.string().min(1).optional(),
  sensitivity: sensitivitySchema.default("public"), userConfirmed: z.boolean().default(false),
  idempotencyKey: z.string().min(1), metadata: jsonMetadataSchema.default({}),
  writeMode: memoryWriteModeSchema.default("replace"), expectedVersion: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(), confidenceBasis: memoryConfidenceBasisSchema.optional(),
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
});
export interface ResolvedMemory {
  id: string; key: string; value: unknown; kind: MemoryKind; scope: MemoryScope; taskId?: string; ownerAgentId?: string; sensitivity: Sensitivity; userConfirmed: boolean; sourceEventId: string; sourceAgentId: string; updatedAt: string; version: number;
  supersedes?: MemorySupersedes; confidence?: MemoryConfidence;
  retrieval?: { score: number; channels: RetrievalChannel[]; ranks: Partial<Record<RetrievalChannel, number>> };
}
export interface MemoryReceipt { event: MemoryEvent; duplicate: boolean; current: ResolvedMemory; evolution?: MemoryEvolutionReceipt; }
export interface RecallResult {
  memories: ResolvedMemory[];
  nextCursor: string | null;
  retrieval?: { mode: "hybrid"; channels: RetrievalChannel[]; candidateCount: number; candidateLimit: number };
}
export interface HistoryResult { events: MemoryEvent[]; nextCursor: string | null; }
export type ContextSelectionReason = "retrieval_exact" | "retrieval_structured" | "retrieval_full_text" | "task_scope" | "agent_scope" | "user_confirmed" | `purpose_${ContextPurpose}`;
export interface ContextPackItem {
  memoryId: string; key: string; value: unknown; kind: MemoryKind; scope: MemoryScope; taskId?: string;
  estimatedTokens: number; priority: number; reasons: ContextSelectionReason[]; sourceEventId: string; sourceAgentId: string; updatedAt: string; version: number; supersedes?: MemorySupersedes; confidence?: MemoryConfidence;
}
export interface ContextPackOmission { memoryId: string; key: string; estimatedTokens: number; reason: "token_budget" | "max_memories"; }
export interface ContextPackResult {
  context: string; items: ContextPackItem[]; omitted: ContextPackOmission[];
  budget: { requestedTokens: number; usedTokens: number; remainingTokens: number; maxMemories: number; estimation: "utf8_bytes_v1" };
  retrieval?: RecallResult["retrieval"];
}
export interface AgenticQueryPlanStep { id: string; type: "recall" | "history"; query?: string; reason: string; }
export interface AgenticQueryStepReceipt extends AgenticQueryPlanStep {
  status: "completed" | "skipped" | "timed_out"; candidateCount: number; durationMs: number; detail?: string;
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
  fallback: { used: boolean; reasons: Array<"unsupported_complexity" | "subquery_limit" | "history_limit" | "max_steps" | "timeout" | "insufficient_evidence">; mode: "deterministic" };
}
