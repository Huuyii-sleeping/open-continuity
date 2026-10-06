import { describe, expect, it } from "vitest";
import { MemoryService } from "../src/core/memory-service.js";
import { OpenContinuityError } from "../src/shared/errors.js";

describe("MemoryService", () => {
  it("shares user-scoped current memory across agents and keeps history separate", async () => {
    const service = new MemoryService();
    const first = await service.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "concise", kind: "user_preference", userConfirmed: true, idempotencyKey: "codex-1" });
    const claudeRecall = await service.recall({ userId: "u1", agentId: "claude" });
    expect(claudeRecall).toMatchObject({ memories: [{ value: "concise" }], nextCursor: null });
    expect("events" in claudeRecall).toBe(false);

    await service.remember({ userId: "u1", agentId: "claude", key: "response_style", value: "detailed", kind: "user_preference", userConfirmed: true, idempotencyKey: "claude-1" });
    expect((await service.recall({ userId: "u1", agentId: "codex" })).memories[0]?.value).toBe("detailed");
    expect((await service.history({ userId: "u1", agentId: "codex", memoryId: first.current.id })).events).toHaveLength(2);
  });

  it("is idempotent per user and rejects conflicting reuse", async () => {
    const service = new MemoryService();
    const input = { userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_fact" as const, idempotencyKey: "same-request" };
    const first = await service.remember(input);
    const second = await service.remember(input);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect((await service.history({ userId: "u1", agentId: "codex" })).events).toHaveLength(1);

    await expect(service.remember({ ...input, value: "Python" })).rejects.toBeInstanceOf(OpenContinuityError);
    await expect(service.remember({ ...input, value: "Python" })).rejects.toThrow(/Idempotency key/);
    expect((await service.remember({ ...input, userId: "u2", value: "Python" })).duplicate).toBe(false);
  });

  it("rejects values that cannot be persisted as JSON", async () => {
    const service = new MemoryService();
    await expect(service.remember({ userId: "u1", agentId: "codex", key: "invalid", value: BigInt(1), kind: "user_fact", idempotencyKey: "invalid-json" })).rejects.toThrow(/JSON-serializable/);
  });

  it("keeps private values out of both recall and history by default", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "public_note", value: "visible", kind: "user_fact", idempotencyKey: "public-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "private_note", value: "secret", kind: "user_fact", sensitivity: "private", idempotencyKey: "private-1" });

    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories.map((memory) => memory.value)).toEqual(["visible"]);
    expect((await service.history({ userId: "u1", agentId: "claude" })).events.map((event) => event.value)).toEqual(["visible"]);
    expect((await service.recall({ userId: "u1", agentId: "claude", includePrivate: true })).memories).toHaveLength(2);
    expect((await service.history({ userId: "u1", agentId: "claude", includePrivate: true })).events).toHaveLength(2);
    const privateMemory = (await service.recall({ userId: "u1", agentId: "codex", includePrivate: true, key: "private_note" })).memories[0];
    await expect(service.forget({ userId: "u1", agentId: "codex", memoryId: privateMemory.id })).rejects.toThrow(/Memory not found/);
    expect((await service.forget({ userId: "u1", agentId: "codex", memoryId: privateMemory.id, includePrivate: true })).current.value).toBe("secret");
  });

  it("enforces user, task, and agent scope visibility", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "shared", value: "user-value", kind: "user_fact", scope: "user", idempotencyKey: "scope-user" });
    await service.remember({ userId: "u1", agentId: "codex", key: "task_state", value: "task-a-value", kind: "task_state", scope: "task", taskId: "task-a", idempotencyKey: "scope-task-a" });
    await service.remember({ userId: "u1", agentId: "codex", key: "private_workspace", value: "codex-only", kind: "user_fact", scope: "agent", idempotencyKey: "scope-agent" });

    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories.map((memory) => memory.value)).toEqual(["user-value"]);
    expect((await service.recall({ userId: "u1", agentId: "claude", taskId: "task-a" })).memories.map((memory) => memory.value).sort()).toEqual(["task-a-value", "user-value"]);
    expect((await service.recall({ userId: "u1", agentId: "codex" })).memories.map((memory) => memory.value).sort()).toEqual(["codex-only", "user-value"]);
    expect((await service.history({ userId: "u1", agentId: "claude" })).events.map((event) => event.value)).toEqual(["user-value"]);
    expect((await service.history({ userId: "u1", agentId: "claude", taskId: "task-a" })).events.map((event) => event.value).sort()).toEqual(["task-a-value", "user-value"]);
    expect((await service.history({ userId: "u1", agentId: "codex" })).events.map((event) => event.value).sort()).toEqual(["codex-only", "user-value"]);
    expect((await service.recall({ userId: "u2", agentId: "codex", taskId: "task-a" })).memories).toHaveLength(0);
    const taskMemory = (await service.recall({ userId: "u1", agentId: "codex", taskId: "task-a", scope: "task" })).memories[0];
    await expect(service.forget({ userId: "u1", agentId: "codex", memoryId: taskMemory.id })).rejects.toThrow(/Memory not found/);
    expect((await service.forget({ userId: "u1", agentId: "codex", memoryId: taskMemory.id, taskId: "task-a" })).current.value).toBe("task-a-value");
    await expect(service.remember({ userId: "u1", agentId: "codex", key: "invalid", value: true, kind: "task_state", scope: "task", idempotencyKey: "invalid-task" })).rejects.toThrow(/taskId/);
  });

  it("paginates and filters current memory without duplicates", async () => {
    const service = new MemoryService();
    for (let index = 0; index < 5; index += 1) {
      await service.remember({ userId: "u1", agentId: "codex", key: "preference_" + index, value: "value_" + index, kind: "user_preference", idempotencyKey: "page-" + index });
    }
    await service.remember({ userId: "u1", agentId: "codex", key: "fact", value: "unrelated", kind: "user_fact", idempotencyKey: "page-fact" });

    const first = await service.recall({ userId: "u1", agentId: "codex", kind: "user_preference", limit: 2 });
    const second = await service.recall({ userId: "u1", agentId: "codex", kind: "user_preference", limit: 2, cursor: first.nextCursor! });
    const third = await service.recall({ userId: "u1", agentId: "codex", kind: "user_preference", limit: 2, cursor: second.nextCursor! });
    const ids = [...first.memories, ...second.memories, ...third.memories].map((memory) => memory.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
    await expect(service.recall({ userId: "u1", agentId: "codex", cursor: "not-a-cursor" })).rejects.toThrow(/Invalid pagination cursor/);
  });

  it("forgets a visible memory while preserving paginated history", async () => {
    const service = new MemoryService();
    const remembered = await service.remember({ userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_fact", idempotencyKey: "forget-1" });
    await service.forget({ userId: "u1", agentId: "codex", memoryId: remembered.current.id });
    expect((await service.recall({ userId: "u1", agentId: "claude" })).memories).toHaveLength(0);
    expect((await service.history({ userId: "u1", agentId: "claude", memoryId: remembered.current.id })).events).toHaveLength(2);
  });

  it("merges object patches and exposes an auditable supersedes chain", async () => {
    const service = new MemoryService();
    const first = await service.remember({
      userId: "u1", agentId: "codex", key: "coding_preferences",
      value: { language: "TypeScript", formatting: { semicolons: true, quotes: "double" } },
      kind: "user_preference", userConfirmed: true, confidence: 1, confidenceBasis: "user_asserted",
      expectedVersion: 0, idempotencyKey: "evolution-create",
    });
    expect(first.evolution).toEqual({ action: "created", version: 1, writeMode: "replace", concurrency: "compare_and_set", supersedes: undefined });

    const second = await service.remember({
      userId: "u1", agentId: "claude", key: "coding_preferences",
      value: { formatting: { quotes: "single" }, testing: true }, kind: "user_preference",
      writeMode: "merge", expectedVersion: 1, confidence: 0.8, confidenceBasis: "source_supported",
      idempotencyKey: "evolution-merge",
    });

    expect(second.current).toMatchObject({
      id: first.current.id, version: 2, value: { language: "TypeScript", formatting: { semicolons: true, quotes: "single" }, testing: true },
      supersedes: { eventId: first.event.id, version: 1 }, confidence: { score: 0.8, basis: "source_supported" },
    });
    expect(second.evolution).toEqual({ action: "merged", version: 2, writeMode: "merge", concurrency: "compare_and_set", supersedes: { eventId: first.event.id, version: 1 } });
    expect(second.event).toMatchObject({ inputValue: { formatting: { quotes: "single" }, testing: true }, value: second.current.value, memoryVersion: 2, evolutionAction: "merged", supersedes: { eventId: first.event.id, version: 1 } });
    const history = await service.history({ userId: "u1", agentId: "codex", memoryId: first.current.id });
    expect(history.events.find((event) => event.memoryVersion === 2)).toMatchObject({ memoryVersion: 2, evolutionAction: "merged", writeMode: "merge", expectedVersion: 1 });
  });

  it("rejects stale expectedVersion without changing memory or history", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "status", value: "draft", kind: "task_state", expectedVersion: 0, idempotencyKey: "cas-create" });
    await service.remember({ userId: "u1", agentId: "claude", key: "status", value: "ready", kind: "task_state", expectedVersion: 1, idempotencyKey: "cas-update" });

    await expect(service.remember({ userId: "u1", agentId: "glm", key: "status", value: "stale", kind: "task_state", expectedVersion: 1, idempotencyKey: "cas-stale" })).rejects.toMatchObject({
      code: "VERSION_CONFLICT", status: 409, details: expect.objectContaining({ expectedVersion: 1, currentVersion: 2 }),
    });
    expect((await service.recall({ userId: "u1", agentId: "reader", key: "status" })).memories[0]).toMatchObject({ value: "ready", version: 2 });
    expect((await service.history({ userId: "u1", agentId: "reader" })).events).toHaveLength(2);
  });

  it("validates deterministic merge and confidence provenance", async () => {
    const service = new MemoryService();
    await expect(service.remember({ userId: "u1", agentId: "codex", key: "bad_merge", value: "text", kind: "user_fact", writeMode: "merge", idempotencyKey: "bad-merge" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.remember({ userId: "u1", agentId: "codex", key: "bad_confidence", value: true, kind: "user_fact", confidence: 0.7, idempotencyKey: "bad-confidence" })).rejects.toThrow(/confidenceBasis/);
    await expect(service.remember({ userId: "u1", agentId: "codex", key: "false_assertion", value: true, kind: "user_fact", confidence: 1, confidenceBasis: "user_asserted", idempotencyKey: "false-assertion" })).rejects.toThrow(/userConfirmed/);
  });
});
