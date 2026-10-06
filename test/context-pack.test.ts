import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../src/core/context-pack.js";
import { MemoryService } from "../src/core/memory-service.js";

describe("ContextPackBuilder", () => {
  it("prioritizes task context for coding and explains every selection", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "project answers should be concise", kind: "user_preference", userConfirmed: true, idempotencyKey: "context-rank-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "build_state", value: "project build is failing", kind: "task_state", scope: "task", taskId: "t1", idempotencyKey: "context-rank-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "architecture", value: "project uses TypeScript", kind: "decision", idempotencyKey: "context-rank-3" });

    const result = await service.context({ userId: "u1", agentId: "claude", query: "project", taskId: "t1", purpose: "coding", tokenBudget: 1024 });

    expect(result.items.map((item) => item.key)).toEqual(["build_state", "response_style", "architecture"]);
    expect(result.items[0].reasons).toEqual(expect.arrayContaining(["retrieval_full_text", "task_scope", "purpose_coding"]));
    expect(result.items[1].reasons).toContain("user_confirmed");
    expect(result.items.every((item) => item.version === 1)).toBe(true);
    expect(result.items.every((item) => item.reasons.includes("purpose_coding"))).toBe(true);
    expect(result.context.split("\n").map((line) => JSON.parse(line).key)).toEqual(result.items.map((item) => item.key));
    expect(result.budget.usedTokens).toBe(estimateContextTokens(result.context));
    expect(result.retrieval).toMatchObject({ mode: "hybrid", channels: ["structured", "full_text"] });
  });

  it("omits whole memories at the token boundary instead of truncating them", async () => {
    const service = new MemoryService(undefined, {}, { defaultTokenBudget: 64, maxTokenBudget: 512, maxMemories: 20 });
    for (let index = 0; index < 3; index += 1) {
      await service.remember({ userId: "u1", agentId: "codex", key: `budget_${index}`, value: `budget ${"x".repeat(100)}`, kind: "user_fact", idempotencyKey: `context-budget-${index}` });
    }

    const result = await service.context({ userId: "u1", agentId: "claude", query: "budget", tokenBudget: 64 });

    expect(result.items).toHaveLength(1);
    expect(result.omitted).toHaveLength(2);
    expect(result.omitted.every((item) => item.reason === "token_budget")).toBe(true);
    expect(result.context).not.toContain("…");
    expect(result.budget).toMatchObject({ requestedTokens: 64, usedTokens: estimateContextTokens(result.context), remainingTokens: 64 - estimateContextTokens(result.context), estimation: "utf8_bytes_v1" });
  });

  it("enforces maxMemories and the active profile token ceiling", async () => {
    const service = new MemoryService(undefined, {}, { defaultTokenBudget: 256, maxTokenBudget: 512, maxMemories: 2 });
    for (let index = 0; index < 3; index += 1) {
      await service.remember({ userId: "u1", agentId: "codex", key: `limit_${index}`, value: `shared limit ${index}`, kind: "user_fact", idempotencyKey: `context-limit-${index}` });
    }

    const result = await service.context({ userId: "u1", agentId: "claude", query: "shared limit", tokenBudget: 256, maxMemories: 100 });
    expect(result.items).toHaveLength(2);
    expect(result.omitted).toEqual([expect.objectContaining({ reason: "max_memories" })]);
    expect(result.budget.maxMemories).toBe(2);

    await expect(service.context({ userId: "u1", agentId: "claude", query: "shared limit", tokenBudget: 513 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR", details: { requestedTokens: 513, maxTokenBudget: 512 },
    });
  });

  it("returns an empty, zero-cost pack when retrieval has no match", async () => {
    const service = new MemoryService();
    const result = await service.context({ userId: "u1", agentId: "claude", query: "missing" });
    expect(result).toMatchObject({ context: "", items: [], omitted: [], budget: { usedTokens: 0, remainingTokens: 1024 } });
    expect(result.retrieval).toMatchObject({ channels: [], candidateCount: 0 });
  });
});
