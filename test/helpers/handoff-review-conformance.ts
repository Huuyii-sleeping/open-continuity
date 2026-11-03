import { describe, expect, it } from "vitest";
import type { MemoryService } from "../../src/core/application/memory-service.js";

export function handoffReviewConformance(label: string, create: () => Promise<{ service: MemoryService; reopen?: () => Promise<MemoryService> }>) {
  const actor = { userId: "fictional-review-contract-user", agentId: "fictional-source" }, taskId = "fictional-review-contract-task";
  const content = { ...actor, taskId, summary: "Fictional interface complete; tests pending", sensitivity: "public" as const, nextActions: ["Write fictional tests"] };
  describe(`${label}: handoff-review-v1`, () => {
    it("writes once after confirmation and replays its original receipt without restoring forgotten state", async () => {
      const rt = await create(), draft = await rt.service.prepareHandoff(content), input = { ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true as const };
      expect((await rt.service.history({ ...actor, taskId })).events).toHaveLength(0);
      const first = await rt.service.confirmHandoff(input); expect((await rt.service.confirmHandoff(input)).memory.duplicate).toBe(true);
      await rt.service.forget({ ...actor, taskId, memoryId: first.memory.current.id });
      expect((await rt.service.confirmHandoff(input)).memory.duplicate).toBe(true);
      expect(await rt.service.resumeHandoff({ ...actor, taskId })).toMatchObject({ status: "not_found" });
      if (rt.reopen) { const s = await rt.reopen(); expect((await s.confirmHandoff(input)).memory.duplicate).toBe(true); expect(await s.resumeHandoff({ ...actor, taskId })).toMatchObject({ status: "not_found" }); }
    });
    it("rejects a stale target atomically without appending an event", async () => {
      const { service: s } = await create(); await s.createHandoff({ ...content, idempotencyKey: "fictional-initial" });
      const draft = await s.prepareHandoff(content);
      await s.createHandoff({ ...content, summary: "Fictional newer progress", idempotencyKey: "fictional-newer", expectedVersion: 1 });
      await expect(s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect((await s.history({ ...actor, taskId })).events).toHaveLength(2);
      expect((await s.resumeHandoff({ ...actor, taskId })).capsule?.summary).toBe("Fictional newer progress");
    });
    it("rejects delete/recreate ABA even when the new record has the same version", async () => {
      const { service: s } = await create(), first = await s.createHandoff({ ...content, idempotencyKey: "fictional-first" });
      const draft = await s.prepareHandoff(content);
      await s.forget({ ...actor, taskId, memoryId: first.memory.current.id });
      const fresh = await s.createHandoff({ ...content, idempotencyKey: "fictional-fresh" }); expect(fresh.memory.current.version).toBe(draft.expectedSnapshot.version);
      expect(fresh.memory.current.id).not.toBe(draft.expectedSnapshot.memoryId);
      await expect(s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect((await s.history({ ...actor, taskId })).events).toHaveLength(3);
    });
    it("never overwrites a private target hidden from preparation or leaks it through conflict details", async () => {
      const { service: s } = await create(); await s.createHandoff({ ...content, sensitivity: "private", summary: "Fictional private task state", idempotencyKey: "fictional-private" });
      const draft = await s.prepareHandoff(content); expect(draft.expectedSnapshot).toEqual({ memoryId: null, sourceEventId: null, version: 0 });
      try { await s.confirmHandoff({ ...actor, draft, reviewedFingerprint: draft.fingerprint, userConfirmed: true }); throw new Error("Expected conflict"); }
      catch (error) { expect(error).toMatchObject({ code: "VERSION_CONFLICT" }); expect(JSON.stringify(error)).not.toContain("private task state"); expect(error).toHaveProperty("details", undefined); }
      expect((await s.history({ ...actor, taskId, includePrivate: true })).events).toHaveLength(1);
      expect(await s.resumeHandoff({ userId: "fictional-other-user", agentId: actor.agentId, taskId, includePrivate: true })).toMatchObject({ status: "not_found" });
      expect(await s.resumeHandoff({ ...actor, taskId: "fictional-other-task", includePrivate: true })).toMatchObject({ status: "not_found" });
    });
  });
}
