import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AccessPolicy } from "../core/access-policy.js";
import { MemoryService } from "../core/memory-service.js";
import { errorResponse } from "../shared/errors.js";
import { developmentCapabilities, type RuntimeCapabilities } from "../core/profile.js";
import { OPEN_CONTINUITY_VERSION } from "../version.js";

export interface McpIdentity { userId?: string; agentId?: string; }

const SERVER_INSTRUCTIONS = `OpenContinuity is a user-controlled shared memory service. At the start of a task, use memory_context or memory_handoff_resume when prior context may help. Use memory_remember only for durable preferences, facts, decisions, or explicit task state; never store credentials, secrets, or entire conversations. When the user asks to hand off work, use memory_handoff_create. When identity fields are hidden by the server configuration, the runtime supplies them automatically.`;

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function toolError(error: unknown) {
  return { ...toolResult(errorResponse(error)), isError: true };
}

export function createMcpServer(service = new MemoryService(), policy = new AccessPolicy(), capabilities: RuntimeCapabilities = developmentCapabilities(), identity: McpIdentity = {}): McpServer {
  const server = new McpServer({ name: "open-continuity", version: OPEN_CONTINUITY_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const identitySchema = {
    ...(identity.userId ? {} : { userId: z.string().min(1) }),
    ...(identity.agentId ? {} : { agentId: z.string().min(1) }),
  };
  const withIdentity = <T extends { userId?: string; agentId?: string }>(input: T) => ({
    ...input, userId: identity.userId ?? input.userId!, agentId: identity.agentId ?? input.agentId!,
  });

  server.registerTool("memory_capabilities", {
    description: "Describe the active OpenContinuity profile, storage, retrieval channels, budgets, and unavailable advanced capabilities.",
    inputSchema: {},
  }, async () => toolResult(capabilities));

  server.registerTool("memory_remember", {
    description: "Create or evolve a shared preference, fact, task state, or decision. Use expectedVersion to prevent stale writes; merge deterministically combines JSON objects.",
    inputSchema: {
      ...identitySchema, key: z.string().min(1), value: z.unknown(),
      kind: z.enum(["user_preference", "user_fact", "task_state", "decision"]),
      scope: z.enum(["user", "task", "agent"]).optional(), taskId: z.string().min(1).optional(),
      sensitivity: z.enum(["public", "private"]).optional(), userConfirmed: z.boolean().optional(),
      idempotencyKey: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(),
      writeMode: z.enum(["replace", "merge"]).optional(), expectedVersion: z.number().int().min(0).optional(),
      confidence: z.number().min(0).max(1).optional(), confidenceBasis: z.enum(["user_asserted", "agent_inferred", "source_supported"]).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "remember", transport: "mcp", agentId: resolved.agentId });
      return toolResult(await service.remember(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_recall", {
    description: "Read a small page of current memories visible to this user, agent, and task. A query uses exact/full-text hybrid retrieval with an explainable score receipt; history is returned by memory_history.",
    inputSchema: {
      ...identitySchema, query: z.string().optional(), key: z.string().min(1).optional(),
      kind: z.enum(["user_preference", "user_fact", "task_state", "decision"]).optional(),
      scope: z.enum(["user", "task", "agent"]).optional(), taskId: z.string().min(1).optional(),
      includePrivate: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "recall", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.recall(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_context", {
    description: "Build a deterministic, token-budgeted memory context pack for an agent task, with selection and omission reasons.",
    inputSchema: {
      ...identitySchema, query: z.string().min(1), key: z.string().min(1).optional(),
      kind: z.enum(["user_preference", "user_fact", "task_state", "decision"]).optional(),
      scope: z.enum(["user", "task", "agent"]).optional(), taskId: z.string().min(1).optional(),
      includePrivate: z.boolean().optional(), purpose: z.enum(["general", "coding", "research", "browser"]).optional(),
      tokenBudget: z.number().int().min(64).max(32768).optional(), maxMemories: z.number().int().min(1).max(100).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "context", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.context(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_query", {
    description: "Run a bounded, auditable retrieval plan with optional subqueries and memory history, then return evidence sufficiency, fallback reasons, and a context pack.",
    inputSchema: {
      ...identitySchema, query: z.string().min(1), key: z.string().min(1).optional(),
      kind: z.enum(["user_preference", "user_fact", "task_state", "decision"]).optional(),
      scope: z.enum(["user", "task", "agent"]).optional(), taskId: z.string().min(1).optional(), includePrivate: z.boolean().optional(),
      purpose: z.enum(["general", "coding", "research", "browser"]).optional(), tokenBudget: z.number().int().min(64).max(32768).optional(),
      maxMemories: z.number().int().min(1).max(100).optional(), strategy: z.enum(["auto", "direct", "multi_step"]).optional(),
      subqueries: z.array(z.string().min(1)).min(1).max(8).optional(), includeHistory: z.boolean().optional(),
      maxSteps: z.number().int().min(1).max(8).optional(), timeoutMs: z.number().int().min(10).max(30000).optional(), minEvidence: z.number().int().min(1).max(20).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "query", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.query(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_history", {
    description: "Read a paginated audit history separately from current memory recall.",
    inputSchema: {
      ...identitySchema, memoryId: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(), includePrivate: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(), cursor: z.string().min(1).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "history", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.history(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_forget", {
    description: "Forget one shared memory item after the user asks to remove it.",
    inputSchema: { ...identitySchema, memoryId: z.string().min(1), taskId: z.string().min(1).optional(), includePrivate: z.boolean().optional() },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "forget", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.forget(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_handoff_create", {
    description: "Create or replace a task-scoped handoff capsule when the user asks to transfer work to another agent.",
    inputSchema: {
      ...identitySchema, taskId: z.string().min(1), summary: z.string().min(1), status: z.enum(["ready", "blocked", "in_progress"]).optional(),
      decisions: z.array(z.string().min(1)).max(50).optional(), nextActions: z.array(z.string().min(1)).max(50).optional(),
      artifacts: z.array(z.string().min(1)).max(100).optional(), blockedBy: z.array(z.string().min(1)).max(50).optional(),
      expiresAt: z.iso.datetime({ offset: true }).optional(), sensitivity: z.enum(["public", "private"]).optional(),
      idempotencyKey: z.string().min(1), metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "handoff_create", transport: "mcp", agentId: resolved.agentId });
      return toolResult(await service.createHandoff(resolved));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("memory_handoff_resume", {
    description: "Resume the latest non-expired handoff capsule for a task. Use this when starting work that another agent may have handed off.",
    inputSchema: { ...identitySchema, taskId: z.string().min(1), includePrivate: z.boolean().optional() },
  }, async (input) => {
    try {
      const resolved = withIdentity(input);
      policy.authorize({ operation: "handoff_resume", transport: "mcp", agentId: resolved.agentId, includePrivate: input.includePrivate });
      return toolResult(await service.resumeHandoff(resolved));
    } catch (error) { return toolError(error); }
  });

  return server;
}

export async function startMcpStdio(service = new MemoryService(), policy = new AccessPolicy(), capabilities: RuntimeCapabilities = developmentCapabilities(), identity: McpIdentity = {}): Promise<void> {
  const server = createMcpServer(service, policy, capabilities, identity);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
