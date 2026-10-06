import { agenticQueryInputSchema, contextPackInputSchema, forgetInputSchema, handoffCreateInputSchema, handoffResumeInputSchema, historyInputSchema, recallInputSchema, rememberInputSchema, storedHandoffCapsuleSchema, type AgenticQueryInput, type ContextPackInput, type ForgetInput, type HandoffCapsule, type HandoffCreateInput, type HandoffResumeInput, type HistoryInput, type RecallInput, type RememberInput } from "../shared/types.js";
import { AgenticQueryEngine, type AgenticQueryPolicy } from "./agentic-query.js";
import { ContextPackBuilder, type ContextPackPolicy } from "./context-pack.js";
import { InMemoryStore, type MemoryStore } from "./memory-store.js";
import { RetrievalPipeline, type RetrievalPipelineOptions } from "./retrieval.js";

const DEFAULT_CONTEXT_PACK_POLICY: ContextPackPolicy = { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 };
const DEFAULT_AGENTIC_QUERY_POLICY: AgenticQueryPolicy = { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 1500, maxTimeoutMs: 5000, maxSubqueries: 3, historyLimit: 50 };

export class MemoryService {
  private readonly retrieval: RetrievalPipeline;
  private readonly contextPack: ContextPackBuilder;
  private readonly agenticQuery: AgenticQueryEngine;

  constructor(private readonly store: MemoryStore = new InMemoryStore(), retrievalOptions: RetrievalPipelineOptions = {}, contextPackPolicy: ContextPackPolicy = DEFAULT_CONTEXT_PACK_POLICY, agenticQueryPolicy: AgenticQueryPolicy = DEFAULT_AGENTIC_QUERY_POLICY) {
    this.retrieval = new RetrievalPipeline(store, retrievalOptions);
    this.contextPack = new ContextPackBuilder(this.retrieval, contextPackPolicy);
    this.agenticQuery = new AgenticQueryEngine(store, this.retrieval, contextPackPolicy, agenticQueryPolicy);
  }
  async remember(input: RememberInput) { return this.store.appendRemember(rememberInputSchema.parse(input)); }
  async recall(input: RecallInput) { return this.retrieval.recall(recallInputSchema.parse(input)); }
  async context(input: ContextPackInput) { return this.contextPack.build(contextPackInputSchema.parse(input)); }
  async query(input: AgenticQueryInput) { return this.agenticQuery.query(agenticQueryInputSchema.parse(input)); }
  async forget(input: ForgetInput) { const value = forgetInputSchema.parse(input); return this.store.appendForget(value.userId, value.agentId, value.memoryId, value.taskId, value.includePrivate); }
  async history(input: HistoryInput) { return this.store.history(historyInputSchema.parse(input)); }
  async createHandoff(input: HandoffCreateInput) {
    const value = handoffCreateInputSchema.parse(input);
    const storedCapsule = {
      schemaVersion: "1.0" as const, taskId: value.taskId, summary: value.summary, status: value.status,
      decisions: value.decisions, nextActions: value.nextActions, artifacts: value.artifacts, blockedBy: value.blockedBy,
      sourceAgentId: value.agentId, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    };
    const memory = await this.remember({
      userId: value.userId, agentId: value.agentId, key: `handoff:${value.taskId}`, value: storedCapsule,
      kind: "task_state", scope: "task", taskId: value.taskId, sensitivity: value.sensitivity,
      userConfirmed: true, idempotencyKey: value.idempotencyKey, metadata: { ...value.metadata, openContinuityType: "handoff_capsule" },
    });
    const capsule: HandoffCapsule = { ...storedCapsule, createdAt: memory.event.createdAt };
    return { capsule, memory };
  }
  async resumeHandoff(input: HandoffResumeInput) {
    const value = handoffResumeInputSchema.parse(input);
    const result = await this.recall({ ...value, key: `handoff:${value.taskId}`, scope: "task", limit: 1 });
    const memory = result.memories[0] ?? null;
    if (!memory) return { capsule: null, memory: null, status: "not_found" as const };
    const storedCapsule = storedHandoffCapsuleSchema.parse(memory.value);
    const capsule: HandoffCapsule = { ...storedCapsule, createdAt: memory.updatedAt };
    if (capsule.expiresAt && Date.parse(capsule.expiresAt) <= Date.now()) {
      return { capsule: null, memory: null, status: "expired" as const };
    }
    return { capsule, memory, status: "ready" as const };
  }
  async close() { await this.store.close?.(); }
}
