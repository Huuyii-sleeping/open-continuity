import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installFakeClaudeCli } from "./helpers/fake-claude.js";

function toolText(result: unknown): string {
  const content = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : undefined;
  const text = Array.isArray(content) ? content.find((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text") : undefined;
  return text && typeof text === "object" && "text" in text ? String((text as { text: unknown }).text) : "{}";
}

describe("Claude Code Adapter process black box", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("runs setup, Stop Capture, review, UserPromptSubmit Injection, and MCP deep recall", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-claude-blackbox-")); directories.push(root);
    const bin = installFakeClaudeCli(root);
    const home = join(root, "home");
    const workspace = join(root, "fictional-workspace");
    const transcript = join(root, "fictional-transcript.jsonl");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "fictional-existing-theme" }, null, 2) + "\n");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", uuid: "fictional-user-one", sessionId: "fictional-claude-session", cwd: workspace, version: "9.9.9-fictional", timestamp: "2030-02-01T00:00:00.000Z", message: { role: "user", content: "我偏好使用虚构的蓝色纸飞机。" } }),
      JSON.stringify({ type: "assistant", uuid: "fictional-assistant-commentary", sessionId: "fictional-claude-session", cwd: workspace, timestamp: "2030-02-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "正在处理虚构任务。" }, { type: "tool_use", id: "fictional-tool", name: "Read", input: { file_path: "fictional.txt" } }] } }),
      JSON.stringify({ type: "user", uuid: "fictional-tool-result", sessionId: "fictional-claude-session", cwd: workspace, timestamp: "2030-02-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "fictional-tool", content: "fictional tool output" }] } }),
    ].join("\n") + "\n");
    const env = {
      ...process.env,
      HOME: home,
      OPEN_CONTINUITY_HOME: join(root, "data"),
      TEST_STATE_DIR: join(root, "state"),
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js");
    const server = join(process.cwd(), "dist/src/server.js");
    const captureHook = join(process.cwd(), "dist/src/claude-capture-hook.js");
    const injectionHook = join(process.cwd(), "dist/src/claude-injection-hook.js");

    const setup = JSON.parse(execFileSync(process.execPath, [cli, "setup", "claude", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(setup).toMatchObject({
      ok: true,
      adapter: "claude",
      steps: { capture: { enabled: true, workspaces: [workspace] }, injection: { enabled: true } },
      doctor: { ok: true },
    });
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("fictional-existing-theme");
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain(injectionHook);
    expect(JSON.stringify(settings.hooks.Stop)).toContain(captureHook);

    const captureOutput = execFileSync(process.execPath, [captureHook], {
      env,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "fictional-claude-session",
        prompt_id: "fictional-prompt-one",
        transcript_path: transcript,
        cwd: workspace,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "收到，虚构偏好已进入待审核候选。",
      }),
    });
    expect(captureOutput).toBe("");

    // A disallowed workspace is rejected before the transcript path is read.
    expect(execFileSync(process.execPath, [captureHook], {
      env,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "fictional-blocked-session",
        transcript_path: join(root, "does-not-exist.jsonl"),
        cwd: join(root, "blocked-workspace"),
        hook_event_name: "Stop",
        last_assistant_message: "must not be persisted",
      }),
    })).toBe("");

    const status = JSON.parse(execFileSync(process.execPath, [cli, "capture", "status", "--source", "claude", "--json"], { env, encoding: "utf8" }));
    expect(status).toMatchObject({ source: "claude", checkpoints: { threads: 1 }, sync: { consecutive_failures: 0 } });
    const captured = JSON.parse(execFileSync(process.execPath, [cli, "capture", "thread", "fictional-claude-session", "--source", "claude", "--json"], { env, encoding: "utf8" }));
    expect(captured.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user_message", text: "我偏好使用虚构的蓝色纸飞机。" }),
      expect.objectContaining({ type: "assistant_message", phase: "final_answer", text: "收到，虚构偏好已进入待审核候选。" }),
    ]));
    expect(JSON.stringify(captured)).not.toContain("must not be persisted");

    const candidates = JSON.parse(execFileSync(process.execPath, [cli, "capture", "candidates", "--json"], { env, encoding: "utf8" }));
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]).toMatchObject({ source: "claude", status: "pending", value: "使用虚构的蓝色纸飞机" });
    execFileSync(process.execPath, [cli, "capture", "approve", candidates.candidates[0].id, "--share", "--json"], { env, encoding: "utf8" });

    for (const sessionId of ["fictional-injection-a", "fictional-injection-b", "fictional-injection-c"]) {
      const output = JSON.parse(execFileSync(process.execPath, [injectionHook], {
        env,
        encoding: "utf8",
        input: JSON.stringify({
          session_id: sessionId,
          prompt_id: `${sessionId}-prompt`,
          prompt: "请按照使用虚构的蓝色纸飞机的方式继续任务。",
          cwd: workspace,
          hook_event_name: "UserPromptSubmit",
        }),
      }));
      expect(output).toMatchObject({ continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
      expect(output.hookSpecificOutput.additionalContext).toContain("使用虚构的蓝色纸飞机");
    }
    const receipts = readFileSync(join(root, "data", "injection-receipts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.agentId === "claude" && receipt.outcome === "injected")).toBe(true);

    const config = JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server, "--mcp"],
      stderr: "pipe",
      env: {
        ...env,
        OPEN_CONTINUITY_PROFILE: "lite",
        OPEN_CONTINUITY_STORE: "sqlite",
        OPEN_CONTINUITY_SQLITE_PATH: config.databasePath,
        OPEN_CONTINUITY_USER_ID: config.userId,
        OPEN_CONTINUITY_AGENT_ID: "claude",
        OPEN_CONTINUITY_ALLOW_PRIVATE: "false",
      },
    });
    const client = new Client({ name: "fictional-claude-agent", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("memory_query");
      const recalled = JSON.parse(toolText(await client.callTool({ name: "memory_recall", arguments: { query: "蓝色纸飞机", limit: 5 } })));
      expect(recalled.memories).toEqual(expect.arrayContaining([expect.objectContaining({ value: "使用虚构的蓝色纸飞机" })]));
    } finally {
      await client.close();
    }

    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "claude", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(doctor).toMatchObject({ ok: true, adapter: "claude" });
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Claude UserPromptSubmit hook", status: "pass" }),
      expect.objectContaining({ name: "Claude Stop Capture hook", status: "pass" }),
      expect.objectContaining({ name: "Claude Capture checkpoints", status: "pass" }),
    ]));
  }, 30_000);
});
