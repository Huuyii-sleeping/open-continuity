import { describe, expect, it } from "vitest";
import { ContextPackBuilder, estimateContextTokens } from "../src/core/context-pack.js";
import { MemoryService } from "../src/core/memory-service.js";
import { InMemoryStore } from "../src/core/memory-store.js";
import { RetrievalPipeline } from "../src/core/retrieval.js";
import { contextPackInputSchema, type ResolvedMemory } from "../src/shared/types.js";
const input = contextPackInputSchema.parse({ userId: "fictional-coverage-user", agentId: "fictional-coverage-agent", query: "alpha and beta", maxMemories: 2 });
function memory(id: string, score: number, value: unknown = "fictional evidence"): ResolvedMemory {
  return { id, key: id, value, kind: "decision", scope: "user", sensitivity: "public", userConfirmed: true,
    sourceAgentId: input.agentId, sourceEventId: `fictional-${id}`, version: 1, updatedAt: "2031-01-01T00:00:00Z",
    retrieval: { score, channels: ["full_text"], ranks: { full_text: 1 }, exactTier: 0 } };
}
const candidates = [memory("alpha-one", 0.04), memory("alpha-two", 0.03), memory("beta", 0.02)];
const requirements = [{ id: "a", query: "alpha", memoryIds: ["alpha-one", "alpha-two"] }, { id: "b", query: "beta", memoryIds: ["beta"] }];
function builder(queryPacking: "query_coverage" | "rank_only" = "query_coverage") {
  return new ContextPackBuilder(new RetrievalPipeline(new InMemoryStore()), { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, queryPacking });
}
describe("context-coverage-v1", () => {
  it("reserves evidence for distinct questions and retains a rank-only ablation", () => {
    const result = builder().buildFromMemories(input, candidates, undefined, requirements);
    expect(result.items.map(item => item.memoryId)).toEqual(["alpha-one", "beta"]);
    expect(result.coverage).toMatchObject({ policy: "query_coverage", coveredQueries: 2, totalQueries: 2 });
    expect(result.items[1].selection?.inputRank).toBe(3);
    const ablated = builder("rank_only").buildFromMemories(input, candidates, undefined, requirements);
    expect(ablated.items.map(item => item.memoryId)).toEqual(["alpha-one", "alpha-two"]);
    expect(ablated.coverage).toMatchObject({ coveredQueries: 1, requirements: [expect.objectContaining({ status: "covered" }), expect.objectContaining({ status: "missing", reason: "context_budget" })] });
  });
  it("chooses the greatest new-query coverage, then keeps remaining base rank", () => {
    const shared = memory("shared", 0.001);
    const result = builder().buildFromMemories(input, [...candidates, shared], undefined,
      requirements.map(requirement => ({ ...requirement, memoryIds: [...requirement.memoryIds, "shared"] })));
    expect(result.items.map(item => item.memoryId)).toEqual(["shared", "alpha-one"]);
    expect(result.coverage?.coveredQueries).toBe(2);
  });
  it("does not use forbidden budgets or truncate negation, conditions, Unicode or nested objects", () => {
    const value = { rule: "不要删除；仅在用户批准后执行", nested: { exceptions: ["not production", "条件α"], enabled: false } };
    const original = memory("condition", 0.02, value);
    const result = builder().buildFromMemories({ ...input, maxMemories: 1 }, [original]);
    expect(JSON.parse(result.context).value).toEqual(value);
    expect(result.budget.usedTokens).toBe(estimateContextTokens(result.context));
    const exact = builder().buildFromMemories({ ...input, tokenBudget: result.budget.usedTokens }, [original]);
    expect(exact.items).toHaveLength(1);
    const small = builder().buildFromMemories({ ...input, tokenBudget: result.budget.usedTokens - 1 }, [original]);
    expect(small.items).toEqual([]);
    expect(small.context).toBe("");
    expect(small.omitted[0].reason).toBe("token_budget");
    (result.items[0].value as typeof value).nested.enabled = true;
    expect(original.value).toEqual(value);
  });
  it("skips an oversized first choice and can still use a smaller covering candidate", () => {
    const huge = memory("huge", 0.1, "x".repeat(5000));
    const result = builder().buildFromMemories({ ...input, tokenBudget: 256 }, [huge, candidates[0]], undefined,
      [{ id: "a", query: "alpha", memoryIds: ["huge", "alpha-one"] }]);
    expect(result.items.map(item => item.memoryId)).toEqual(["alpha-one"]);
    expect(result.coverage?.coveredQueries).toBe(1);
    expect(result.omitted).toEqual([expect.objectContaining({ memoryId: "huge", reason: "token_budget" })]);
  });
  it("deduplicates the same snapshot without merging independent equal values; rejects mixed versions", () => {
    const first = candidates[0];
    const result = builder().buildFromMemories(input, [first, structuredClone(first), candidates[1]]);
    expect(result.items.map(item => item.memoryId)).toEqual(["alpha-one", "alpha-two"]);
    expect(result.coverage?.duplicatesRemoved).toBe(1);
    expect(() => builder().buildFromMemories(input, [first, { ...first, version: 2 }])).toThrow("Inconsistent context evidence");
  });
  it("rejects fabricated requirement references and duplicate obligation identifiers", () => {
    for (const specs of [[{ id: "x", query: "alpha", memoryIds: ["nonexistent"] }], [...requirements, requirements[0]]]) {
      expect(() => builder().buildFromMemories(input, candidates, undefined, specs)).toThrow("Inconsistent context evidence");
    }
  });
  it("does not expose confirmation-filtered ids in the coverage receipt", () => {
    const pending = { ...candidates[0], userConfirmed: false };
    const pack = new ContextPackBuilder(new RetrievalPipeline(new InMemoryStore()), { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 20, requireUserConfirmed: true });
    const result = pack.buildFromMemories(input, [pending], undefined, [{ id: "a", query: "alpha", memoryIds: [pending.id] }]);
    expect(result.coverage?.requirements[0]).toMatchObject({ status: "missing", reason: "confirmation_required", selectedMemoryIds: [] });
    expect(JSON.stringify(result)).not.toContain(pending.id);
  });
  it("changes Query sufficiency to the budgeted set and retains the old retrieved assessment", async () => {
    const service = new MemoryService();
    await service.remember({ userId: input.userId, agentId: input.agentId, key: "long", value: "needle " + "x".repeat(4000), kind: "decision", idempotencyKey: "fictional-long" });
    const result = await service.query({ ...input, query: "needle", strategy: "direct", tokenBudget: 64 });
    expect(result.retrievalSufficiency).toMatchObject({ status: "sufficient", evidenceCount: 1 });
    expect(result.sufficiency).toMatchObject({ status: "insufficient", evidenceCount: 0, reasons: expect.arrayContaining(["empty_context", "context_budget"]) });
    expect(result.answer).toMatchObject({ status: "abstain", statements: [], citations: [] });
    expect(result.fallback.reasons).toContain("insufficient_evidence");
  });
});
