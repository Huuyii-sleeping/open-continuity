import { describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";

describe("RetrievalPipeline", () => {
  it("fuses exact and full-text hits without duplicates and returns an explainable receipt", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "concise answers", kind: "user_preference", idempotencyKey: "retrieval-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "writing_style", value: "concise technical notes", kind: "user_preference", idempotencyKey: "retrieval-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "unrelated", value: "calendar", kind: "user_fact", idempotencyKey: "retrieval-3" });

    const result = await service.recall({ userId: "u1", agentId: "claude", query: "response_style", limit: 10 });

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]).toMatchObject({ key: "response_style", value: "concise answers" });
    expect(result.memories[0].retrieval?.channels).toEqual(["exact", "full_text"]);
    expect(result.memories[0].retrieval?.ranks).toMatchObject({ exact: 1, full_text: 1 });
    expect(result.memories[0].retrieval?.score).toBeCloseTo(2 / 61);
    expect(result.retrieval).toMatchObject({ mode: "hybrid", channels: ["exact", "full_text"], candidateCount: 1, candidateLimit: 50 });
  });

  it("keeps exact filters and structured filters in the same user/task boundary", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "project_status", value: "production", kind: "task_state", scope: "task", taskId: "t1", idempotencyKey: "retrieval-task-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "project_status", value: "draft", kind: "task_state", scope: "task", taskId: "t2", idempotencyKey: "retrieval-task-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "project_note", value: "production deployment note", kind: "decision", scope: "task", taskId: "t1", idempotencyKey: "retrieval-task-3" });

    const exact = await service.recall({ userId: "u1", agentId: "claude", query: "project_status", key: "project_status", kind: "task_state", taskId: "t1", limit: 10 });
    expect(exact.memories.map((memory) => memory.value)).toEqual(["production"]);
    expect(exact.memories.every((memory) => memory.taskId === "t1" && memory.kind === "task_state")).toBe(true);
    expect(exact.memories[0].retrieval?.channels).toEqual(["exact", "structured", "full_text"]);

    const mismatchedKey = await service.recall({ userId: "u1", agentId: "claude", query: "missing phrase", key: "project_status", taskId: "t1", limit: 10 });
    expect(mismatchedKey.memories.map((memory) => memory.key)).toEqual([]);
  });

  it("paginates fused results and rejects a cursor reused with another query", async () => {
    const service = new MemoryService();
    for (let index = 0; index < 5; index += 1) {
      await service.remember({ userId: "u1", agentId: "codex", key: `preference_${index}`, value: `concise note ${index}`, kind: "user_preference", idempotencyKey: `retrieval-page-${index}` });
    }
    const first = await service.recall({ userId: "u1", agentId: "claude", query: "concise", limit: 2 });
    expect(first.memories).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.recall({ userId: "u1", agentId: "claude", query: "concise", limit: 2, cursor: first.nextCursor! });
    expect(second.memories).toHaveLength(2);
    expect(new Set([...first.memories, ...second.memories].map((memory) => memory.id)).size).toBe(4);
    await expect(service.recall({ userId: "u1", agentId: "claude", query: "different", limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("preserves the old deterministic response shape for non-query recall", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_fact", idempotencyKey: "retrieval-plain" });
    const result = await service.recall({ userId: "u1", agentId: "claude" });
    expect(result).toEqual({ memories: [expect.objectContaining({ key: "language" })], nextCursor: null });
    expect(result.memories[0].retrieval).toBeUndefined();
    expect(result.retrieval).toBeUndefined();
  });

  it("reports only channels that produced candidates", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "style", value: "concise response", kind: "user_preference", idempotencyKey: "retrieval-channel-1" });
    const result = await service.recall({ userId: "u1", agentId: "claude", query: "concise" });
    expect(result.retrieval?.channels).toEqual(["full_text"]);
    expect(result.memories[0].retrieval?.channels).toEqual(["full_text"]);
  });

  it("applies the profile candidate budget to actual retrieval", async () => {
    const service = new MemoryService(undefined, { channels: ["full_text"], candidateLimit: 2, rrfK: 10 });
    for (let index = 0; index < 4; index += 1) {
      await service.remember({ userId: "u1", agentId: "codex", key: `budget_${index}`, value: `shared phrase ${index}`, kind: "user_fact", idempotencyKey: `budget-${index}` });
    }
    const result = await service.recall({ userId: "u1", agentId: "claude", query: "shared phrase", limit: 10 });
    expect(result.memories).toHaveLength(2);
    expect(result.retrieval).toMatchObject({ channels: ["full_text"], candidateCount: 2, candidateLimit: 2 });
    expect(result.memories[0].retrieval?.score).toBeCloseTo(1 / 11);
  });
});
