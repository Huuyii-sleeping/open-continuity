import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccessPolicy } from "../src/core/access-policy.js";
import { MemoryService } from "../src/core/memory-service.js";
import { createMcpServer } from "../src/mcp/server.js";
import { SqliteMemoryStore } from "../src/sqlite/sqlite-memory-store.js";
import { runInjectionHook } from "../src/injection/injection-service.js";
import { installFakeTraeCli } from "./helpers/fake-trae.js";

function textFromToolResult(result: unknown): string {
  const raw = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : undefined;
  const content = Array.isArray(raw) ? raw as Array<{ type: string; text?: string }> : [];
  return content.find((item) => item.type === "text")?.text ?? "{}";
}

describe("Trae vertical adapter flow", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("captures a complete visible thread, injects a light pack, and deep-searches through MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-trae-vertical-"));
    directories.push(root);
    const bin = installFakeTraeCli(root);
    const workspace = join(root, "fictional-workspace");
    const env = {
      ...process.env,
      HOME: join(root, "home"),
      OPEN_CONTINUITY_HOME: join(root, "data"),
      TEST_TRAE_WORKSPACE: workspace,
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js");

    execFileSync(process.execPath, [cli, "init", "--json"], { env, encoding: "utf8" });
    execFileSync(process.execPath, [cli, "capture", "enable", workspace, "--json"], { env, encoding: "utf8" });
    const sync = JSON.parse(execFileSync(process.execPath, [cli, "capture", "sync", "--limit", "10", "--json"], { env, encoding: "utf8" })) as { threadIds: string[]; candidatesCreated: number };
    expect(sync).toMatchObject({ candidatesCreated: 1 });

    const captured = JSON.parse(execFileSync(process.execPath, [cli, "capture", "thread", sync.threadIds[0]!, "--json"], { env, encoding: "utf8" })) as { items: Array<{ type: string; text?: string; toolName?: string }> };
    expect(captured.items.map((item) => item.type)).toEqual(["user_message", "assistant_message", "tool_call", "assistant_message"]);
    expect(captured.items[0]?.text).toContain("先给结论");
    expect(captured.items[1]?.text).toContain("正在处理虚构测试");
    expect(captured.items[2]?.toolName).toBe("shell");
    expect(captured.items[3]?.text).toContain("收到");

    const candidates = JSON.parse(execFileSync(process.execPath, [cli, "capture", "candidates", "--json"], { env, encoding: "utf8" })) as { candidates: Array<{ id: string }> };
    const approved = JSON.parse(execFileSync(process.execPath, [cli, "capture", "approve", candidates.candidates[0]!.id, "--share", "--json"], { env, encoding: "utf8" })) as { candidate: { sensitivity: string; status: string } };
    expect(approved).toMatchObject({ candidate: { status: "approved", sensitivity: "public" } });

    execFileSync(process.execPath, [cli, "injection", "enable", workspace, "--json"], { env, encoding: "utf8" });
    const config = JSON.parse(readFileSync(join(root, "data/config.json"), "utf8")) as { userId: string; databasePath: string };

    const lightOutput = await runInjectionHook({
      prompt: "请按照先给结论，再列出验证结果的风格处理虚构项目",
      cwd: workspace,
      session_id: "fictional-trae-session",
    }, env);
    expect(lightOutput.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(lightOutput.hookSpecificOutput?.additionalContext).toContain("先给结论，再列出验证结果");

    const service = new MemoryService(new SqliteMemoryStore(config.databasePath));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fictional-trae-agent", version: "0.1.0" });
    const server = createMcpServer(service, new AccessPolicy(), undefined, { userId: config.userId, agentId: "trae" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["memory_recall", "memory_query"]));

      await client.callTool({ name: "memory_remember", arguments: {
        key: "testing_strategy", value: "虚构项目测试策略是先运行类型检查再运行完整测试", kind: "decision", userConfirmed: true, idempotencyKey: "vertical-testing-strategy",
      } });
      await client.callTool({ name: "memory_remember", arguments: {
        key: "release_strategy", value: "虚构项目发布策略是先做内部预览", kind: "decision", userConfirmed: true, idempotencyKey: "vertical-release-strategy",
      } });

      const deepResult = await client.callTool({ name: "memory_query", arguments: {
        query: "虚构项目测试和发布策略", strategy: "multi_step", subqueries: ["测试策略", "发布策略"], minEvidence: 2, purpose: "coding",
      } });
      const deep = JSON.parse(textFromToolResult(deepResult));
      expect(deep).toMatchObject({
        plan: { strategy: "multi_step" },
        execution: { stoppedReason: "completed" },
        sufficiency: { status: "sufficient", matchedQueries: 2, totalQueries: 2 },
      });
      expect(deep.evidence.map((item: { memory: { key: string } }) => item.memory.key)).toEqual(expect.arrayContaining(["testing_strategy", "release_strategy"]));
    } finally {
      await client.close();
      await server.close();
      await service.close();
    }
  }, 30_000);
});
