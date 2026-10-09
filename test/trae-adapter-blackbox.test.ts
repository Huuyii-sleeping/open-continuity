import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installFakeTraeCli } from "./helpers/fake-trae.js";

function toolText(result: unknown): string {
  const content = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : undefined;
  const text = Array.isArray(content) ? content.find((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text") : undefined;
  return text && typeof text === "object" && "text" in text ? String((text as { text: unknown }).text) : "{}";
}

describe("Trae adapter process black box", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("runs setup, Capture, the installed Hook process, and MCP over stdio", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-trae-blackbox-")); directories.push(root);
    const bin = installFakeTraeCli(root);
    const workspace = join(root, "fictional-workspace");
    const env = {
      ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data"), TRAECLI_HOME: join(root, "trae-cli"),
      TEST_STATE_DIR: join(root, "state"), PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js");
    const server = join(process.cwd(), "dist/src/server.js");
    const hook = join(process.cwd(), "dist/src/injection-hook.js");

    const setup = JSON.parse(execFileSync(process.execPath, [cli, "setup", "trae", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(setup).toMatchObject({ ok: true, doctor: { ok: true } });
    const hooksDocument = JSON.parse(readFileSync(join(root, "trae-cli/hooks.json"), "utf8"));
    expect(JSON.stringify(hooksDocument)).toContain(hook);

    const sync = JSON.parse(execFileSync(process.execPath, [cli, "capture", "sync", "--json"], { env, encoding: "utf8" }));
    expect(sync).toMatchObject({ threadsImported: 1, itemsImported: 4, candidatesCreated: 1 });
    const candidates = JSON.parse(execFileSync(process.execPath, [cli, "capture", "candidates", "--json"], { env, encoding: "utf8" }));
    execFileSync(process.execPath, [cli, "capture", "approve", candidates.candidates[0].id, "--share", "--json"], { env, encoding: "utf8" });

    for (const sessionId of ["fictional-session-a", "fictional-session-b", "fictional-session-c"]) {
      const hookOutput = JSON.parse(execFileSync(process.execPath, [hook], {
        env, encoding: "utf8", input: JSON.stringify({
          prompt: "请按照先给结论，再列出验证结果的风格处理虚构项目", cwd: workspace, session_id: sessionId, turn_id: `${sessionId}-turn`,
        }),
      }));
      expect(hookOutput).toMatchObject({ continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
      expect(hookOutput.hookSpecificOutput.additionalContext).toContain("先给结论，再列出验证结果");
    }

    const config = JSON.parse(readFileSync(join(root, "data/config.json"), "utf8"));
    for (const agentId of ["trae", "claude", "codex"]) {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [server, "--mcp"], stderr: "pipe",
        env: { ...env, OPEN_CONTINUITY_PROFILE: "lite", OPEN_CONTINUITY_STORE: "sqlite", OPEN_CONTINUITY_SQLITE_PATH: config.databasePath, OPEN_CONTINUITY_USER_ID: config.userId, OPEN_CONTINUITY_AGENT_ID: agentId, OPEN_CONTINUITY_ALLOW_PRIVATE: "false" },
      });
      const client = new Client({ name: `fictional-${agentId}-agent`, version: "1" });
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("memory_query");
        const recalled = JSON.parse(toolText(await client.callTool({ name: "memory_recall", arguments: { query: "先给结论", limit: 5 } })));
        expect(recalled.memories).toEqual(expect.arrayContaining([expect.objectContaining({ value: "先给结论，再列出验证结果" })]));
      } finally {
        await client.close();
      }
    }
  }, 30_000);
});
