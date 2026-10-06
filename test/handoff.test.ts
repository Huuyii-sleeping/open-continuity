import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";

describe("handoff capsules", () => {
  it("creates and resumes a task-scoped handoff across agents", async () => {
    const service = new MemoryService();
    const created = await service.createHandoff({
      userId: "demo-user", agentId: "trae", taskId: "demo-task", summary: "API is implemented; UI remains",
      decisions: ["Use TypeScript"], nextActions: ["Add the settings screen"], artifacts: ["src/api.ts"],
      idempotencyKey: "handoff-demo-1",
    });
    expect(created.capsule).toMatchObject({ schemaVersion: "1.0", taskId: "demo-task", sourceAgentId: "trae", status: "ready" });
    expect(created.memory.current).toMatchObject({ key: "handoff:demo-task", kind: "task_state", scope: "task" });

    const resumed = await service.resumeHandoff({ userId: "demo-user", agentId: "claude", taskId: "demo-task" });
    expect(resumed).toMatchObject({ status: "ready", capsule: { summary: "API is implemented; UI remains", sourceAgentId: "trae" } });
  });

  it("reports missing and expired capsules without returning them as ready", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const service = new MemoryService();
    expect(await service.resumeHandoff({ userId: "demo-user", agentId: "reader", taskId: "missing" })).toEqual({ capsule: null, memory: null, status: "not_found" });
    await service.createHandoff({ userId: "demo-user", agentId: "writer", taskId: "expiring", summary: "Temporary state", expiresAt: "2030-01-02T00:00:00.000Z", idempotencyKey: "handoff-expiring" });
    vi.setSystemTime(new Date("2030-01-03T00:00:00.000Z"));
    expect(await service.resumeHandoff({ userId: "demo-user", agentId: "reader", taskId: "expiring" })).toEqual({ status: "expired", capsule: null, memory: null });
    vi.useRealTimers();
  });
});
