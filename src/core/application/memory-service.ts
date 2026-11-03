import { isDeepStrictEqual } from "node:util";
import { OpenContinuityError } from "../../shared/errors.js";
import { agenticQueryInputSchema, contextPackInputSchema, forgetInputSchema, handoffCreateInputSchema, handoffResumeInputSchema, historyInputSchema, recallInputSchema, rememberInputSchema, type AgenticQueryInput, type ContextPackInput, type ForgetInput, type HandoffCreateInput, type HandoffResumeInput, type HistoryInput, type RecallInput, type RememberInput } from "../../shared/types.js";
import { InMemoryStore } from "../../storage/inmemory/store.js";
import { ContextPackBuilder, type ContextPackPolicy } from "../context/pack.js";
import { type MemoryStore } from "../memory/contracts.js";
import { createHandoffRecord, resumeHandoffRecord } from "../memory/handoff.js";
import { confirmedHandoffInput, handoffPrepareInputSchema, prepareHandoffRecord, type HandoffConfirmInput, type HandoffPrepareInput } from "../memory/handoff/review.js";
import { HANDOFF_REVIEW_VERSION } from "../memory/handoff/contracts.js";
import { AgenticQueryEngine, resolveAgenticQueryPolicy, type AgenticQueryPolicy } from "../query/engine.js";
import { RetrievalPipeline, type RetrievalPipelineOptions } from "../retrieval/pipeline.js";
import { ReadDeadline, ReadRuntime, type ReadRuntimeObserver, type ReadRuntimePolicy } from "../runtime/read-runtime.js";

const DEFAULT_CONTEXT_PACK_POLICY: ContextPackPolicy = { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 };
const DEFAULT_AGENTIC_QUERY_POLICY: AgenticQueryPolicy = { defaultMaxSteps: 3, maxSteps: 4, defaultTimeoutMs: 1500, maxTimeoutMs: 5000, maxSubqueries: 3, historyLimit: 50 };

export class MemoryService {
  private readonly retrieval: RetrievalPipeline;
  private readonly contextPack: ContextPackBuilder;
  private readonly agenticQuery: AgenticQueryEngine;
  private readonly runtime: ReadRuntime;
  private readonly experimentalDense?: RetrievalPipelineOptions["experimentalDense"];
  private closePromise?: Promise<void>;

  constructor(private readonly store: MemoryStore = new InMemoryStore(), retrievalOptions: RetrievalPipelineOptions = {}, contextPackPolicy: ContextPackPolicy = DEFAULT_CONTEXT_PACK_POLICY, private readonly agenticQueryPolicy: AgenticQueryPolicy = DEFAULT_AGENTIC_QUERY_POLICY,
    runtimePolicy: ReadRuntimePolicy = {}, observer?: ReadRuntimeObserver) {
    this.experimentalDense = retrievalOptions.experimentalDense;
    this.runtime = new ReadRuntime(runtimePolicy, observer);
    this.agenticQueryPolicy = resolveAgenticQueryPolicy(agenticQueryPolicy);
    const reads = this.runtime.guard(store);
    const dense = retrievalOptions.experimentalDense;
    this.retrieval = new RetrievalPipeline(reads, { ...retrievalOptions, ...(dense ? { experimentalDense: {
      mode: dense.mode, fingerprint: () => dense.fingerprint(),
      retrieve: (input, lexical) => this.runtime.read("dense", () => dense.retrieve(input, lexical, this.runtime.deadline()))
    } } : {}) });
    this.contextPack = new ContextPackBuilder(this.retrieval, contextPackPolicy);
    this.agenticQuery = new AgenticQueryEngine(reads, this.retrieval, this.contextPack.capabilityPolicy(), this.agenticQueryPolicy);
  }
  supportsFactDeclarations(): boolean { return typeof this.store.readFactGroup === "function"; }
  supportsReviewedHandoff(): boolean { return this.store.handoffReviewVersion === HANDOFF_REVIEW_VERSION; }
  private requireReviewedHandoff() {
    if (!this.supportsReviewedHandoff()) throw new OpenContinuityError("VALIDATION_ERROR", "Store does not support atomic reviewed handoffs", 400);
  }
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
  /** Explicit Core experiment operation. No automatic indexing/downloads from public MCP tools. */
  async synchronizeDenseIndex(input: RecallInput, maximumJobs = 100) {
    const parsed = recallInputSchema.parse(input);
    if (!this.experimentalDense?.synchronize) throw new OpenContinuityError("VALIDATION_ERROR", "Dense indexing is not configured", 400);
    const { cursor: _cursor, ...request } = parsed;
    return this.runtime.write(() => this.experimentalDense!.synchronize!(request, maximumJobs));
  }
  async context(input: ContextPackInput) { const parsed = contextPackInputSchema.parse(input); return this.runtime.run("context", () => this.contextPack.build(parsed)); }
  async query(input: AgenticQueryInput) { const parsed = agenticQueryInputSchema.parse(input); return this.runtime.run("query", () => this.agenticQuery.query(parsed, this.runtime.deadline()), parsed.timeoutMs ?? this.agenticQueryPolicy.defaultTimeoutMs, true); }
  async forget(input: ForgetInput) { const value = forgetInputSchema.parse(input); return this.runtime.write(() => this.store.appendForget(value.userId, value.agentId, value.memoryId, value.taskId, value.includePrivate)); }
  async history(input: HistoryInput) { const parsed = historyInputSchema.parse(input); return this.runtime.run("history", async () => this.runtime.guard(this.store).history(parsed)); }
  async createHandoff(input: HandoffCreateInput) { const value = handoffCreateInputSchema.parse(input); return createHandoffRecord(value, input => this.remember(input)); }
  async prepareHandoff(input: HandoffPrepareInput) {
    this.requireReviewedHandoff();
    const value = handoffPrepareInputSchema.parse(input);
    return this.runtime.run("handoff_prepare", () => prepareHandoffRecord(value, this.retrieval));
  }
  async confirmHandoff(input: HandoffConfirmInput) {
    this.requireReviewedHandoff();
    return this.createHandoff(confirmedHandoffInput(input));
  }
  async resumeHandoff(input: HandoffResumeInput) { const value = handoffResumeInputSchema.parse(input); return this.runtime.run("handoff_resume", () => resumeHandoffRecord(value, this.retrieval)); }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.runtime.beginClose();
    this.closePromise = Promise.resolve().then(async () => {
      await this.experimentalDense?.close?.();
      await this.store.close?.();
    });
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
