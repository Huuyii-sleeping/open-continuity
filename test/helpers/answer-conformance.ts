import { describe, expect, it } from "vitest";
import { MemoryService } from "../../src/core/memory-service.js";
import type { MemoryStore } from "../../src/core/memory-store.js";
import { validateEvidenceAnswer } from "../../src/core/evidence-answer.js";
const actor = { userId: "fictional-phase4-user", agentId: "fictional-phase4-reader" };
export function answerConformance(label: string, create: () => Promise<{ store: MemoryStore }>) {
  describe(`${label}: budgeted answers`, () => {
    it("returns no answer statements or citations when the whole value exceeds budget", async () => {
      const { store } = await create(); const service = new MemoryService(store);
      await service.remember({ ...actor, key: "huge", value: "needle " + "x".repeat(3000), kind: "decision", idempotencyKey: "fictional-huge" });
      const result = await service.query({ ...actor, query: "needle", tokenBudget: 64, strategy: "direct" });
      expect(result.retrievalSufficiency?.status).toBe("sufficient");
      expect(result.sufficiency).toMatchObject({ status: "insufficient", evidenceCount: 0 });
      expect(result.answer).toMatchObject({ status: "abstain", statements: [], citations: [] });
      validateEvidenceAnswer(result.answer!, result.contextPack, result.evidence, result.sufficiency, false);
    });
    it("projects multiple questions without duplicating memory or overstating budget coverage", async () => {
      const { store } = await create(); const service = new MemoryService(store);
      for (const key of ["alpha", "beta"]) await service.remember({ ...actor, key, value: { rule: `fictional ${key}; do not delete`, conditions: ["only explicit approval"] }, kind: "decision", idempotencyKey: `fictional-${key}` });
      const input = { ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"], strategy: "multi_step" as const };
      const result = await service.query(input);
      expect(result.answer?.status).toBe("evidence_ready");
      expect(result.answer?.citations).toHaveLength(2);
      expect(result.contextPack.coverage).toMatchObject({ coveredQueries: 2, totalQueries: 2 });
      validateEvidenceAnswer(result.answer!, result.contextPack, result.evidence, result.sufficiency, false);
      const partial = await service.query({ ...input, maxMemories: 1 });
      expect(partial.retrievalSufficiency?.status).toBe("sufficient");
      expect(partial.sufficiency).toMatchObject({ status: "partial", matchedQueries: 1, totalQueries: 2 });
      expect(partial.answer).toMatchObject({ status: "partial", statements: [expect.objectContaining({ value: result.answer!.statements.find(item => item.key === partial.contextPack.items[0].key)!.value })] });
    });
    it("never cites hidden user/agent/task/private/unconfirmed evidence", async () => {
      const { store } = await create(); const service = new MemoryService(store, { candidateLimit: 1 }, { defaultTokenBudget: 4096, maxTokenBudget: 4096, maxMemories: 2, requireUserConfirmed: true });
      const write = (key: string, extra: Partial<Parameters<MemoryService["remember"]>[0]> = {}) => service.remember({ ...actor, key, value: "fictional needle", kind: "decision", userConfirmed: true, idempotencyKey: `fictional-${key}`, ...extra });
      const good = await write("good");
      const hidden = [await write("private", { sensitivity: "private" }), await write("pending", { userConfirmed: false }), await write("user", { userId: "fictional-other-user" }), await write("agent", { scope: "agent", agentId: "fictional-other-agent" }), await write("task", { scope: "task", taskId: "fictional-other-task" })];
      const result = await service.query({ ...actor, query: "needle" });
      expect(result.answer!.citations.map(item => item.memoryId)).toEqual([good.current.id]);
      for (const item of hidden) expect(JSON.stringify(result)).not.toContain(item.current.id);
      expect((await service.recall({ ...actor, query: "pending" })).memories).toHaveLength(1);
    });
    it("abstains on explicit conflicts rather than inventing a winner or citing superseded facts", async () => {
      const { store } = await create(); const service = new MemoryService(store);
      const old = await service.remember({ ...actor, key: "old", value: "needle 3000", kind: "decision", userConfirmed: true, expectedVersion: 0, fact: { group: "fictional-port" }, idempotencyKey: "fictional-old" });
      const conflict = await service.remember({ ...actor, key: "new", value: "needle 8080", kind: "decision", userConfirmed: true, expectedVersion: 0, fact: { group: "fictional-port" }, idempotencyKey: "fictional-new" });
      const abstained = await service.query({ ...actor, query: "needle" });
      expect(abstained.answer).toMatchObject({ status: "abstain", statements: [], citations: [], reasons: expect.arrayContaining(["fact_conflict"]) });
      await service.remember({ ...actor, key: "new", value: "needle 8080", kind: "decision", userConfirmed: true, expectedVersion: conflict.current.version,
        fact: { group: "fictional-port", supersedes: [{ memoryId: old.current.id, sourceEventId: old.current.sourceEventId, version: old.current.version }] }, idempotencyKey: "fictional-replacement" });
      const current = await service.query({ ...actor, query: "needle" });
      expect(current.answer!.statements.map(item => item.value)).toEqual(["needle 8080"]);
      expect(current.answer!.citations[0].version).toBe(2);
      expect(current.answer!.statements[0].verification).toBe("visible_explicit_assertion");
      expect(current.answer!.citations.some(item => item.memoryId === old.current.id)).toBe(false);
    });
    it("retains stable version citations, updates them after CAS and stops citing forgotten records", async () => {
      const { store } = await create(); const service = new MemoryService(store);
      const receipt = await service.remember({ ...actor, key: "versioned", value: "fictional current", kind: "decision", idempotencyKey: "fictional-versioned" });
      const input = { ...actor, query: "versioned" };
      const first = await service.query(input);
      const before = await service.history(actor);
      for (let i = 0; i < 3; i++) expect((await service.query(input)).answer!.citations).toEqual(first.answer!.citations);
      expect(await service.history(actor)).toEqual(before);
      await service.remember({ ...actor, key: "versioned", value: "fictional changed", kind: "decision", expectedVersion: 1, idempotencyKey: "fictional-update" });
      const next = await service.query(input);
      expect(next.answer!.citations[0].id).not.toBe(first.answer!.citations[0].id);
      expect(next.answer!.citations[0].version).toBe(2);
      await service.forget({ ...actor, memoryId: receipt.current.id });
      expect((await service.query(input)).answer).toMatchObject({ status: "abstain", citations: [] });
    });
  });
}
