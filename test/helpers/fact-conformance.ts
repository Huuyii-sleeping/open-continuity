import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../../src/core/memory-store.js";
import { MemoryService } from "../../src/core/memory-service.js";
import type { RememberInput, ResolvedMemory } from "../../src/shared/types.js";

export function factConformance(backend: string, runtime: () => Promise<{ store: MemoryStore; service: MemoryService }>) {
  describe(`${backend}: explicit fact contracts`, () => {
    const actor = { userId: "fictional-fact-owner", agentId: "fictional-fact-reader" };
    const assertion = (key: string, value: unknown, extra: Partial<RememberInput> = {}): RememberInput => ({
      ...actor, key, value, kind: "decision", userConfirmed: true, expectedVersion: 0,
      fact: { group: "fictional-config/runtime" }, idempotencyKey: key, ...extra,
    });
    const reference = (memory: ResolvedMemory) => ({ memoryId: memory.id, sourceEventId: memory.sourceEventId, version: memory.version });

    it("persists declarations in current state and immutable idempotent receipts", async () => {
      const { service } = await runtime();
      const input = assertion("fictional-old", "fictional sqlite");
      const receipt = await service.remember(input);
      expect((await service.remember(input))).toMatchObject({ duplicate: true, current: { fact: receipt.current.fact } });
      await expect(service.remember({ ...input, fact: { group: "fictional-other" } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const updated = await service.remember({ ...input, expectedVersion: 1, idempotencyKey: "fictional-update", value: "fictional postgres" });
      expect(updated.current.version).toBe(2);
      expect((await service.remember(input)).current).toEqual(receipt.current);
      const listed = (await service.recall(actor)).memories[0]!;
      expect(listed.fact).toEqual(updated.current.fact);
      expect((await service.history(actor)).events.map(event => event.fact)).toEqual([updated.event.fact, receipt.event.fact]);
    });
    it("requires confirmation and CAS to add, change or remove a declaration", async () => {
      const { service } = await runtime();
      const input = assertion("fictional", "fictional sqlite");
      await expect(service.remember({ ...input, userConfirmed: false })).rejects.toThrow();
      await expect(service.remember({ ...input, expectedVersion: undefined })).rejects.toThrow();
      await service.remember(input);
      await expect(service.remember({ ...input, fact: undefined, expectedVersion: undefined, idempotencyKey: "fictional-unsafe-remove" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(service.remember({ ...input, expectedVersion: 0, idempotencyKey: "fictional-stale" })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const removed = await service.remember({ ...input, fact: undefined, expectedVersion: 1, idempotencyKey: "fictional-remove" });
      expect(removed.current.fact).toBeUndefined();
      expect((await service.recall(actor)).memories[0]!.fact).toBeUndefined();
    });
    it("uses explicit replacement rather than newest timestamp, and carries reasons", async () => {
      const { service } = await runtime();
      const old = await service.remember(assertion("fictional-old", "fictional sqlite"));
      const next = await service.remember(assertion("fictional-next", "fictional sqlite new", { fact: { group: "fictional-config/runtime", supersedes: [reference(old.current)] } }));
      // A newer write of an unrelated assertion must not become authoritative by recency.
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories.map(memory => memory.id)).toEqual([next.current.id]);
      expect(result.memories[0]!.retrieval?.factAssessment).toMatchObject({ status: "active_assertion", usable: true });
      expect(result.retrieval?.factReview?.omitted).toMatchObject([{ memoryId: old.current.id, assessment: { status: "superseded", reason: "verified_replacement" } }]);
      expect((await service.context({ ...actor, query: "sqlite" })).items.map(item => item.memoryId)).toEqual([next.current.id]);
      expect((await service.recall({ ...actor, query: "sqlite", key: "fictional-next" })).memories.map(memory => memory.id)).toEqual([next.current.id]);
      const query = await service.query({ ...actor, query: "sqlite" });
      expect(query.contextPack.items.map(item => item.memoryId)).toEqual([next.current.id]);
      expect(query.evidence[0]?.memory.retrieval?.factAssessment?.usable).toBe(true);
      expect(query.factReview?.policy).toBe("explicit-facts-v1");
    });
    it("detects conflicting visible siblings even when only one is in query top-K", async () => {
      const { store, service } = await runtime();
      await service.remember(assertion("fictional-a", "fictional sqlite"));
      await service.remember(assertion("fictional-b", "fictional postgres"));
      const bounded = new MemoryService(store, { candidateLimit: 1 });
      const result = await bounded.recall({ ...actor, query: "sqlite" });
      expect(result.memories).toEqual([]);
      expect(result.retrieval?.factReview?.omitted[0]?.assessment).toMatchObject({ status: "conflict", reason: "different_visible_values" });
      expect((await bounded.recall({ ...actor, query: "sqlite", key: "fictional-a" })).memories).toEqual([]);
      expect((await bounded.context({ ...actor, query: "sqlite" })).context).toBe("");
      expect((await bounded.query({ ...actor, query: "sqlite" })).sufficiency.status).toBe("insufficient");
    });
    it("does not introduce non-query-matching replacements as relevant answers", async () => {
      const { service } = await runtime();
      const old = await service.remember(assertion("fictional-old", "fictional sqlite"));
      await service.remember(assertion("fictional-current", "fictional postgres", { fact: { group: "fictional-config/runtime", supersedes: [reference(old.current)] } }));
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories).toEqual([]);
      expect(result.retrieval?.factReview?.omitted[0]?.assessment.status).toBe("superseded");
    });
    it("keeps distinct scopes, tasks, kinds and agents independent", async () => {
      const { service } = await runtime();
      await service.remember(assertion("fictional-user", "fictional sqlite"));
      await service.remember(assertion("fictional-task", "fictional sqlite task", { scope: "task", taskId: "fictional-task-a" }));
      await service.remember(assertion("fictional-other-task", "fictional secret task", { scope: "task", taskId: "fictional-task-b" }));
      await service.remember(assertion("fictional-agent", "fictional secret agent", { scope: "agent", agentId: "fictional-other-agent" }));
      await service.remember(assertion("fictional-kind", "fictional sqlite preference", { kind: "user_preference" }));
      const result = await service.recall({ ...actor, query: "sqlite", taskId: "fictional-task-a" });
      expect(result.memories.map(memory => memory.key).sort()).toEqual(["fictional-kind", "fictional-task", "fictional-user"]);
      expect(JSON.stringify(result)).not.toContain("fictional secret");
    });
    it("does not let hidden user/private facts affect a visible fact", async () => {
      const { service } = await runtime();
      const publicMemory = await service.remember(assertion("fictional-public", "fictional sqlite"));
      const privateMemory = await service.remember(assertion("fictional-private", "fictional hidden private", { sensitivity: "private" }));
      const otherUser = await service.remember(assertion("fictional-other", "fictional hidden user", { userId: "fictional-other-user" }));
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories.map(memory => memory.id)).toEqual([publicMemory.current.id]);
      expect(JSON.stringify(result)).not.toContain(privateMemory.current.id);
      expect(JSON.stringify(result)).not.toContain(otherUser.current.id);
      expect((await service.recall({ ...actor, query: "sqlite", includePrivate: true })).memories).toEqual([]);
    });
    it("never resolves a missing, hidden or changed target version", async () => {
      const { service } = await runtime();
      const old = await service.remember(assertion("fictional-old", "fictional sqlite"));
      await service.remember(assertion("fictional-new", "fictional sqlite new", { fact: { group: "fictional-config/runtime", supersedes: [reference(old.current)] } }));
      await service.remember(assertion("fictional-old", "fictional sqlite revised", { expectedVersion: 1, idempotencyKey: "fictional-revised" }));
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories).toEqual([]);
      expect(result.retrieval?.factReview?.omitted.every(item => item.assessment.reason === "unverified_reference")).toBe(true);
      const keyed = await service.recall({ ...actor, query: "sqlite", key: "fictional-new" });
      expect(keyed.memories).toEqual([]);
    });
    it("refuses truncated fact groups rather than treating a top-K list as complete", async () => {
      const { store, service } = await runtime();
      await service.remember(assertion("fictional-a", "fictional sqlite"));
      await service.remember(assertion("fictional-b", "fictional postgres"));
      const result = await new MemoryService(store, { factGroupLimit: 1 }).recall({ ...actor, query: "sqlite" });
      expect(result.memories).toEqual([]);
      expect(result.retrieval?.factReview?.omitted[0]?.assessment).toMatchObject({ coverage: "truncated", reason: "group_budget" });
    });
    it("keeps literal agreement as claims, not proven truth or id deduplication", async () => {
      const { service } = await runtime();
      await service.remember(assertion("fictional-a", { engine: "sqlite", mode: "fictional" }));
      await service.remember(assertion("fictional-b", { mode: "fictional", engine: "sqlite" }));
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories).toHaveLength(2);
      expect(result.memories.every(memory => memory.retrieval?.factAssessment?.status === "consistent_assertions")).toBe(true);
    });
    it("does not resurrect forgotten facts, but reports dangling replacements", async () => {
      const { service } = await runtime();
      const old = await service.remember(assertion("fictional-old", "fictional sqlite"));
      await service.remember(assertion("fictional-new", "fictional sqlite new", { fact: { group: "fictional-config/runtime", supersedes: [reference(old.current)] } }));
      await service.forget({ ...actor, memoryId: old.current.id });
      const result = await service.recall({ ...actor, query: "sqlite" });
      expect(result.memories).toEqual([]);
      expect(result.retrieval?.factReview?.omitted.map(item => item.memoryId)).not.toContain(old.current.id);
      expect((await service.history(actor)).events).toHaveLength(3);
    });
  });
}
