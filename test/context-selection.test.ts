import { describe, expect, it } from "vitest";
import { ContextPackBuilder, type ContextPackPolicy } from "../src/core/context-pack.js";
import { resolveContextPackPolicy } from "../src/core/context-selection.js";
import { MemoryService } from "../src/core/memory-service.js";
import { InMemoryStore } from "../src/core/memory-store.js";
import { RetrievalPipeline } from "../src/core/retrieval.js";
import { contextPackInputSchema, type ResolvedMemory } from "../src/shared/types.js";

const input = contextPackInputSchema.parse({ userId: "fictional-context-user", agentId: "fictional-context-agent", taskId: "fictional-task", query: "needle", purpose: "coding" });
const policy: ContextPackPolicy = { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20 };
function memory(id: string, score = 1 / 61, extra: Partial<ResolvedMemory> = {}): ResolvedMemory {
  return { id, key: id, value: "fictional needle", kind: "user_fact", scope: "user", sensitivity: "public", userConfirmed: false,
    sourceEventId: `fictional-event-${id}`, sourceAgentId: input.agentId, version: 1, updatedAt: "2031-01-01T00:00:00.000Z",
    retrieval: { score, channels: ["full_text"], ranks: { full_text: 1 }, scoreModel: "rank_reciprocal", exactTier: 0 }, ...extra };
}
function builder(extra: Partial<ContextPackPolicy> = {}) { return new ContextPackBuilder(new RetrievalPipeline(new InMemoryStore()), { ...policy, ...extra }); }

