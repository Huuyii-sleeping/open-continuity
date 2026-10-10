import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeClaudeTranscript } from "../src/capture/claude-transcript.js";
import { checkClaudeHooks, ClaudeInjectionAdapter, installClaudeHooks } from "../src/injection/claude-hook-config.js";

describe("Claude Code Adapter protocol", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("normalizes multi-turn JSONL, tools, compaction, and the Stop fallback", () => {
    const workspace = "/tmp/fictional-claude-workspace";
    const lines = [
      JSON.stringify({ type: "user", uuid: "user-one", sessionId: "session-fictional", cwd: workspace, version: "9.9.9-fictional", timestamp: "2030-01-01T00:00:00.000Z", message: { role: "user", content: "我偏好使用虚构的蓝色纸飞机。" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-one", sessionId: "session-fictional", cwd: workspace, version: "9.9.9-fictional", timestamp: "2030-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "正在检查虚构材料。" }, { type: "tool_use", id: "tool-fictional", name: "Read", input: { file_path: "fictional.txt" } }] } }),
      JSON.stringify({ type: "user", uuid: "tool-result-one", sessionId: "session-fictional", cwd: workspace, timestamp: "2030-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-fictional", content: "fictional contents" }] } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-two", sessionId: "session-fictional", cwd: workspace, timestamp: "2030-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "第一轮虚构检查完成。" }] } }),
      JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "compact-one", timestamp: "2030-01-01T00:00:04.000Z" }),
      JSON.stringify({ type: "user", uuid: "injected-context", isMeta: true, timestamp: "2030-01-01T00:00:05.000Z", message: { role: "user", content: "<open-continuity-memory-context>must not be captured</open-continuity-memory-context>" } }),
      JSON.stringify({ type: "user", uuid: "user-two", sessionId: "session-fictional", cwd: workspace, timestamp: "2030-01-01T00:00:06.000Z", message: { role: "user", content: [{ type: "text", text: "继续处理第二轮虚构任务。" }] } }),
      JSON.stringify({ type: "user", uuid: "blocked-user", sessionId: "session-fictional", cwd: "/tmp/blocked-fictional-workspace", timestamp: "2030-01-01T00:00:06.500Z", message: { role: "user", content: "我偏好这段越界内容绝不能进入 Inbox。" } }),
      "{partially-written-json",
    ];

    const thread = normalizeClaudeTranscript(lines, {
      session_id: "session-fictional",
      prompt_id: "prompt-two",
      transcript_path: "/tmp/fictional.jsonl",
      cwd: workspace,
      hook_event_name: "Stop",
      last_assistant_message: "第二轮虚构任务完成。",
    }, "2030-01-01T00:00:07.000Z", [workspace]);

    expect(thread).toMatchObject({ source: "claude", id: "session-fictional", cwd: workspace, cliVersion: "9.9.9-fictional" });
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0]).toMatchObject({ id: "user-one", status: "completed", quality: "complete" });
    expect(thread.turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "assistant_message", phase: "commentary", text: "正在检查虚构材料。" }),
      expect.objectContaining({ type: "tool_call", toolName: "Read", toolStatus: "requested" }),
      expect.objectContaining({ type: "tool_call", toolName: "Read", toolStatus: "completed", toolOutput: "fictional contents" }),
      expect.objectContaining({ type: "assistant_message", phase: "final_answer", text: "第一轮虚构检查完成。" }),
      expect.objectContaining({ type: "compaction" }),
    ]));
    expect(thread.turns[1]).toMatchObject({ id: "user-two", status: "completed", quality: "complete" });
    expect(thread.turns[1].items.at(-1)).toMatchObject({ type: "assistant_message", phase: "final_answer", text: "第二轮虚构任务完成。" });
    expect(JSON.stringify(thread)).not.toContain("must not be captured");
    expect(JSON.stringify(thread)).not.toContain("越界内容");
  });

  it("preserves user settings and installs both hooks idempotently with exec-form args", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-claude-hooks-")); directories.push(root);
    const home = join(root, "home");
    const settingsPath = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ theme: "fictional-dark", hooks: { Notification: [{ hooks: [{ type: "command", command: "fictional-notify" }] }] } }, null, 2));
    const env = { ...process.env, HOME: home, OPEN_CONTINUITY_HOME: join(root, "data") };
    const paths = { injectionHookPath: join(root, "claude-injection.js"), captureHookPath: join(root, "claude-capture.js") };

    const first = installClaudeHooks(env, process.execPath, paths);
    expect(first).toMatchObject({ valid: true, installed: true, injectionInstalled: true, captureInstalled: true, changed: true });
    expect(first.backupPath).toBeDefined();
    expect(readFileSync(first.backupPath!, "utf8")).toContain("fictional-dark");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.theme).toBe("fictional-dark");
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ type: "command", command: process.execPath, args: [paths.injectionHookPath] });
    expect(settings.hooks.Stop[0].hooks[0]).toMatchObject({ type: "command", command: process.execPath, args: [paths.captureHookPath] });

    expect(installClaudeHooks(env, process.execPath, paths)).toMatchObject({ changed: false, installed: true });
    expect(checkClaudeHooks(env, process.execPath, paths)).toMatchObject({ valid: true, installed: true });
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.hooks.UserPromptSubmit).toHaveLength(1);
    expect(after.hooks.Stop).toHaveLength(1);
  });

  it("does not duplicate a final response that is already present in the transcript", () => {
    const thread = normalizeClaudeTranscript([
      JSON.stringify({ type: "user", uuid: "fictional-user", timestamp: "2030-01-01T00:00:00.000Z", message: { role: "user", content: "虚构问题" } }),
      JSON.stringify({ type: "assistant", uuid: "fictional-assistant", timestamp: "2030-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "第一段。" }, { type: "text", text: "第二段。" }] } }),
    ], {
      session_id: "fictional-session",
      transcript_path: "/tmp/fictional.jsonl",
      cwd: "/tmp/fictional-workspace",
      last_assistant_message: "第一段。\n第二段。",
    }, "2030-01-01T00:00:02.000Z");

    const assistantItems = thread.turns[0].items.filter((item) => item.type === "assistant_message");
    expect(assistantItems).toHaveLength(2);
    expect(assistantItems.filter((item) => item.phase === "final_answer")).toHaveLength(1);
  });

  it("implements the Injection Adapter contract with a Claude identity", () => {
    const adapter = new ClaudeInjectionAdapter();
    expect(adapter.id).toBe("claude");
    expect(adapter.emptyOutput()).toEqual({ continue: true, suppressOutput: true });
    expect(adapter.renderContext("fictional approved memory")).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("fictional approved memory") },
    });
  });
});
