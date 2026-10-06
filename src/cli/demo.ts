import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { OPEN_CONTINUITY_VERSION } from "../version.js";

const memorySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  sourceAgentId: z.string(),
});

const rememberResultSchema = z.object({ current: memorySchema });
const recallResultSchema = z.object({ memories: z.array(memorySchema).min(1) });
const handoffCreateResultSchema = z.object({
  capsule: z.object({ taskId: z.string(), sourceAgentId: z.string() }),
});
const handoffResumeResultSchema = z.object({
  status: z.literal("ready"),
  capsule: z.object({
    taskId: z.string(),
    sourceAgentId: z.string(),
    summary: z.string(),
    nextActions: z.array(z.string()),
  }),
});
const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.unknown()),
});
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });

export interface DemoResult {
  ok: true;
  mode: "isolated";
  transport: "MCP stdio";
  tools: number;
  sharedMemory: {
    key: string;
    value: unknown;
    writtenBy: string;
    readBy: string;
    persistedAcrossAgentRestart: true;
  };
  handoff: {
    taskId: string;
    createdBy: string;
    resumedBy: string;
    status: "ready";
    summary: string;
    nextActions: string[];
  };
  cleanup: { temporaryDatabaseRemoved: true };
}

function childEnvironment(databasePath: string, userId: string, agentId: string, env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    OPEN_CONTINUITY_PROFILE: "lite",
    OPEN_CONTINUITY_STORE: "sqlite",
    OPEN_CONTINUITY_SQLITE_PATH: databasePath,
    OPEN_CONTINUITY_USER_ID: userId,
    OPEN_CONTINUITY_AGENT_ID: agentId,
    OPEN_CONTINUITY_ALLOW_PRIVATE: "false",
  };
}

async function withClient<T>(serverPath: string, databasePath: string, userId: string, agentId: string, env: NodeJS.ProcessEnv, operation: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--mcp"],
    stderr: "pipe",
    env: childEnvironment(databasePath, userId, agentId, env),
  });
  const client = new Client({ name: `open-continuity-demo-${agentId}`, version: OPEN_CONTINUITY_VERSION });
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callJson<T extends z.ZodType>(client: Client, name: string, args: Record<string, unknown>, schema: T): Promise<z.output<T>> {
  const result = toolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const text = result.content.map((block) => textBlockSchema.safeParse(block)).find((block) => block.success)?.data;
  if (!text || result.isError) throw new Error(`Demo tool ${name} failed${text ? `: ${text.text}` : ""}`);
  return schema.parse(JSON.parse(text.text));
}

export async function runDemo(serverPath: string, env: NodeJS.ProcessEnv = process.env): Promise<DemoResult> {
  const directory = mkdtempSync(join(tmpdir(), "open-continuity-demo-"));
  const databasePath = join(directory, "demo.db");
  const userId = `demo-user-${randomUUID()}`;
  const taskId = `demo-task-${randomUUID()}`;
  const firstAgent = "demo-agent-a";
  const secondAgent = "demo-agent-b";
  const preference = "Use concise summaries and list verification results.";

  try {
    const firstPhase = await withClient(serverPath, databasePath, userId, firstAgent, env, async (client) => {
      const tools = await client.listTools();
      const remembered = await callJson(client, "memory_remember", {
        key: "response_style",
        value: preference,
        kind: "user_preference",
        userConfirmed: true,
        confidence: 1,
        confidenceBasis: "user_asserted",
        idempotencyKey: `demo-memory-${randomUUID()}`,
      }, rememberResultSchema);
      const handoff = await callJson(client, "memory_handoff_create", {
        taskId,
        summary: "The shared-memory demo is ready for the second agent.",
        decisions: ["Use one user identity and separate Agent identities."],
        nextActions: ["Resume the task from demo-agent-b."],
        idempotencyKey: `demo-handoff-${randomUUID()}`,
      }, handoffCreateResultSchema);
      return { tools: tools.tools.length, remembered, handoff };
    });

    // Closing Agent A before Agent B starts proves the state survives an Agent process restart.
    const secondPhase = await withClient(serverPath, databasePath, userId, secondAgent, env, async (client) => {
      const recalled = await callJson(client, "memory_recall", { key: "response_style", limit: 1 }, recallResultSchema);
      const resumed = await callJson(client, "memory_handoff_resume", { taskId }, handoffResumeResultSchema);
      return { recalled, resumed };
    });

    const memory = secondPhase.recalled.memories[0];
    return {
      ok: true,
      mode: "isolated",
      transport: "MCP stdio",
      tools: firstPhase.tools,
      sharedMemory: {
        key: memory.key,
        value: memory.value,
        writtenBy: firstPhase.remembered.current.sourceAgentId,
        readBy: secondAgent,
        persistedAcrossAgentRestart: true,
      },
      handoff: {
        taskId: secondPhase.resumed.capsule.taskId,
        createdBy: firstPhase.handoff.capsule.sourceAgentId,
        resumedBy: secondAgent,
        status: secondPhase.resumed.status,
        summary: secondPhase.resumed.capsule.summary,
        nextActions: secondPhase.resumed.capsule.nextActions,
      },
      cleanup: { temporaryDatabaseRemoved: true },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
