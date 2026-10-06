import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { AccessPolicy } from "../src/core/access-policy.js";

describe("MCP server", () => {
  const connections: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

  afterEach(async () => {
    await Promise.all(connections.map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }));
    connections.length = 0;
  });

  it("exposes shared memory tools and serves a cross-agent read", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer();
    connections.push({ client, server });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "memory_capabilities",
      "memory_remember",
      "memory_recall",
      "memory_context",
      "memory_query",
      "memory_history",
      "memory_forget",
      "memory_handoff_create",
      "memory_handoff_resume",
    ]);

    await client.callTool({
      name: "memory_remember",
      arguments: {
        userId: "u1",
        agentId: "codex",
        key: "response_style",
        value: "concise",
        kind: "user_preference",
        userConfirmed: true,
        idempotencyKey: "mcp-1",
      },
    });
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { userId: "u1", agentId: "claude" },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    const recall = JSON.parse(text?.text ?? "{}");
    expect(recall.memories[0].value).toBe("concise");
    expect(recall.events).toBeUndefined();

    const historyResult = await client.callTool({
      name: "memory_history",
      arguments: { userId: "u1", agentId: "claude" },
    });
    const historyContent = historyResult.content as Array<{ type: string; text?: string }>;
    const historyText = historyContent.find((item) => item.type === "text");
    expect(JSON.parse(historyText?.text ?? "{}").events).toHaveLength(1);
  });

  it("exposes active runtime capabilities", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "memory_capabilities", arguments: {} });
    const content = result.content as Array<{ type: string; text?: string }>;
    const value = JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}");
    expect(value).toMatchObject({ version: "1.1.0-beta.1", profile: "development", storage: "memory", memory: { evolution: { expectedVersion: true, writeModes: ["replace", "merge"], supersedes: true } }, retrieval: { candidateLimit: 50, semantic: false, rerank: false, agentic: true, graph: false }, contextPack: { enabled: true, defaultTokenBudget: 1024, maxTokenBudget: 4096, maxMemories: 20 }, agenticQuery: { planner: "deterministic_v1", maxSteps: 4, graphTraversal: false }, handoff: { enabled: true, schemaVersion: "1.0", expiration: true } });
  });

  it("binds MCP identity and supports a cross-agent handoff without model-supplied identities", async () => {
    const service = new (await import("../src/core/memory-service.js")).MemoryService();
    const [writerTransport, writerServerTransport] = InMemoryTransport.createLinkedPair();
    const writer = new Client({ name: "writer", version: "0.1.0" });
    const writerServer = createMcpServer(service, new AccessPolicy(), undefined, { userId: "demo-user", agentId: "trae" });
    connections.push({ client: writer, server: writerServer });
    await writerServer.connect(writerServerTransport); await writer.connect(writerTransport);
    const writerTools = await writer.listTools();
    const createTool = writerTools.tools.find((tool) => tool.name === "memory_handoff_create");
    expect(createTool?.inputSchema.required).not.toContain("userId");
    expect(createTool?.inputSchema.required).not.toContain("agentId");
    const created = await writer.callTool({ name: "memory_handoff_create", arguments: { taskId: "task-42", summary: "Core API is complete", nextActions: ["Add UI"], idempotencyKey: "handoff-mcp-1" } });
    expect(created.isError).not.toBe(true);

    const [readerTransport, readerServerTransport] = InMemoryTransport.createLinkedPair();
    const reader = new Client({ name: "reader", version: "0.1.0" });
    const readerServer = createMcpServer(service, new AccessPolicy(), undefined, { userId: "demo-user", agentId: "claude" });
    connections.push({ client: reader, server: readerServer });
    await readerServer.connect(readerServerTransport); await reader.connect(readerTransport);
    const resumed = await reader.callTool({ name: "memory_handoff_resume", arguments: { taskId: "task-42" } });
    const text = (resumed.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "{}")).toMatchObject({ status: "ready", capsule: { sourceAgentId: "trae", summary: "Core API is complete" } });
  });

  it("returns a protocol error for a disallowed agent", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer(undefined, new AccessPolicy({ allowedAgentIds: ["codex"] }));
    connections.push({ client, server });

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "memory_recall", arguments: { userId: "u1", agentId: "unknown" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text");
    expect(JSON.parse(text?.text ?? "{}")).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("returns hybrid retrieval provenance through MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: "memory_remember", arguments: { userId: "u1", agentId: "codex", key: "response_style", value: "concise answers", kind: "user_preference", idempotencyKey: "test-1" } });
    const result = await client.callTool({ name: "memory_recall", arguments: { userId: "u1", agentId: "claude", query: "response_style" } });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((item) => item.type === "text");
    expect(JSON.parse(text?.text ?? "{}")).toMatchObject({
      memories: [{ key: "response_style", retrieval: { channels: ["exact", "full_text"] } }],
      retrieval: { mode: "hybrid", channels: ["exact", "full_text"] },
    });
  });

  it("returns an explainable context pack through MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: "memory_remember", arguments: { userId: "u1", agentId: "codex", key: "repository_rule", value: "repository uses TypeScript", kind: "decision", idempotencyKey: "mcp-context-1" } });
    const result = await client.callTool({ name: "memory_context", arguments: { userId: "u1", agentId: "claude", query: "repository", purpose: "coding", tokenBudget: 256 } });
    const content = result.content as Array<{ type: string; text?: string }>;
    const value = JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}");
    expect(value).toMatchObject({
      items: [{ key: "repository_rule", reasons: ["retrieval_full_text", "purpose_coding"] }],
      omitted: [],
      budget: { requestedTokens: 256, estimation: "utf8_bytes_v1" },
    });
  });

  it("supports memory evolution and exposes provenance in context packs", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer();
    connections.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const firstResult = await client.callTool({ name: "memory_remember", arguments: {
      userId: "u1", agentId: "codex", key: "repository", value: { language: "TypeScript", test: "vitest" },
      kind: "decision", expectedVersion: 0, confidence: 0.9, confidenceBasis: "source_supported", idempotencyKey: "test-2",
    } });
    const firstText = (firstResult.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
    const first = JSON.parse(firstText?.text ?? "{}");

    const secondResult = await client.callTool({ name: "memory_remember", arguments: {
      userId: "u1", agentId: "claude", key: "repository", value: { test: "node:test" }, kind: "decision",
      writeMode: "merge", expectedVersion: 1, confidence: 0.8, confidenceBasis: "agent_inferred", idempotencyKey: "test-3",
    } });
    const secondText = (secondResult.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
    expect(JSON.parse(secondText?.text ?? "{}")).toMatchObject({
      current: { value: { language: "TypeScript", test: "node:test" }, version: 2, supersedes: { eventId: first.event.id, version: 1 }, confidence: { score: 0.8, basis: "agent_inferred" } },
      evolution: { action: "merged", concurrency: "compare_and_set" },
    });

    const contextResult = await client.callTool({ name: "memory_context", arguments: { userId: "u1", agentId: "glm", query: "repository", purpose: "coding" } });
    const contextText = (contextResult.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
    expect(JSON.parse(contextText?.text ?? "{}")).toMatchObject({ items: [{ key: "repository", version: 2, supersedes: { eventId: first.event.id, version: 1 }, confidence: { score: 0.8, basis: "agent_inferred" } }] });
  });

  it("runs a bounded multi-step query through MCP", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-agent", version: "0.1.0" });
    const server = createMcpServer(); connections.push({ client, server });
    await server.connect(serverTransport); await client.connect(clientTransport);
    await client.callTool({ name: "memory_remember", arguments: { userId: "u1", agentId: "codex", key: "language", value: "project uses TypeScript", kind: "decision", idempotencyKey: "mcp-query-1" } });
    await client.callTool({ name: "memory_remember", arguments: { userId: "u1", agentId: "codex", key: "testing", value: "project uses Vitest", kind: "decision", idempotencyKey: "mcp-query-2" } });
    const result = await client.callTool({ name: "memory_query", arguments: { userId: "u1", agentId: "claude", query: "project stack", strategy: "multi_step", subqueries: ["TypeScript", "Vitest"], minEvidence: 2 } });
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text");
    expect(JSON.parse(text?.text ?? "{}")).toMatchObject({ plan: { complexity: "L2", strategy: "multi_step" }, execution: { completedSteps: 2, stoppedReason: "completed" }, sufficiency: { status: "sufficient" }, fallback: { used: false } });
  });
});