describe("context-selection-v2", () => {
  it("does not allow task, confirmation or purpose weight to reverse unequal relevance", () => {
    const first = memory("first", 1 / 61);
    const second = memory("second", 1 / 62, { kind: "task_state", scope: "task", taskId: input.taskId, userConfirmed: true });
    const result = builder({ maxMemories: 1 }).buildFromMemories(input, [first, second]);
    expect(result.items.map(item => item.key)).toEqual(["first"]);
    expect(result.selection).toMatchObject({ version: "context-selection-v2", mode: "relevance_first", scopeBoostMax: 0, confirmationBoost: 0 });
    expect(result.items[0].priority).toBe(first.retrieval!.score);
    expect(result.items[0].selection).toMatchObject({ inputRank: 1, retrievalScore: 1 / 61, purposePreference: 5 });
    expect(builder({ selectionMode: "legacy_weighted", maxMemories: 1 }).buildFromMemories(input, [first, second]).items[0].key).toBe("second");
  });
  it("preserves an explicit exact tier even if another record has a much higher position score", () => {
    const exact = memory("exact", 0.001, { retrieval: { score: 0.001, channels: ["exact"], ranks: { exact: 2 }, exactTier: 1 } });
    expect(builder().buildFromMemories(input, [memory("text", 0.5), exact]).items.map(item => item.key)).toEqual(["exact", "text"]);
    expect(builder().buildFromMemories(input, [memory("text", 0.5), exact]).items[0].selection?.exactTier).toBe(1);
  });
  it("uses purpose only at an exact score/tier tie and supports its explicit ablation", () => {
    const state = memory("a", 0.02, { kind: "task_state" });
    const fact = memory("z", 0.02, { updatedAt: "2032-01-01T00:00:00.000Z" });
    expect(builder().buildFromMemories(input, [fact, state]).items.map(item => item.key)).toEqual(["a", "z"]);
    const ablated = builder({ selectionMode: "relevance_only" }).buildFromMemories(input, [fact, state]);
    expect(ablated.items.map(item => item.key)).toEqual(["z", "a"]);
    expect(ablated.items.every(item => item.selection?.purposePreference === 0)).toBe(true);
    const nearlyEqual = memory("higher", 0.02 + Number.EPSILON, { updatedAt: fact.updatedAt });
    expect(builder().buildFromMemories(input, [state, nearlyEqual]).items[0].key).toBe("higher");
  });
  it("does not infer an exact tier from the presence of an exact channel", () => {
    const disabled = memory("exact-disabled", 0.001, { retrieval: { score: 0.001, channels: ["exact"], ranks: { exact: 1 }, exactTier: 0 } });
    expect(builder().buildFromMemories(input, [disabled, memory("text", 0.02)]).items.map(item => item.key)).toEqual(["text", "exact-disabled"]);
  });
  it("uses updatedAt/id as deterministic tie-breaks and never mutates evidence", () => {
    const memories = [memory("a"), memory("z"), memory("b", 1 / 61, { updatedAt: "2032-01-01T00:00:00.000Z" })];
    const snapshot = structuredClone(memories);
    const pack = builder();
    const expected = ["b", "z", "a"];
    for (let i = 0; i < 5; i++) expect(pack.buildFromMemories(input, memories).items.map(item => item.key)).toEqual(expected);
    expect(memories).toEqual(snapshot);
    expect(pack.buildFromMemories(input, memories).items[0].retrieval).toEqual(memories[2].retrieval);
  });
  it("preserves upstream order when any candidate is missing a score, with an explicit fallback", () => {
    const candidates = [memory("first", 0.01), memory("missing", 0.02, { retrieval: undefined, kind: "task_state" }), memory("last", 0.5)];
    const pack = builder().buildFromMemories(input, candidates);
    expect(pack.items.map(item => item.key)).toEqual(["first", "missing", "last"]);
    expect(pack.selection).toMatchObject({ order: "input_order", priorityModel: "input_position", fallbackReason: "missing_retrieval_score", purposePreferenceMax: 0 });
    expect(pack.items[1].selection?.retrievalScore).toBeNull();
  });
  it("keeps confirmation a gate, reports counts only, and leaves ordinary context compatible", () => {
    const candidates = [memory("approved", 0.01, { userConfirmed: true }), memory("pending", 0.1)];
    expect(builder().buildFromMemories(input, candidates).items.map(item => item.key)).toEqual(["pending", "approved"]);
    const result = builder({ requireUserConfirmed: true }).buildFromMemories(input, candidates);
    expect(result.items.map(item => item.key)).toEqual(["approved"]);
    expect(result.selection).toMatchObject({ inputCount: 2, eligibleCount: 1, confirmationFilteredCount: 1 });
    expect(JSON.stringify(result)).not.toContain("pending");
    expect(builder({ requireUserConfirmed: true }).buildFromMemories(input, [...candidates].reverse()).items[0].selection?.inputRank).toBe(2);
  });
  it("rejects nonfinite/negative scores or invalid tiers without echoing content", () => {
    for (const score of [NaN, Infinity, -0.1]) expect(() => builder().buildFromMemories(input, [memory("fictional-secret", score)])).toThrow("Invalid context candidate evidence");
    const wrong = memory("tier", 0.01, { retrieval: { score: 0.01, channels: [], ranks: {}, exactTier: 2 } });
    expect(() => builder().buildFromMemories(input, [wrong])).toThrow("Invalid context candidate evidence");
  });
  it("defensively rejects private and foreign scope candidates from a broken upstream", () => {
    for (const extra of [{ sensitivity: "private" as const }, { scope: "agent" as const, ownerAgentId: "fictional-other-agent" },
      { scope: "task" as const, taskId: "fictional-other-task" }]) {
      expect(() => builder().buildFromMemories(input, [memory("forbidden", 0.01, extra)])).toThrow("Invalid context candidate evidence");
    }
    expect(builder().buildFromMemories({ ...input, includePrivate: true }, [memory("own-private", 0.01, { sensitivity: "private" })]).items).toHaveLength(1);
  });
  it("validates and detaches constructor policy, and shares that policy with Query", async () => {
    const mutable: ContextPackPolicy = { ...policy, selectionMode: "relevance_only", requireUserConfirmed: true };
    const service = new MemoryService(new InMemoryStore(), {}, mutable);
    mutable.selectionMode = "legacy_weighted"; mutable.requireUserConfirmed = false; mutable.maxMemories = 0;
    expect(service.contextCapabilityPolicy()).toMatchObject({ selectionMode: "relevance_only", requireUserConfirmed: true, maxMemories: 20 });
    const exported = service.contextCapabilityPolicy(); exported.requireUserConfirmed = false;
    await service.remember({ userId: input.userId, agentId: input.agentId, key: "pending", value: "fictional needle", kind: "user_fact", idempotencyKey: "fictional-pending" });
    expect((await service.context(input)).items).toEqual([]);
    expect((await service.query({ ...input, strategy: "direct" })).contextPack.items).toEqual([]);
    for (const bad of [{ maxMemories: 0 }, { defaultTokenBudget: 4097 }, { maxTokenBudget: NaN }, { selectionMode: "unimplemented" }]) {
      expect(() => Reflect.apply(resolveContextPackPolicy, undefined, [{ ...policy, ...bad }])).toThrow("Invalid context policy");
    }
  });
});
