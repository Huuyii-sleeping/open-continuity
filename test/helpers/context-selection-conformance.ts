import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../../src/core/memory-service.js";
import type { MemoryStore } from "../../src/core/memory-store.js";
const actor = { userId: "fictional-context-contract-user", agentId: "fictional-context-contract-reader" };
export function contextSelectionConformance(label: string, create: () => Promise<{ store: MemoryStore }>) {
  describe(`${label}: context selection`, () => {
    it("preserves unequal Recall relevance despite task preference, for Context and Query", async () => {
      const { store } = await create();
      const service = new MemoryService(store);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
        await service.remember({ ...actor, key: "task-note", value: "needle " + "fictional filler ".repeat(100), kind: "task_state", scope: "task", taskId: "fictional-task", userConfirmed: true, idempotencyKey: "fictional-task-note" });
        vi.setSystemTime(new Date("2032-01-01T00:00:00Z"));
        await service.remember({ ...actor, key: "direct-note", value: "needle needle needle", kind: "user_fact", userConfirmed: true, idempotencyKey: "fictional-direct-note" });
      } finally { vi.useRealTimers(); }
      const input = { ...actor, query: "needle", taskId: "fictional-task", purpose: "coding" as const, maxMemories: 1 };
      const recall = await service.recall(input);
      expect(recall.memories.map(memory => memory.key)).toEqual(["direct-note", "task-note"]);
      const context = await service.context(input);
      expect(context.items.map(item => item.key)).toEqual(["direct-note"]);
      expect(context.items[0].retrieval).toEqual({ ...recall.memories[0].retrieval,
        factAssessment: { ...recall.memories[0].retrieval?.factAssessment, evaluatedAt: expect.any(String) } });
      expect(Number.isFinite(Date.parse(context.items[0].retrieval!.factAssessment!.evaluatedAt))).toBe(true);
      expect(context.selection).toMatchObject({ mode: "relevance_first", scopeBoostMax: 0, confirmationBoost: 0 });
      expect((await service.query({ ...input, strategy: "direct" })).contextPack.items.map(item => item.key)).toEqual(["direct-note"]);
      const legacy = new MemoryService(store, {}, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 1, selectionMode: "legacy_weighted" });
      expect((await legacy.context(input)).items.map(item => item.key)).toEqual(["task-note"]);
    });
    it("preserves the exact tier through public Context and Query", async () => {
      const { store } = await create();
      const service = new MemoryService(store);
      await service.remember({ ...actor, key: "needle", value: "fictional exact key", kind: "user_fact", idempotencyKey: "fictional-exact" });
      await service.remember({ ...actor, key: "other", value: "needle needle", kind: "task_state", scope: "task", taskId: "fictional-task", userConfirmed: true, idempotencyKey: "fictional-other" });
      const input = { ...actor, query: "needle", taskId: "fictional-task", maxMemories: 1, purpose: "coding" as const };
      for (const result of [await service.context(input), (await service.query({ ...input, strategy: "direct" })).contextPack]) {
        expect(result.items.map(item => item.key)).toEqual(["needle"]);
        expect(result.items[0].selection?.exactTier).toBe(1);
      }
      const history = await service.history(actor);
      await service.context(input);
      expect(await service.history(actor)).toEqual(history);
    });
    it("retains user/agent/task/private/confirmation gates before candidate and context budgets", async () => {
      const { store } = await create();
      const service = new MemoryService(store, { candidateLimit: 1 }, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 1, requireUserConfirmed: true });
      const write = (key: string, extra: Partial<Parameters<MemoryService["remember"]>[0]> = {}) => service.remember({ ...actor, key, value: "fictional needle", kind: "user_fact", userConfirmed: true, idempotencyKey: `fictional-${key}`, ...extra });
      await write("approved");
      const forbidden = [await write("pending", { userConfirmed: false }), await write("private", { sensitivity: "private" }),
        await write("foreign-user", { userId: "fictional-other-user" }), await write("foreign-agent", { scope: "agent", agentId: "fictional-other-agent" }),
        await write("foreign-task", { scope: "task", taskId: "fictional-other-task" })];
      for (const result of [await service.context({ ...actor, query: "needle" }), (await service.query({ ...actor, query: "needle", strategy: "direct" })).contextPack]) {
        expect(result.items.map(item => item.key)).toEqual(["approved"]);
        for (const item of forbidden) expect(JSON.stringify(result)).not.toContain(item.current.id);
      }
      expect((await service.recall({ ...actor, query: "pending" })).memories[0].userConfirmed).toBe(false);
    });
    it("is repeatable and exposes omission and fallback honestly", async () => {
      const { store } = await create();
      const service = new MemoryService(store);
      await service.remember({ ...actor, key: "long", value: "needle " + "x".repeat(2000), kind: "decision", idempotencyKey: "fictional-long" });
      const input = { ...actor, query: "needle", tokenBudget: 64 };
      const first = await service.context(input);
      expect(first.items).toEqual([]);
      expect(first.omitted.map(item => item.reason)).toEqual(["token_budget"]);
      expect(first.selection?.version).toBe("context-selection-v2");
      for (let i = 0; i < 3; i++) {
        const next = await service.context(input);
        expect(next).toEqual({ ...first, retrieval: { ...first.retrieval,
          factReview: { ...first.retrieval?.factReview, evaluatedAt: expect.any(String) } } });
        expect(Number.isFinite(Date.parse(next.retrieval!.factReview!.evaluatedAt))).toBe(true);
      }
    });
  });
}
