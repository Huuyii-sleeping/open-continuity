import { describe, expect, it, vi } from "vitest";
import { CandidateRetrieval, type CandidateSearchRequest, type CandidateSearchStore } from "../../src/core/candidate-search.js";
import type { MemoryService } from "../../src/core/memory-service.js";
import type { RememberInput } from "../../src/shared/types.js";

export interface CandidateRuntime { store: CandidateSearchStore; service: MemoryService }
const actor = { userId: "fictional-candidate-user", agentId: "fictional-candidate-reader" };
function write(key: string, extra: Partial<RememberInput> = {}): RememberInput {
  return { ...actor, key, value: `fictional needle ${key}`, kind: "user_fact", userConfirmed: true, idempotencyKey: `fictional:${key}`, ...extra };
}
export function candidateConformance(label: string, create: () => Promise<CandidateRuntime>) {
  describe(`${label}: candidate-search-v1`, () => {
    it("returns exact key evidence without claiming a relevance score", async () => {
      const { store, service } = await create();
      await service.remember(write("needle"));
      await service.remember(write("not-the-key", { value: "needle" }));
      const result = await store.searchCandidates({ ...actor, channel: "exact", query: "needle" });
      expect(result.hits.map(h => h.memory.key)).toEqual(["needle"]);
      expect(result.hits[0]).toMatchObject({ channel: "exact", channelRank: 1, rankMeaning: "match_order", score: { model: "none", value: null }, match: { type: "exact_key", reason: "key_equals" } });
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "needle", query: "different" })).skippedReason).toBe("key_query_mismatch");
    });
    it("generates structured candidates independently but does not call them text matches", async () => {
      const { store, service } = await create();
      await service.remember(write("unrelated", { value: "fictional unrelated material", kind: "decision" }));
      const results = await new CandidateRetrieval(store).retrieve({ ...actor, query: "nonexistent", kind: "decision" });
      expect(results.find(r => r.channel === "full_text")!.hits).toEqual([]);
      expect(results.find(r => r.channel === "structured")!.hits[0]).toMatchObject({ rankMeaning: "filter_order", match: { type: "structured_filter", filters: ["kind"] } });
      expect((await store.searchCandidates({ ...actor, channel: "structured", taskId: "fictional-task" })).skippedReason).toBe("missing_structured_filter");
    });
    it("enforces user/agent/task/private eligibility in all three channels", async () => {
      const { store, service } = await create();
      const forbidden = [
        write("other-user", { userId: "fictional-other-user" }),
        write("other-agent", { scope: "agent", agentId: "fictional-other-agent" }),
        write("other-task", { scope: "task", taskId: "fictional-other-task" }),
        write("private", { sensitivity: "private" }),
      ];
      for (const item of forbidden) await service.remember(item);
      for (const channel of ["exact", "structured", "full_text"] as const) for (const item of forbidden) {
        const result = await store.searchCandidates({ ...actor, channel, key: item.key, query: channel === "exact" ? item.key : channel === "full_text" ? "needle" : undefined });
        expect(result.hits).toEqual([]);
      }
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "other-agent", includePrivate: true })).hits).toEqual([]);
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "private", includePrivate: true })).hits).toHaveLength(1);
      expect((await store.searchCandidates({ ...actor, channel: "structured", scope: "agent", agentId: "fictional-other-agent" })).hits).toHaveLength(1);
      expect((await store.searchCandidates({ ...actor, channel: "structured", scope: "task", taskId: "fictional-other-task" })).hits).toHaveLength(1);
    });
    it("applies optional confirmation and eligibility BEFORE the candidate budget", async () => {
      const { store, service } = await create();
      await service.remember(write("visible"));
      await service.remember(write("unconfirmed", { userConfirmed: false }));
      await service.remember(write("private", { sensitivity: "private" }));
      await service.remember(write("other-user", { userId: "fictional-other-user" }));
      for (const channel of ["structured", "full_text"] as const) {
        const result = await store.searchCandidates({ ...actor, channel, kind: "user_fact", query: "needle", requireUserConfirmed: true, limit: 1 });
        expect(result.hits.map(h => h.memory.key)).toEqual(["visible"]);
        expect(result.truncated).toBe(false);
      }
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "unconfirmed" })).hits).toHaveLength(1);
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "unconfirmed", requireUserConfirmed: true })).hits).toEqual([]);
    });
    it("handles short queries, percent/underscore and quoted keys literally", async () => {
      const { store, service } = await create();
      await service.remember(write("percent", { value: "fictional 50%" }));
      await service.remember(write("plain", { value: "fictional 500" }));
      await service.remember(write("underscore", { value: "fictional a_b" }));
      await service.remember(write('quoted"key', { value: "fictional quoted" }));
      for (const [query,key] of [["50%","percent"],["%","percent"],["a_b","underscore"],['quoted"key','quoted"key']]) {
        expect((await store.searchCandidates({ ...actor, channel: "full_text", query })).hits.map(h => h.memory.key)).toEqual([key]);
      }
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "SQLITE OR nonmatching" })).hits).toEqual([]);
    });
    it("distinguishes skipped, empty and truncated without arbitrary fallback injection", async () => {
      const { store, service } = await create();
      await service.remember(write("visible"));
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "  " })).status).toBe("skipped");
      expect((await store.searchCandidates({ ...actor, channel: "exact" })).skippedReason).toBe("missing_exact_key");
      expect(await store.searchCandidates({ ...actor, channel: "full_text", query: "nonexistent" })).toMatchObject({ status: "ok", hits: [], truncated: false });
      await service.remember(write("another"));
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "needle", limit: 1 })).truncated).toBe(true);
    });
    it("returns detached snapshots and search never mutates state or audit", async () => {
      const { store, service } = await create();
      const saved = await service.remember(write("object", { value: { needle: true, nested: { n: 1 } } }));
      const before = await service.history(actor);
      const result = await store.searchCandidates({ ...actor, channel: "full_text", query: "needle" });
      (result.hits[0]!.memory.value as { nested: { n: number } }).nested.n = 99;
      expect((await store.searchCandidates({ ...actor, channel: "exact", key: "object" })).hits[0]!.memory).toEqual(saved.current);
      expect(await service.history(actor)).toEqual(before);
    });
    it("rejects invalid budgets, arbitrary fields, and all foreign cursor protocols", async () => {
      const { store } = await create();
      const base = { ...actor, channel: "full_text", query: "needle" };
      for (const extra of [{ limit: 0 },{ limit: 101 },{ limit: 1.5 },{ channel: "invented" },{ cursor: "legacy" },{ query: "x".repeat(2049) },{ query: "x\0y" },{ query: Array(33).fill("term").join(" ") },{ administrator: true },{ scope: "task" }]) {
        await expect(Promise.resolve().then(() => store.searchCandidates({ ...base, ...extra } as CandidateSearchRequest))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    });
    it("has stable unique channel ranks and uses id for equal-score/time ties", async () => {
      const { store, service } = await create();
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
      try { for (const key of ["item-a","item-b","item-c"]) await service.remember(write(key, { value: "fictional needle" })); }
      finally { vi.useRealTimers(); }
      const input = { ...actor, channel: "full_text" as const, query: "needle" };
      const first = await store.searchCandidates(input);
      expect(first.hits.map(h => h.channelRank)).toEqual([1,2,3]);
      expect(first.hits.map(h => h.memory.id)).toEqual(first.hits.map(h => h.memory.id).sort((a,b) => b.localeCompare(a)));
      expect(new Set(first.hits.map(h => h.memory.id)).size).toBe(3);
      expect(await store.searchCandidates(input)).toEqual(first);
      expect((await store.searchCandidates({ ...input, limit: 1 })).hits).toEqual(first.hits.slice(0,1));
    });
    it("keeps candidate reads consistent with idempotent writes, updates and forget", async () => {
      const { store, service } = await create();
      const input = write("versioned", { value: "fictional oldneedle" });
      const receipt = await service.remember(input);
      expect((await service.remember(input)).duplicate).toBe(true);
      await service.remember(write("versioned", { value: "fictional newtoken", expectedVersion: 1, idempotencyKey: "fictional-update" }));
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "oldneedle" })).hits).toEqual([]);
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "newtoken" })).hits[0]!.memory.version).toBe(2);
      await service.forget({ ...actor, memoryId: receipt.current.id });
      expect((await store.searchCandidates({ ...actor, channel: "full_text", query: "newtoken" })).hits).toEqual([]);
    });
  });
}
