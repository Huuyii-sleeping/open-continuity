import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../src/core/access-policy.js";
import { MemoryService } from "../src/core/memory-service.js";
import { buildHttpApp } from "../src/http/app.js";

describe("HTTP API", () => {
  it("exposes health and capability discovery", async () => {
    const app = buildHttpApp();
    await app.ready();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toMatchObject({ ok: true, version: "1.1.0-beta.1", profile: "development", storage: "memory", capabilities: { memory: { evolution: { expectedVersion: true, writeModes: ["replace", "merge"], supersedes: true, automaticSemanticMerge: false } }, retrieval: { candidateLimit: 50, agentic: true }, contextPack: { defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 }, agenticQuery: { planner: "deterministic_v1", maxSteps: 4, semanticPlanner: false }, handoff: { enabled: true } } });
      const capabilities = await app.inject({ method: "GET", url: "/v1/capabilities" });
      expect(capabilities.json()).toMatchObject({ profile: "development", retrieval: { channels: ["exact", "structured", "full_text"], semantic: false }, contextPack: { enabled: true, purposes: ["general", "coding", "research", "browser"], estimation: "utf8_bytes_v1" } });
    } finally { await app.close(); }
  });

  it("creates and resumes handoff capsules through HTTP", async () => {
    const app = buildHttpApp(); await app.ready();
    try {
      const created = await app.inject({ method: "POST", url: "/v1/handoffs", payload: { userId: "demo-user", agentId: "trae", taskId: "task-http", summary: "Backend complete", nextActions: ["Build UI"], idempotencyKey: "handoff-http-1" } });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ capsule: { taskId: "task-http", sourceAgentId: "trae" } });
      const resumed = await app.inject({ method: "GET", url: "/v1/handoffs/task-http?userId=demo-user&agentId=claude" });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({ status: "ready", capsule: { summary: "Backend complete" } });
    } finally { await app.close(); }
  });

  it("returns a stable error contract and enforces API key, agent, and private policies", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy({ apiKey: "test-key", allowedAgentIds: ["codex", "claude"], allowPrivateRecall: false }));
    await app.ready();
    try {
      const unauthorized = await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "language", value: "TypeScript", kind: "user_fact", idempotencyKey: "http-test-1" } });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });

      const invalid = await app.inject({ method: "POST", url: "/v1/memories", headers: { "x-open-continuity-api-key": "test-key" }, payload: { userId: "u1", agentId: "codex", key: "", value: "TypeScript", kind: "user_fact", idempotencyKey: "http-test-2" } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

      const forbiddenAgent = await app.inject({ method: "POST", url: "/v1/memories", headers: { authorization: "Bearer test-key" }, payload: { userId: "u1", agentId: "unknown", key: "language", value: "TypeScript", kind: "user_fact", idempotencyKey: "http-test-3" } });
      expect(forbiddenAgent.statusCode).toBe(403);
      expect(forbiddenAgent.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      const remember = await app.inject({ method: "POST", url: "/v1/memories", headers: { "x-open-continuity-api-key": "test-key" }, payload: { userId: "u1", agentId: "codex", key: "secret", value: "hidden", kind: "user_fact", sensitivity: "private", idempotencyKey: "http-test-4" } });
      expect(remember.statusCode).toBe(200);
      const privateRecall = await app.inject({ method: "GET", url: "/v1/memories?userId=u1&agentId=claude&includePrivate=true", headers: { "x-open-continuity-api-key": "test-key" } });
      expect(privateRecall.statusCode).toBe(403);
      expect(privateRecall.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      const explicitlyPublicRecall = await app.inject({ method: "GET", url: "/v1/memories?userId=u1&agentId=claude&includePrivate=false", headers: { "x-open-continuity-api-key": "test-key" } });
      expect(explicitlyPublicRecall.statusCode).toBe(200);
      expect(explicitlyPublicRecall.json()).toEqual({ memories: [], nextCursor: null });
      const privateContext = await app.inject({ method: "POST", url: "/v1/context-pack", headers: { "x-open-continuity-api-key": "test-key" }, payload: { userId: "u1", agentId: "claude", query: "hidden", includePrivate: true } });
      expect(privateContext.statusCode).toBe(403);
      expect(privateContext.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    } finally {
      await app.close();
    }
  });

  it("paginates current memory and exposes history through a separate endpoint", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy());
    await app.ready();
    try {
      for (let index = 0; index < 3; index += 1) {
        await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "preference_" + index, value: "value_" + index, kind: "user_preference", idempotencyKey: "http-page-" + index } });
      }
      const first = await app.inject({ method: "GET", url: "/v1/memories?userId=u1&agentId=claude&kind=user_preference&limit=2" });
      expect(first.statusCode).toBe(200);
      const firstPage = first.json();
      expect(firstPage.memories).toHaveLength(2);
      expect(firstPage.events).toBeUndefined();
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      const second = await app.inject({ method: "GET", url: "/v1/memories?userId=u1&agentId=claude&kind=user_preference&limit=2&cursor=" + encodeURIComponent(firstPage.nextCursor) });
      expect(second.json()).toMatchObject({ memories: [{ kind: "user_preference" }], nextCursor: null });

      const history = await app.inject({ method: "GET", url: "/v1/memory-events?userId=u1&agentId=claude&limit=2" });
      expect(history.statusCode).toBe(200);
      expect(history.json().events).toHaveLength(2);
      expect(history.json().nextCursor).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });

  it("returns hybrid retrieval provenance for query requests", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy());
    await app.ready();
    try {
      await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "response_style", value: "concise answers", kind: "user_preference", idempotencyKey: "http-retrieval-1" } });
      const response = await app.inject({ method: "GET", url: "/v1/memories?userId=u1&agentId=claude&query=response_style" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        memories: [{ key: "response_style", retrieval: { channels: ["exact", "full_text"], ranks: { exact: 1, full_text: 1 } } }],
        retrieval: { mode: "hybrid", channels: ["exact", "full_text"], candidateCount: 1 },
      });
    } finally {
      await app.close();
    }
  });

  it("builds a budgeted context pack without changing recall responses", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy());
    await app.ready();
    try {
      await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "response_style", value: "concise project answers", kind: "user_preference", userConfirmed: true, idempotencyKey: "http-context-1" } });
      const response = await app.inject({ method: "POST", url: "/v1/context-pack", payload: { userId: "u1", agentId: "claude", query: "project", purpose: "coding", tokenBudget: 256 } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [{ key: "response_style", reasons: expect.arrayContaining(["retrieval_full_text", "user_confirmed", "purpose_coding"]) }],
        omitted: [],
        budget: { requestedTokens: 256, maxMemories: 20, estimation: "utf8_bytes_v1" },
        retrieval: { mode: "hybrid", channels: ["full_text"] },
      });
      expect(JSON.parse(response.json().context)).toMatchObject({ key: "response_style", value: "concise project answers" });
    } finally {
      await app.close();
    }
  });

  it("supports compare-and-set evolution and returns stable conflict errors", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy());
    await app.ready();
    try {
      const created = await app.inject({ method: "POST", url: "/v1/memories", payload: {
        userId: "u1", agentId: "codex", key: "workspace", value: { language: "TypeScript", formatting: { quotes: "double" } },
        kind: "user_preference", expectedVersion: 0, confidence: 1, confidenceBasis: "user_asserted", userConfirmed: true, idempotencyKey: "http-evolution-1",
      } });
      expect(created.statusCode).toBe(200);
      const first = created.json();
      expect(first.evolution).toMatchObject({ action: "created", version: 1, concurrency: "compare_and_set" });

      const merged = await app.inject({ method: "POST", url: "/v1/memories", payload: {
        userId: "u1", agentId: "claude", key: "workspace", value: { formatting: { quotes: "single" } },
        kind: "user_preference", writeMode: "merge", expectedVersion: 1, idempotencyKey: "http-evolution-2",
      } });
      expect(merged.statusCode).toBe(200);
      expect(merged.json()).toMatchObject({
        current: { value: { language: "TypeScript", formatting: { quotes: "single" } }, version: 2, supersedes: { eventId: first.event.id, version: 1 } },
        evolution: { action: "merged", version: 2, writeMode: "merge", concurrency: "compare_and_set" },
      });

      const stale = await app.inject({ method: "POST", url: "/v1/memories", payload: {
        userId: "u1", agentId: "glm", key: "workspace", value: { stale: true }, kind: "user_preference", expectedVersion: 1, idempotencyKey: "http-evolution-stale",
      } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: "VERSION_CONFLICT", details: { expectedVersion: 1, currentVersion: 2 } } });
    } finally {
      await app.close();
    }
  });

  it("executes a bounded agentic query and applies access policy", async () => {
    const app = buildHttpApp(new MemoryService(), new AccessPolicy({ allowedAgentIds: ["codex", "claude"] }));
    await app.ready();
    try {
      await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "language", value: "project uses TypeScript", kind: "decision", idempotencyKey: "http-query-1" } });
      await app.inject({ method: "POST", url: "/v1/memories", payload: { userId: "u1", agentId: "codex", key: "testing", value: "project uses Vitest", kind: "decision", idempotencyKey: "http-query-2" } });
      const response = await app.inject({ method: "POST", url: "/v1/query", payload: { userId: "u1", agentId: "claude", query: "project stack", strategy: "multi_step", subqueries: ["TypeScript", "Vitest"], minEvidence: 2 } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ plan: { complexity: "L2", strategy: "multi_step" }, sufficiency: { status: "sufficient", matchedQueries: 2, evidenceCount: 2 }, fallback: { used: false } });
      const forbidden = await app.inject({ method: "POST", url: "/v1/query", payload: { userId: "u1", agentId: "glm", query: "project" } });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    } finally { await app.close(); }
  });
});
