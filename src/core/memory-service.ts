import { agenticQueryInputSchema, contextPackInputSchema, forgetInputSchema, handoffCreateInputSchema, handoffResumeInputSchema, historyInputSchema, recallInputSchema, rememberInputSchema, storedHandoffCapsuleSchema, type AgenticQueryInput, type ContextPackInput, type ForgetInput, type HandoffCapsule, type HandoffCreateInput, type HandoffResumeInput, type HistoryInput, type RecallInput, type RememberInput } from "../shared/types.js";
import { AgenticQueryEngine, resolveAgenticQueryPolicy, type AgenticQueryPolicy } from "./agentic-query.js";
import { ContextPackBuilder, type ContextPackPolicy } from "./context-pack.js";
import { InMemoryStore, type MemoryStore } from "./memory-store.js";
import { RetrievalPipeline, type RetrievalPipelineOptions } from "./retrieval.js";
import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../shared/errors.js";
import { ReadDeadline, ReadRuntime, type ReadRuntimeObserver, type ReadRuntimePolicy } from "./read-runtime.js";

const DEFAULT_CONTEXT_PACK_POLICY: ContextPackPolicy = { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 };
const DEFAULT_AGENTIC_QUERY_POLICY: AgenticQueryPolicy = { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 1500, maxTimeoutMs: 5000, maxSubqueries: 3, historyLimit: 50 };

export class MemoryService {
  private readonly retrieval: RetrievalPipeline;
  private readonly contextPack: ContextPackBuilder;
  private readonly agenticQuery: AgenticQueryEngine;
  private readonly runtime: ReadRuntime;
  private closePromise?: Promise<void>;

  constructor(private readonly store: MemoryStore = new InMemoryStore(), retrievalOptions: RetrievalPipelineOptions = {}, contextPackPolicy: ContextPackPolicy = DEFAULT_CONTEXT_PACK_POLICY, private readonly agenticQueryPolicy: AgenticQueryPolicy = DEFAULT_AGENTIC_QUERY_POLICY,
    runtimePolicy: ReadRuntimePolicy = {}, observer?: ReadRuntimeObserver) {
    this.runtime = new ReadRuntime(runtimePolicy, observer);
    this.agenticQueryPolicy = resolveAgenticQueryPolicy(agenticQueryPolicy);
    const reads = this.runtime.guard(store);
    this.retrieval = new RetrievalPipeline(reads, retrievalOptions);
    this.contextPack = new ContextPackBuilder(this.retrieval, contextPackPolicy);
    this.agenticQuery = new AgenticQueryEngine(reads, this.retrieval, this.contextPack.capabilityPolicy(), this.agenticQueryPolicy);
  }
  supportsFactDeclarations(): boolean { return typeof this.store.readFactGroup === "function"; }
  retrievalCapabilityPolicy() { return this.retrieval.capabilityPolicy(); }
  contextCapabilityPolicy() { return this.contextPack.capabilityPolicy(); }
  readRuntimeCapabilities() { return this.runtime.capabilities(); }
  readRuntimeStatus() { return this.runtime.snapshot(); }
  queryCapabilityPolicy() { return { ...this.agenticQueryPolicy }; }
  async remember(input: RememberInput) {
    this.runtime.assertOpen();
    const parsed = rememberInputSchema.parse(input);
    if (parsed.fact && !this.supportsFactDeclarations()) throw new OpenContinuityError("VALIDATION_ERROR", "Store does not support explicit fact declarations", 400);
    const receipt = await this.runtime.write(() => this.store.appendRemember(parsed));
    if (parsed.fact && (!isDeepStrictEqual(receipt.current.fact, parsed.fact) || !isDeepStrictEqual(receipt.event.fact, parsed.fact))) {
      throw new OpenContinuityError("STORAGE_ERROR", "Store violated the fact declaration contract", 500);
    }
    return receipt;
  }
  async recall(input: RecallInput) { const parsed = recallInputSchema.parse(input); return this.runtime.run("recall", () => this.retrieval.recall(parsed)); }
  async context(input: ContextPackInput) { const parsed = contextPackInputSchema.parse(input); return this.runtime.run("context", () => this.contextPack.build(parsed)); }
  async query(input: AgenticQueryInput) { const parsed = agenticQueryInputSchema.parse(input); return this.runtime.run("query", () => this.agenticQuery.query(parsed, this.runtime.deadline()), parsed.timeoutMs ?? this.agenticQueryPolicy.defaultTimeoutMs, true); }
  async forget(input: ForgetInput) { const value = forgetInputSchema.parse(input); return this.runtime.write(() => this.store.appendForget(value.userId, value.agentId, value.memoryId, value.taskId, value.includePrivate)); }
  async history(input: HistoryInput) { const parsed = historyInputSchema.parse(input); return this.runtime.run("history", async () => this.runtime.guard(this.store).history(parsed)); }
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
    return this.runtime.run("handoff_resume", async () => {
      const result = await this.retrieval.recall(recallInputSchema.parse({ ...value, key: `handoff:${value.taskId}`, scope: "task", limit: 1 }));
      const memory = result.memories[0] ?? null;
      if (!memory) return { capsule: null, memory: null, status: "not_found" as const };
      const storedCapsule = storedHandoffCapsuleSchema.parse(memory.value);
      const capsule: HandoffCapsule = { ...storedCapsule, createdAt: memory.updatedAt };
      if (capsule.expiresAt && Date.parse(capsule.expiresAt) <= Date.now()) {
        return { capsule: null, memory: null, status: "expired" as const };
      }
      return { capsule, memory, status: "ready" as const };
    });
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.runtime.beginClose();
    this.closePromise = Promise.resolve().then(() => this.store.close?.());
    await this.closePromise;
  }
  async closeGracefully(timeoutMs = 5000) {
    const budget = new ReadDeadline(timeoutMs);
    while (true) {
      try { await budget.wait(() => this.close()); return; }
      catch (error) {
        if (!(error instanceof OpenContinuityError) || error.code !== "RUNTIME_BUSY") throw error;
        await budget.wait(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
      }
    }
  }
}
