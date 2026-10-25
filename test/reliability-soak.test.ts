import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";

describe("5B budgeted Query repeated lifecycle", () => {
  it("keeps versions/citations/permissions stable and drains after repeated bounded concurrency", async () => {
    const cycles = Number(process.env.OPEN_CONTINUITY_RELIABILITY_CYCLES ?? 100);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 5000) throw new Error("Invalid explicit soak cycles");
    const directory = mkdtempSync(join(tmpdir(), "open-continuity-query-soak-"));
    const service = new MemoryService(new SqliteMemoryStore(join(directory, "fictional.db")), {},
      { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 2, requireUserConfirmed: true });
    const actor = { userId: "fictional-soak-user", agentId: "fictional-soak-agent" };
    let version = 1;
    try {
      const first = await service.remember({ ...actor, key: "alpha", value: "fictional alpha condition", kind: "decision", userConfirmed: true, idempotencyKey: "fictional-alpha-0" });
      await service.remember({ ...actor, key: "beta", value: "fictional beta condition", kind: "decision", userConfirmed: true, idempotencyKey: "fictional-beta-0" });
      for (const [n, extra] of [{ sensitivity: "private" as const }, { userConfirmed: false }, { userId: "fictional-other" },
        { scope: "agent" as const, agentId: "fictional-other" }, { scope: "task" as const, taskId: "fictional-other" }].entries()) {
        await service.remember({ ...actor, userConfirmed: true, ...extra, key: `fictional-hidden-${n}`, value: "fictional alpha beta", kind: "decision", idempotencyKey: `fictional-hidden-${n}` });
      }
      for (let cycle = 1; cycle <= cycles; cycle++) {
        if (cycle % 10 === 0) {
          const update = { ...actor, key: "alpha", value: `fictional alpha condition ${cycle}`, kind: "decision" as const, userConfirmed: true,
            expectedVersion: version, idempotencyKey: `fictional-alpha-${cycle}` };
          const receipt = await service.remember(update); version++;
          expect(receipt.current.version).toBe(version);
          expect((await service.remember(update)).duplicate).toBe(true);
        }
        const results = await Promise.all(Array.from({ length: 4 }, () => service.query({ ...actor, query: "alpha and beta", subqueries: ["alpha", "beta"] })));
        for (const result of results) {
          expect(result.answer!.status).toBe("evidence_ready");
          expect(result.contextPack.items.map(item => item.key).sort()).toEqual(["alpha", "beta"]);
          expect(result.contextPack.items.find(item => item.key === "alpha")!.version).toBe(version);
          expect(result.answer!.citations).toHaveLength(2);
          for (const citation of result.answer!.citations) expect(result.contextPack.items.some(item => item.memoryId === citation.memoryId && item.sourceEventId === citation.sourceEventId && item.version === citation.version)).toBe(true);
        }
        expect(service.readRuntimeStatus()).toMatchObject({ activeRequests: 0, pendingReads: 0, activeWrites: 0 });
      }
      const history = await service.history({ ...actor, memoryId: first.current.id, limit: 100 });
      expect(history.events).toHaveLength(Math.min(version, 100));
      expect(history.events.every(event => event.key === "alpha")).toBe(true);
    } finally { await service.closeGracefully(); rmSync(directory, { recursive: true, force: true }); }
  }, 60000);
});
