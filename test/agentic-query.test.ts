import { describe, expect, it } from "vitest";
import { AgenticQueryEngine } from "../src/core/agentic-query.js";
import { MemoryService } from "../src/core/memory-service.js";
import { InMemoryStore } from "../src/core/memory-store.js";
import { RetrievalPipeline } from "../src/core/retrieval.js";

describe("AgenticQueryEngine", () => {
  it("keeps a simple key query on a direct L0 plan", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "response_style", value: "concise", kind: "user_preference", idempotencyKey: "query-direct" });

    const result = await service.query({ userId: "u1", agentId: "claude", query: "what response style should I use?", key: "response_style" });

    expect(result.plan).toMatchObject({ complexity: "L0", strategy: "direct", rationale: ["explicit_key"], steps: [{ type: "recall", query: "response_style" }] });
    expect(result.steps).toEqual([expect.objectContaining({ status: "completed", candidateCount: 1 })]);
    expect(result.evidence).toEqual([expect.objectContaining({ memory: expect.objectContaining({ key: "response_style" }), matchedQueries: ["response_style"] })]);
    expect(result.sufficiency).toMatchObject({ status: "sufficient", matchedQueries: 1, totalQueries: 1 });
    expect(result.fallback).toEqual({ used: false, reasons: [], mode: "deterministic" });
  });

  it("executes explicit subqueries, fuses evidence, and attaches evolution history", async () => {
    const service = new MemoryService();
    const first = await service.remember({ userId: "u1", agentId: "codex", key: "language", value: "project uses TypeScript", kind: "decision", idempotencyKey: "query-multi-1" });
    await service.remember({ userId: "u1", agentId: "claude", key: "language", value: "project uses modern TypeScript", kind: "decision", expectedVersion: 1, idempotencyKey: "query-multi-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "testing", value: "project tests use Vitest", kind: "decision", idempotencyKey: "query-multi-3" });

    const result = await service.query({
      userId: "u1", agentId: "glm", query: "project decisions history", strategy: "multi_step",
      subqueries: ["TypeScript", "Vitest"], includeHistory: true, minEvidence: 2, maxSteps: 3,
    });

    expect(result.plan).toMatchObject({ complexity: "L2", strategy: "multi_step", rationale: expect.arrayContaining(["query_decomposed", "history_signal"]) });
    expect(result.steps.map((step) => [step.type, step.status])).toEqual([["recall", "completed"], ["recall", "completed"], ["history", "completed"]]);
    expect(result.evidence.map((item) => item.memory.key).sort()).toEqual(["language", "testing"]);
    expect(result.evidence.find((item) => item.memory.id === first.current.id)?.history).toMatchObject({ eventCount: 2, versions: [1, 2] });
    expect(result.sufficiency).toMatchObject({ status: "sufficient", matchedQueries: 2, totalQueries: 2, evidenceCount: 2 });
    expect(result.contextPack.items).toHaveLength(2);
    expect(result.execution).toMatchObject({ maxSteps: 3, completedSteps: 3, stoppedReason: "completed" });
  });

  it("stops at maxSteps and reports partial evidence without pretending completion", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "decision", idempotencyKey: "query-limit-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "testing", value: "Vitest", kind: "decision", idempotencyKey: "query-limit-2" });

    const result = await service.query({ userId: "u1", agentId: "claude", query: "technology", strategy: "multi_step", subqueries: ["TypeScript", "Vitest"], maxSteps: 1, minEvidence: 2 });

    expect(result.steps).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "skipped", detail: "max_steps" })]);
    expect(result.execution).toMatchObject({ completedSteps: 1, stoppedReason: "max_steps" });
    expect(result.sufficiency).toMatchObject({ status: "partial", matchedQueries: 1, totalQueries: 2, reasons: expect.arrayContaining(["partial_query_coverage", "max_steps"]) });
    expect(result.fallback).toMatchObject({ used: true, reasons: expect.arrayContaining(["max_steps", "insufficient_evidence"]) });
  });

  it("marks L3 relationship questions as an unsupported deterministic fallback", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "project_goal", value: "ship a prototype", kind: "task_state", idempotencyKey: "query-l3" });
    const result = await service.query({ userId: "u1", agentId: "claude", query: "project root cause" });
    expect(result.plan).toMatchObject({ complexity: "L3", rationale: expect.arrayContaining(["graph_or_semantic_reasoning_unavailable"]) });
    expect(result.evidence).toHaveLength(1);
    expect(result.sufficiency).toMatchObject({ status: "partial", evidenceCount: 1, reasons: expect.arrayContaining(["unsupported_complexity"]) });
    expect(result.fallback).toMatchObject({ used: true, reasons: expect.arrayContaining(["unsupported_complexity", "insufficient_evidence"]), mode: "deterministic" });
  });

  it("enforces profile budgets and records a timed-out step", async () => {
    const store = new InMemoryStore();
    const retrieval = new RetrievalPipeline(store, {}, { fullText: { channel: "full_text", retrieve: () => new Promise((resolve) => setTimeout(() => resolve([]), 30)) } });
    const engine = new AgenticQueryEngine(store, retrieval, { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 }, { defaultMaxSteps: 2, maxSteps: 2, defaultTimeoutMs: 10, maxTimeoutMs: 20, maxSubqueries: 2, historyLimit: 20 });
    const input = { userId: "u1", agentId: "claude", query: "slow", includePrivate: false, purpose: "general" as const, strategy: "auto" as const, includeHistory: false, minEvidence: 1 };

    const timedOut = await engine.query({ ...input, timeoutMs: 10 });
    expect(timedOut.steps).toEqual([expect.objectContaining({ status: "timed_out", detail: "timeout" })]);
    expect(timedOut.execution.stoppedReason).toBe("timeout");
    expect(timedOut.fallback.reasons).toEqual(expect.arrayContaining(["timeout", "insufficient_evidence"]));
    await expect(engine.query({ ...input, maxSteps: 3 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(engine.query({ ...input, timeoutMs: 21 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("queries history by recalled memory and reports a truncated history budget", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(
      store, {},
      { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 },
      { defaultMaxSteps: 2, maxSteps: 2, defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxSubqueries: 2, historyLimit: 2 },
    );
    await service.remember({ userId: "u1", agentId: "codex", key: "runtime", value: "v1", kind: "decision", idempotencyKey: "history-budget-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "runtime", value: "v2", kind: "decision", idempotencyKey: "history-budget-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "runtime", value: "v3", kind: "decision", idempotencyKey: "history-budget-3" });

    const result = await service.query({ userId: "u1", agentId: "claude", query: "runtime history", includeHistory: true });

    expect(result.steps.at(-1)).toMatchObject({ type: "history", status: "completed", candidateCount: 2, detail: "history_limit" });
    expect(result.evidence[0]?.history).toMatchObject({ eventCount: 2, truncated: true });
    expect(result.evidence[0]?.history?.versions).toHaveLength(2);
    expect(result.sufficiency).toMatchObject({ status: "partial", reasons: expect.arrayContaining(["history_limit"]) });
    expect(result.fallback.reasons).toEqual(expect.arrayContaining(["history_limit", "insufficient_evidence"]));
  });

  it("rejects explicit subqueries above the active profile limit", async () => {
    const service = new MemoryService();
    await expect(service.query({
      userId: "u1", agentId: "claude", query: "too many", strategy: "multi_step", subqueries: ["one", "two", "three", "four"],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { subqueries: 4, profileMaxSubqueries: 3 } });
  });

  it("marks automatically decomposed queries above the profile limit as partial", async () => {
    const service = new MemoryService();
    for (const [index, value] of ["one", "two", "three", "four"].entries()) {
      await service.remember({ userId: "u1", agentId: "codex", key: `item_${index}`, value, kind: "user_fact", idempotencyKey: `automatic-limit-${index}` });
    }

    const result = await service.query({ userId: "u1", agentId: "claude", query: "one and two and three and four", maxSteps: 4 });

    expect(result.plan).toMatchObject({ complexity: "L2", rationale: expect.arrayContaining(["subquery_limit_applied"]) });
    expect(result.steps).toHaveLength(3);
    expect(result.sufficiency).toMatchObject({ status: "partial", matchedQueries: 3, totalQueries: 4, reasons: expect.arrayContaining(["partial_query_coverage"]) });
    expect(result.fallback.reasons).toEqual(expect.arrayContaining(["subquery_limit", "insufficient_evidence"]));
  });

  it("preserves scope and private-memory boundaries across every retrieval step", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "public", value: "shared public", kind: "user_fact", idempotencyKey: "query-scope-1" });
    await service.remember({ userId: "u1", agentId: "codex", key: "private", value: "shared private", kind: "user_fact", sensitivity: "private", idempotencyKey: "query-scope-2" });
    await service.remember({ userId: "u1", agentId: "codex", key: "task", value: "shared task", kind: "task_state", scope: "task", taskId: "task-a", idempotencyKey: "query-scope-3" });
    await service.remember({ userId: "u1", agentId: "codex", key: "agent", value: "shared agent", kind: "task_state", scope: "agent", idempotencyKey: "query-scope-4" });

    const publicResult = await service.query({ userId: "u1", agentId: "claude", query: "shared", taskId: "task-a", includeHistory: true });
    expect(publicResult.evidence.map((item) => item.memory.key).sort()).toEqual(["public", "task"]);
    expect(publicResult.evidence.flatMap((item) => item.history?.eventIds ?? [])).toHaveLength(2);

    const privateResult = await service.query({ userId: "u1", agentId: "claude", query: "shared", taskId: "task-a", includePrivate: true });
    expect(privateResult.evidence.map((item) => item.memory.key).sort()).toEqual(["private", "public", "task"]);
  });

  it("keeps direct strategy to one recall even when the query contains a history signal", async () => {
    const service = new MemoryService();
    await service.remember({ userId: "u1", agentId: "codex", key: "runtime", value: "TypeScript", kind: "decision", idempotencyKey: "query-direct-history-1" });

    const result = await service.query({ userId: "u1", agentId: "claude", query: "TypeScript history", strategy: "direct" });

    expect(result.plan).toMatchObject({ strategy: "direct", complexity: "L1", rationale: expect.arrayContaining(["history_signal_ignored_by_direct_strategy"]) });
    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.steps[0]?.type).toBe("recall");
    expect(result.evidence[0]?.history).toBeUndefined();
  });
});
