import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerCaptureAdapter, normalizeCodexThread } from "../src/capture/codex-app-server.js";
import { checkCodexHooks, CodexInjectionAdapter, installCodexHooks } from "../src/injection/codex-hook-config.js";
import { installFakeCodexCli } from "./helpers/fake-codex.js";

describe("Codex Adapter protocol", () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it("normalizes app-server turns while omitting reasoning content", () => {
    const workspace = "/tmp/fictional-codex-workspace";
    const thread = normalizeCodexThread({
      id: "fictional-thread", sessionId: "fictional-session", cwd: workspace, cliVersion: "0.0.0-fictional",
      preview: "虚构 Codex 会话", createdAt: 1893456000, updatedAt: 1893456030, ephemeral: false,
    }, [{
      id: "fictional-turn", status: "completed", startedAt: 1893456000, completedAt: 1893456030,
      items: [
        { type: "userMessage", id: "user", content: [{ type: "text", text: "请记住虚构偏好。" }] },
        { type: "reasoning", id: "reasoning", summary: ["private reasoning must not leak"] },
        { type: "agentMessage", id: "assistant", text: "已收到。", phase: "final_answer" },
        { type: "commandExecution", id: "command", command: "printf fictional", cwd: workspace, aggregatedOutput: "fictional output", status: "completed" },
      ],
    }]);
    expect(thread).toMatchObject({ source: "codex", id: "fictional-thread", cliVersion: "0.0.0-fictional" });
    expect(thread.turns[0]).toMatchObject({ status: "completed", quality: "complete" });
    expect(thread.turns[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "user_message", text: "请记住虚构偏好。" }),
      expect.objectContaining({ type: "assistant_message", phase: "final_answer", text: "已收到。" }),
      expect.objectContaining({ type: "tool_call", toolName: "shell", toolOutput: "fictional output" }),
      expect.objectContaining({ type: "other", rawType: "reasoning" }),
    ]));
    expect(JSON.stringify(thread)).not.toContain("private reasoning must not leak");
  });

  it("speaks the real app-server stdio shape and accepts array turn pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-codex-protocol-")); directories.push(root);
    const bin = installFakeCodexCli(root);
    const workspace = join(root, "fictional-workspace"); mkdirSync(workspace, { recursive: true });
    const env = { ...process.env, FICTIONAL_CODEX_WORKSPACE: workspace, CODEX_HOME: join(root, "codex-home"), PATH: `${bin}${delimiter}${process.env.PATH || ""}` };
    const adapter = new CodexAppServerCaptureAdapter(join(bin, "codex"), env);
    await adapter.connect();
    const listed = await adapter.listThreads({ pageSize: 10, maxThreads: 10 });
    expect(listed).toMatchObject({ pages: 1, truncated: false, threads: [{ id: "fictional-codex-session", cwd: workspace, ephemeral: false }] });
    const thread = await adapter.readThread("fictional-codex-session");
    expect(thread).toMatchObject({ source: "codex", cwd: workspace, turns: [expect.objectContaining({ quality: "complete" })] });
    await adapter.close();
  });

  it("preserves user settings and installs Codex hooks idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-codex-hooks-")); directories.push(root);
    const home = join(root, "home"); const codexHome = join(home, ".codex"); mkdirSync(codexHome, { recursive: true });
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ description: "fictional hooks", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "fictional-session-hook" }] }] } }, null, 2));
    const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, OPEN_CONTINUITY_HOME: join(root, "data") };
    const paths = { injectionHookPath: join(root, "codex-injection.js"), captureHookPath: join(root, "codex-capture.js") };
    const first = installCodexHooks(env, process.execPath, paths);
    expect(first).toMatchObject({ valid: true, installed: true, injectionInstalled: true, captureInstalled: true, changed: true });
    expect(first.backupPath).toBeDefined();
    expect(readFileSync(first.backupPath!, "utf8")).toContain("fictional hooks");
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(hooks.description).toBe("fictional hooks");
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(JSON.stringify(hooks.hooks.UserPromptSubmit)).toContain(paths.injectionHookPath);
    expect(JSON.stringify(hooks.hooks.Stop)).toContain(paths.captureHookPath);
    expect(installCodexHooks(env, process.execPath, paths)).toMatchObject({ changed: false, installed: true });
    expect(checkCodexHooks(env, process.execPath, paths)).toMatchObject({ valid: true, installed: true });
  });

  it("implements the Injection Adapter contract with a Codex identity", () => {
    const adapter = new CodexInjectionAdapter();
    expect(adapter.id).toBe("codex");
    expect(adapter.emptyOutput()).toEqual({ continue: true, suppressOutput: true });
    expect(adapter.renderContext("fictional approved memory")).toMatchObject({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("fictional approved memory") },
    });
  });

  it("keeps the hook executable fail-open when the app-server is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "open-continuity-codex-hook-")); directories.push(root);
    const cli = join(process.cwd(), "dist/src/cli.js");
    execFileSync(process.execPath, [cli, "init", "--json"], { env: { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") }, encoding: "utf8" });
    const hook = join(process.cwd(), "dist/src/codex-injection-hook.js");
    const output = JSON.parse(execFileSync(process.execPath, [hook], { env: { ...process.env, HOME: join(root, "home"), OPEN_CONTINUITY_HOME: join(root, "data") }, input: JSON.stringify({ prompt: "fictional", cwd: root }), encoding: "utf8" }));
    expect(output).toEqual({ continue: true, suppressOutput: true });
  });
});
