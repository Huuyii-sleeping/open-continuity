import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { installFakeCodexCli } from "./helpers/fake-codex.js";

function toolText(result: unknown): string {
  const content = result && typeof result === "object" && "content" in result ? (result as { content?: unknown }).content : undefined;
  const text = Array.isArray(content) ? content.find((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "text") : undefined;
  return text && typeof text === "object" && "text" in text ? String((text as { text: unknown }).text) : "{}";
}

describe("Codex Adapter process black box", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("runs setup, Stop Capture, review, UserPromptSubmit Injection, and MCP deep recall", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-codex-blackbox-")); directories.push(root);
    const bin = installFakeCodexCli(root);
    const home = join(root, "home"); const workspace = join(root, "fictional-workspace");
    mkdirSync(workspace, { recursive: true });
    const env = {
      ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), OPEN_CONTINUITY_HOME: join(root, "data"),
      FICTIONAL_CODEX_STATE: join(root, "fictional-codex-mcp-state"), FICTIONAL_CODEX_WORKSPACE: workspace,
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
    };
    const cli = join(process.cwd(), "dist/src/cli.js"); const server = join(process.cwd(), "dist/src/server.js");
    const captureHook = join(process.cwd(), "dist/src/codex-capture-hook.js"); const injectionHook = join(process.cwd(), "dist/src/codex-injection-hook.js");

    const setup = JSON.parse(execFileSync(process.execPath, [cli, "setup", "codex", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(setup).toMatchObject({
      ok: true, adapter: "codex", steps: { capture: { enabled: true }, injection: { enabled: true } }, doctor: { ok: true },
    });
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    expect(JSON.stringify(hooks.hooks.UserPromptSubmit)).toContain(injectionHook);
    expect(JSON.stringify(hooks.hooks.Stop)).toContain(captureHook);

    expect(execFileSync(process.execPath, [captureHook], {
      env, encoding: "utf8", input: JSON.stringify({ session_id: "fictional-codex-session", cwd: workspace, hook_event_name: "Stop", stop_hook_active: false }),
    })).toBe("");

    const status = JSON.parse(execFileSync(process.execPath, [cli, "capture", "status", "--source", "codex", "--json"], { env, encoding: "utf8" }));
    expect(status).toMatchObject({ source: "codex", checkpoints: { threads: 1 }, sync: { consecutive_failures: 0 } });
    const captured = JSON.parse(execFileSync(process.execPath, [cli, "capture", "thread", "fictional-codex-session", "--source", "codex", "--json"], { env, encoding: "utf8" }));
    expect(captured.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user_message", text: "请记住：使用虚构的蓝色纸飞机。" }),
      expect.objectContaining({ type: "assistant_message", phase: "final_answer", text: "收到，已进入待审核候选。" }),
      expect.objectContaining({ type: "tool_call", toolName: "shell" }),
    ]));
    expect(JSON.stringify(captured)).not.toContain("private reasoning must not be captured");

    const candidates = JSON.parse(execFileSync(process.execPath, [cli, "capture", "candidates", "--json"], { env, encoding: "utf8" }));
    expect(candidates.candidates).toHaveLength(1);
    expect(candidates.candidates[0]).toMatchObject({ source: "codex", status: "pending" });
    execFileSync(process.execPath, [cli, "capture", "approve", candidates.candidates[0].id, "--share", "--json"], { env, encoding: "utf8" });

    for (const sessionId of ["fictional-codex-injection-a", "fictional-codex-injection-b"]) {
      const output = JSON.parse(execFileSync(process.execPath, [injectionHook], {
        env, encoding: "utf8", input: JSON.stringify({ session_id: sessionId, turn_id: `${sessionId}-turn`, prompt: "请按照使用虚构的蓝色纸飞机的方式继续任务。", cwd: workspace, hook_event_name: "UserPromptSubmit" }),
      }));
      expect(output).toMatchObject({ continue: true, suppressOutput: true, hookSpecificOutput: { hookEventName: "UserPromptSubmit" } });
      expect(output.hookSpecificOutput.additionalContext).toContain("虚构的蓝色纸飞机");
    }
    const receipts = readFileSync(join(root, "data", "injection-receipts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.agentId === "codex" && receipt.outcome === "injected")).toBe(true);

    const config = JSON.parse(readFileSync(join(root, "data", "config.json"), "utf8"));
    const transport = new StdioClientTransport({
      command: process.execPath, args: [server, "--mcp"], stderr: "pipe",
      env: { ...env, OPEN_CONTINUITY_PROFILE: "lite", OPEN_CONTINUITY_STORE: "sqlite", OPEN_CONTINUITY_SQLITE_PATH: config.databasePath, OPEN_CONTINUITY_USER_ID: config.userId, OPEN_CONTINUITY_AGENT_ID: "codex", OPEN_CONTINUITY_ALLOW_PRIVATE: "false" },
    });
    const client = new Client({ name: "fictional-codex-agent", version: "1" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("memory_query");
      const recalled = JSON.parse(toolText(await client.callTool({ name: "memory_recall", arguments: { query: "蓝色纸飞机", limit: 5 } })));
      expect(recalled.memories).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.stringContaining("蓝色纸飞机") })]));
    } finally { await client.close(); }

    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "codex", "--workspace", workspace, "--json"], { env, encoding: "utf8" }));
    expect(doctor).toMatchObject({ ok: true, adapter: "codex" });
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Codex UserPromptSubmit hook", status: "pass" }),
      expect.objectContaining({ name: "Codex Stop Capture hook", status: "pass" }),
      expect.objectContaining({ name: "Codex Capture checkpoints", status: "pass" }),
    ]));
  }, 30_000);
});
